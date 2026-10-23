//! `jeeta serve`: the HTTP server. The panel's API and files, `/healthz` and the MCP endpoint
//! at `/mcp`, on one listener.
//!
//! Start order: connect to the database, refuse a role that row-level security does not bind
//! ([`check_database_role`]), apply pending migrations, create the first platform operator when
//! configured, build the shared ports once, then serve until SIGINT or SIGTERM and drain open
//! connections for at most [`DRAIN_TIMEOUT`].

use std::future::IntoFuture;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::extract::{MatchedPath, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use jt_app::error::ErrorCode;
use jt_app::gate::{NoStrategyYet, StrategyGate};
use jt_app::std_impls::{Argon2Hasher, RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::{Deps, platform};
use jt_mcp::{LOOPBACK_HOSTS, McpState};
use jt_outbound::{Egress, FIXED_HOSTS};
use jt_panel_http::AppState;
use jt_pg::PgUnitOfWork;
use sqlx::PgPool;
use sqlx::migrate::Migrate;
use sqlx::postgres::PgConnectOptions;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::{self, Bootstrap, Config};

/// How long open connections may take to finish after a shutdown signal.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// The operator console's login route, which the access log does not name.
const PLATFORM_LOGIN: &str = "/api/platform/login";

/// Runs the server until a shutdown signal; any error before it listens stops the start.
pub async fn run(config: Config) -> Result<()> {
    let pool = connect(&config).await?;
    check_database_role(&pool, config.allow_superuser).await?;
    let (applied, total) = migrate(&pool).await?;
    tracing::info!(applied, total, "migrations are up to date");

    let deps = deps(pool.clone());
    if let Some(bootstrap) = &config.bootstrap {
        bootstrap_operator(&deps, bootstrap).await?;
    }
    // The one egress client, built at start so a bad fixed-tier entry stops it; M1's connectors
    // take it from here.
    let egress = Egress::new(FIXED_HOSTS);

    let app = app(deps, &config);
    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("cannot listen on {} ({})", config.bind, config::BIND))?;
    tracing::info!(
        bind = %config.bind,
        panel = %panel_status(config.panel_dir.as_deref()),
        allowed_hosts = config.allowed_hosts.len(),
        migrations_applied = applied,
        "jeeta is listening"
    );

    serve(listener, app).await?;
    drop(egress);
    pool.close().await;
    tracing::info!("stopped");
    Ok(())
}

/// A pool on [`config::DATABASE_URL`]; the error never shows the URL.
///
/// The connections ask Postgres for warnings and errors only: its notices (such as
/// `relation "_sqlx_migrations" already exists, skipping` at every start) are noise in the
/// application's log.
pub(crate) async fn connect(config: &Config) -> Result<PgPool> {
    let context = || format!("cannot connect to the database in {}", config::DATABASE_URL);
    let options = PgConnectOptions::from_str(&config.database_url)
        .with_context(context)?
        .options([("client_min_messages", "warning")]);
    jt_pg::connect_with(options).await.with_context(context)
}

/// Refuses to go on when the database role is a superuser or has `BYPASSRLS`: Postgres applies no
/// row-level security to it, so workspaces would not be isolated. With `allow` (the
/// [`config::ALLOW_SUPERUSER`] override, for local development only) it goes on and warns.
pub(crate) async fn check_database_role(pool: &PgPool, allow: bool) -> Result<()> {
    let context = || "cannot read the database role's attributes";
    if !jt_pg::role_bypasses_rls(pool).await.with_context(context)? {
        return Ok(());
    }
    let role = jt_pg::current_role(pool).await.with_context(context)?;
    if allow {
        tracing::warn!(
            role,
            "{}=true: the database role is a superuser or has BYPASSRLS, so tenant isolation is \
             not enforced; for local development only",
            config::ALLOW_SUPERUSER
        );
        return Ok(());
    }
    bail!(
        "the database role `{role}` in {} is a superuser or has BYPASSRLS, so row-level security \
         would not isolate workspaces; connect as an ordinary role (NOSUPERUSER NOBYPASSRLS, see \
         rust/README.md), or set {}=true for local development only",
        config::DATABASE_URL,
        config::ALLOW_SUPERUSER
    )
}

/// Applies every pending migration; returns how many it applied and how many are applied now.
async fn migrate(pool: &PgPool) -> Result<(usize, usize)> {
    let before = applied_migrations(pool).await?;
    jt_pg::migrate_up(pool)
        .await
        .context("cannot apply the database migrations")?;
    let after = applied_migrations(pool).await?;
    Ok((after.saturating_sub(before), after))
}

async fn applied_migrations(pool: &PgPool) -> Result<usize> {
    let mut conn = pool
        .acquire()
        .await
        .context("cannot read the applied migrations")?;
    conn.ensure_migrations_table()
        .await
        .context("cannot create the migrations table")?;
    let applied = conn
        .list_applied_migrations()
        .await
        .context("cannot read the applied migrations")?;
    Ok(applied.len())
}

/// The production ports over `pool`. One [`Argon2Hasher`] for the whole process: its
/// concurrency permits are per instance, and every clone of the returned `Deps` shares it.
pub(crate) fn deps(pool: PgPool) -> Deps {
    Deps {
        uow: Arc::new(PgUnitOfWork::new(pool)),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(Argon2Hasher::default()),
    }
}

/// Creates the first platform operator unless one exists; a refused email or password names its
/// variable (the password itself is never shown).
async fn bootstrap_operator(deps: &Deps, bootstrap: &Bootstrap) -> Result<()> {
    match platform::bootstrap(deps, &bootstrap.email, &bootstrap.password).await {
        Ok(true) => tracing::info!("platform operator created"),
        Ok(false) => tracing::info!("platform operator already present"),
        Err(e) if e.code == ErrorCode::Validation => {
            let var = match e.details.get("field").and_then(|f| f.as_str()) {
                Some("password") => config::BOOTSTRAP_PASSWORD,
                _ => config::BOOTSTRAP_EMAIL,
            };
            bail!("{var}: {}", e.message);
        }
        Err(e) => return Err(e).context("cannot create the platform operator"),
    }
    Ok(())
}

/// The server's single router: the panel's (API, `/healthz`, files) merged with the MCP
/// endpoint's, with the security headers on every response and a one-line access log.
pub(crate) fn app(deps: Deps, config: &Config) -> Router {
    let gate: Arc<dyn StrategyGate> = Arc::new(NoStrategyYet);
    let panel = AppState {
        deps: deps.clone(),
        gate: Arc::clone(&gate),
        cookie_secure: config.cookie_secure,
        panel_dir: config.panel_dir.clone(),
    };
    let mcp = McpState::new(deps, gate).with_allowed_hosts(mcp_hosts(&config.allowed_hosts));
    jt_panel_http::router(panel)
        .merge(jt_mcp::http_service(mcp))
        // The panel's router sets them on its own responses already (idempotently); this
        // covers the MCP endpoint too.
        .layer(middleware::from_fn(jt_panel_http::security_headers))
        .layer(middleware::from_fn(access_log))
}

/// The `Host` values the MCP endpoint accepts: the loopback names, plus the configured public
/// ones.
fn mcp_hosts(public: &[String]) -> Vec<String> {
    LOOPBACK_HOSTS
        .iter()
        .map(|host| (*host).to_owned())
        .chain(public.iter().cloned())
        .collect()
}

/// One line per request: method, route template, status and duration. Never the raw path or
/// query, so no token in a URL reaches the log.
async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let route = loggable_route(
        req.extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    )
    .to_owned();
    let started = Instant::now();
    let resp = next.run(req).await;
    tracing::info!(
        target: "jeeta::access",
        %method,
        route,
        status = resp.status().as_u16(),
        ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "request"
    );
    resp
}

/// What the access log shows as a request's route: its template (`/api/team/{membership_id}`),
/// never the path; `-` when no route matched (panel pages and files, `/invite/<token>` among
/// them); `<redacted>` for the operator console's login.
fn loggable_route(template: Option<&str>) -> &str {
    match template {
        None => "-",
        Some(PLATFORM_LOGIN) => "<redacted>",
        Some(template) => template,
    }
}

/// How the panel directory looks, for the start log.
fn panel_status(dir: Option<&Path>) -> String {
    match dir {
        None => format!("not served ({} unset)", config::PANEL_DIR),
        Some(dir) if dir.join("index.html").is_file() => format!("served from {}", dir.display()),
        Some(dir) => format!(
            "missing: {} has no index.html (build it with `make panel-build`)",
            dir.display()
        ),
    }
}

/// Serves until SIGINT or SIGTERM, then stops accepting and lets open connections finish for
/// at most [`DRAIN_TIMEOUT`].
async fn serve(listener: TcpListener, app: Router) -> Result<()> {
    let mut signals = Signals::install()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            // A dropped sender stops the server too.
            let _ = stopped.await;
        })
        .into_future();
    let mut server = tokio::spawn(server);

    tokio::select! {
        ended = &mut server => {
            ended.context("the server task failed")?.context("the server stopped")?;
            return Ok(());
        }
        signal = signals.next() => {
            tracing::info!(
                signal,
                drain_secs = DRAIN_TIMEOUT.as_secs(),
                "shutting down: no new connections, draining open ones"
            );
        }
    }
    let _ = stop.send(());
    match tokio::time::timeout(DRAIN_TIMEOUT, &mut server).await {
        Ok(ended) => ended
            .context("the server task failed")?
            .context("the server stopped")?,
        Err(_) => {
            tracing::warn!("connections still open after the drain timeout; closing them");
            server.abort();
        }
    }
    Ok(())
}

/// SIGINT and SIGTERM, installed before serving so a failure stops the start.
#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    fn install() -> Result<Signals> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Signals {
            interrupt: signal(SignalKind::interrupt()).context("cannot listen for SIGINT")?,
            terminate: signal(SignalKind::terminate()).context("cannot listen for SIGTERM")?,
        })
    }

    /// The name of the next signal received.
    async fn next(&mut self) -> &'static str {
        tokio::select! {
            _ = self.interrupt.recv() => "SIGINT",
            _ = self.terminate.recv() => "SIGTERM",
        }
    }
}

/// Ctrl-C where there are no Unix signals.
#[cfg(not(unix))]
struct Signals;

#[cfg(not(unix))]
impl Signals {
    fn install() -> Result<Signals> {
        Ok(Signals)
    }

    async fn next(&mut self) -> &'static str {
        match tokio::signal::ctrl_c().await {
            Ok(()) => "ctrl-c",
            Err(_) => std::future::pending().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode, header};
    use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
    use jt_testkit::fakes::{InMemoryUow, PlainHasher};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::config;

    fn test_deps() -> Deps {
        Deps {
            uow: Arc::new(InMemoryUow::new()),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7Gen),
            tokens: Arc::new(RandTokenGen),
            hasher: Arc::new(PlainHasher),
        }
    }

    fn test_config(extra: &[(&str, &str)]) -> Config {
        let mut vars: HashMap<String, String> = [
            (config::DATABASE_URL, "postgres://localhost/unused"),
            (config::SECRET_KEY, &"ab".repeat(32)[..]),
            (config::COOKIE_SECURE, "false"),
        ]
        .iter()
        .chain(extra)
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        vars.retain(|_, v| !v.is_empty());
        Config::from_map(&vars).unwrap()
    }

    /// Sends `req` and returns the status, the `Set-Cookie` header and the body as JSON (`Null`
    /// when it is not JSON).
    async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Option<String>, Value) {
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().to_owned());
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, cookie, body)
    }

    fn panel_post(uri: &str, cookie: Option<&str>, body: Value) -> Request<Body> {
        let mut req = Request::post(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-requested-with", "jeeta-panel");
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        req.body(Body::from(body.to_string())).unwrap()
    }

    fn mcp_initialize(host: &str, bearer: &str) -> Request<Body> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "wiring-test", "version": "0" }
            }
        });
        Request::post("/mcp")
            .header(header::HOST, host)
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    /// Registers an owner through the panel API, has the platform operator activate the new
    /// workspace, and issues an API key with the owner's session.
    async fn api_key(app: &Router, deps: &Deps) -> String {
        let (status, cookie, me) = call(
            app,
            panel_post(
                "/api/auth/register",
                None,
                json!({
                    "email": "owner@example.test",
                    "password": "correct horse battery",
                    "display_name": "Owner",
                    "workspace_name": "Acme"
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let ws = me["current_workspace"].as_str().unwrap().parse().unwrap();
        jt_testkit::flows::activate_workspace(deps, ws).await;
        let cookie = cookie.unwrap();
        let session = cookie.split(';').next().unwrap();
        let (status, _, key) = call(
            app,
            panel_post("/api/api-keys", Some(session), json!({ "name": "agent" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{key}");
        key["plaintext"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn one_router_serves_health_the_api_and_mcp_with_structured_errors() {
        let app = app(test_deps(), &test_config(&[]));

        let health = Request::get("/healthz").body(Body::empty()).unwrap();
        assert_eq!(
            call(&app, health).await,
            (StatusCode::OK, None, json!({ "ok": true }))
        );

        let (status, _, body) = call(&app, mcp_initialize("localhost:8080", "bad")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "UNAUTHENTICATED");

        // Every response of the one router carries the security headers once: the MCP
        // endpoint's as well as the panel's.
        for req in [
            mcp_initialize("localhost:8080", "bad"),
            Request::get("/healthz").body(Body::empty()).unwrap(),
            Request::get("/api/auth/me").body(Body::empty()).unwrap(),
        ] {
            let resp = app.clone().oneshot(req).await.unwrap();
            for (name, value) in jt_panel_http::headers::SECURITY_HEADERS {
                let all: Vec<_> = resp.headers().get_all(*name).iter().collect();
                assert_eq!(all, [*value], "{name}");
            }
        }

        // No panel directory: pages, unknown API paths and paths under `/mcp` are structured 404s.
        for path in ["/", "/team", "/api/nope", "/mcp/x"] {
            let req = Request::get(path).body(Body::empty()).unwrap();
            let (status, _, body) = call(&app, req).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
            assert_eq!(body["code"], "NOT_FOUND", "{path}");
        }
    }

    #[tokio::test]
    async fn mcp_accepts_loopback_hosts_and_the_configured_public_ones() {
        let deps = test_deps();
        let loopback_only = app(deps.clone(), &test_config(&[]));
        let key = api_key(&loopback_only, &deps).await;
        for (host, expected) in [
            ("localhost:8080", StatusCode::OK),
            ("127.0.0.1:8080", StatusCode::OK),
            ("jeeta.example.com", StatusCode::FORBIDDEN),
        ] {
            let (status, _, _) = call(&loopback_only, mcp_initialize(host, &key)).await;
            assert_eq!(status, expected, "{host}");
        }

        let deps = test_deps();
        let public = app(
            deps.clone(),
            &test_config(&[(config::ALLOWED_HOSTS, "jeeta.example.com")]),
        );
        let key = api_key(&public, &deps).await;
        for (host, expected) in [
            ("jeeta.example.com", StatusCode::OK),
            ("jeeta.example.com:443", StatusCode::OK),
            ("localhost:8080", StatusCode::OK),
            ("evil.example.com", StatusCode::FORBIDDEN),
        ] {
            let (status, _, _) = call(&public, mcp_initialize(host, &key)).await;
            assert_eq!(status, expected, "{host}");
        }
    }

    #[tokio::test]
    async fn boot_refuses_a_role_that_bypasses_rls_unless_allowed() {
        // A test database's own role is an ordinary one.
        let db = jt_testkit::TestDb::new().await;
        check_database_role(&db.pool, false).await.unwrap();

        // The administrator connection the tests use is a superuser.
        let url = std::env::var(jt_testkit::db::TEST_DATABASE_URL_VAR).unwrap();
        let admin = jt_pg::connect(&url).await.unwrap();
        let role = jt_pg::current_role(&admin).await.unwrap();
        let refused = check_database_role(&admin, false).await.unwrap_err();
        let message = format!("{refused:#}");
        assert!(message.contains(&format!("`{role}`")), "{message}");
        assert!(message.contains(config::ALLOW_SUPERUSER), "{message}");
        assert!(!message.contains(&url), "the URL never shows: {message}");
        // The development override lets it start.
        check_database_role(&admin, true).await.unwrap();
        admin.close().await;
    }

    #[test]
    fn the_access_log_shows_route_templates_only() {
        assert_eq!(
            loggable_route(Some("/api/team/{membership_id}")),
            "/api/team/{membership_id}"
        );
        assert_eq!(loggable_route(Some("/mcp")), "/mcp");
        // Pages and files (including `/invite/<token>`) match no route: no path at all.
        assert_eq!(loggable_route(None), "-");
        assert_eq!(loggable_route(Some("/api/platform/login")), "<redacted>");
    }
}
