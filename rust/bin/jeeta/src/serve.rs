//! `jeeta serve`: the HTTP server. The panel's API and files, `/healthz`, the MCP endpoint at
//! `/mcp` and the providers' webhooks at `/hooks/*`, on one listener.
//!
//! Start order: the configuration (provider apps included) was read and checked before this runs
//! (a half-configured provider app never starts); refuse a binary built with `jt_outbound`'s
//! test-only loopback paths ([`check_test_loopback`]), connect to the database, refuse a role that
//! row-level security does not bind ([`check_database_role`]), apply pending migrations, build the
//! shared ports once and refill the egress tenant tier from the capability records ([`boot`]),
//! log which provider apps are configured and the public address ([`log_providers`]), create the
//! first platform operator when configured, listen for SIGINT and SIGTERM ([`Signals`]), bind the
//! listener and log `jeeta is listening`, start the scheduled jobs ([`crate::scheduler`], unless
//! `JEETA_JOBS_ENABLED=false`), then serve until one of the signals. A signal before the handlers
//! are in place ends the start at once (the signal's default action), with nothing served yet;
//! one from the `listening` line on shuts the server down: no new job run starts, open
//! connections drain for at most [`DRAIN_TIMEOUT`], then the job runs still going get up to
//! [`scheduler::SHUTDOWN_GRACE`] to finish before they are aborted.

use std::future::IntoFuture;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::middleware;
use jt_app::error::ErrorCode;
use jt_app::gate::StrategyGate;
use jt_app::ports::connectors::PlatformAppConfig;
use jt_app::std_impls::{Argon2Hasher, RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::capabilities::UowChannelCatalog;
use jt_app::usecases::jobs::Job;
use jt_app::usecases::strategy::NoopArchivedHook;
use jt_app::usecases::{Deps, platform};
use jt_mcp::{LOOPBACK_HOSTS, McpState};
use jt_outbound::{Egress, EgressTenantHosts, FIXED_HOSTS, rebuild_tenant_hosts};
use jt_panel_http::AppState;
use jt_pg::{PgJobLock, PgStrategyGate, PgUnitOfWork};
use jt_seal::AesSecretBox;
use jt_webhook::WebhookState;
use sqlx::PgPool;
use sqlx::migrate::Migrate;
use sqlx::postgres::PgConnectOptions;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::{self, Bootstrap, Config};
use crate::{connectors, scheduler};

/// How long open connections may take to finish after a shutdown signal.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// The most job locks held at once (one per scheduled job), each on a connection of the job-lock
/// pool, which is apart from the server's own (`PgJobLock::with_own_pool`).
const JOB_LOCK_CONNECTIONS: u32 = Job::ALL.len() as u32;

/// The operator console's login route, which the access log does not name.
#[cfg(test)]
use crate::ops::loggable_route;

/// Runs the server until a shutdown signal; any error before it listens stops the start.
pub async fn run(config: Config) -> Result<()> {
    config.require_metrics_token()?;
    check_test_loopback(
        jt_outbound::TEST_LOOPBACK_ENABLED,
        config.allow_test_loopback,
    )?;
    let pool = connect(&config).await?;
    check_database_role(&pool, config.allow_superuser).await?;
    let (applied, total) = migrate(&pool).await?;
    tracing::info!(applied, total, "migrations are up to date");

    let (deps, _egress, runtime_ops) = boot(pool.clone(), &config).await?;
    log_providers(&config);
    if let Some(bootstrap) = &config.bootstrap {
        if config.bootstrap_reset {
            platform::bootstrap_reset(&deps, &bootstrap.email, &bootstrap.password)
                .await
                .context("cannot reset the sole platform operator")?;
        } else {
            bootstrap_operator(&deps, bootstrap).await?;
        }
    }
    let gate = strategy_gate(pool.clone());

    let app = app_with_probes(deps.clone(), gate, &config, Some(runtime_ops.clone()));
    // Before the listener is announced: whoever stops the process once it is listening (a
    // supervisor, a deploy) gets the drain, never the default action that kills it outright.
    let signals = Signals::install()?;
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

    let wal_probe = runtime_ops.start_wal_probe(config.wal_archive_dir.clone());
    let jobs = scheduler::start(&config, Arc::new(deps));
    let served = serve(listener, app, signals, jobs.stopper()).await;
    if let Some(probe) = wal_probe {
        probe.abort();
        let _ = probe.await;
    }
    jobs.shutdown(scheduler::SHUTDOWN_GRACE).await;
    served?;
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

/// Refuses to start when `enabled` (`jt_outbound::TEST_LOOPBACK_ENABLED`): that build of the
/// egress client lets requests reach this machine over plain http and resolves `localhost`,
/// which only tests may do. A whole-workspace test or `--all-targets` build turns the feature on
/// once a crate enables it in its `[dev-dependencies]`, so a binary must come from
/// `cargo build --release -p jeeta`. With `allow` (the [`config::ALLOW_TEST_LOOPBACK`] override,
/// for local testing only) it goes on and warns.
pub(crate) fn check_test_loopback(enabled: bool, allow: bool) -> Result<()> {
    if !enabled {
        return Ok(());
    }
    if allow {
        tracing::warn!(
            "{}=1: this binary was built with jt_outbound's `test-loopback` feature, so outbound \
             requests may reach this machine over plain http; for local testing only",
            config::ALLOW_TEST_LOOPBACK
        );
        return Ok(());
    }
    bail!(
        "this binary was built with jt_outbound's `test-loopback` feature (a whole-workspace test \
         or --all-targets build turns it on), which lets outbound requests reach this machine \
         over plain http; build the binary with `cargo build --release -p jeeta`, or set {}=1 \
         for local testing only",
        config::ALLOW_TEST_LOOPBACK
    )
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
    jt_pg::recovery::check_schema(pool, false)
        .await
        .map_err(|_| anyhow::anyhow!("schema refused"))?;
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
    // Only sqlx's migrator creates this table, under its advisory lock. Even
    // CREATE TABLE IF NOT EXISTS races on PostgreSQL catalog uniqueness when
    // two fresh processes create it before acquiring that lock.
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut *conn)
            .await
            .context("cannot inspect the migrations table")?;
    if !exists {
        return Ok(0);
    }
    let applied = conn
        .list_applied_migrations()
        .await
        .context("cannot read the applied migrations")?;
    Ok(applied.len())
}

/// The production ports over `pool` ([`ports`]), ready to serve: the egress client's tenant
/// tier, which lives in memory and so starts empty, refilled from the capability records
/// (`jt_outbound::rebuild_tenant_hosts`: the hosts of live connector capabilities only, so a
/// retired capability's hosts stay out; it logs what it rebuilt). Every command runs it before it
/// serves anything, so no request or job reaches out before the tier is whole. Returns the ports
/// and the egress client they share.
pub(crate) async fn boot(
    pool: PgPool,
    config: &Config,
) -> Result<(Deps, Arc<Egress>, Arc<crate::ops::RuntimeOps>)> {
    let (mut deps, egress) = ports(pool.clone(), config);
    let dir = config
        .files_dir
        .as_deref()
        .context("JEETA_FILES_DIR is required")?;
    let base = config
        .apps
        .public_base_url()
        .context("JEETA_PUBLIC_BASE_URL is required for file transport")?;
    let files=Arc::new(jt_files::DiskFiles::new(dir,base,*config.secret_key.bytes(),deps.clock.clone()).map_err(|_|anyhow::anyhow!("JEETA_FILES_DIR must be an existing absolute private directory and JEETA_PUBLIC_BASE_URL a public HTTPS origin"))?);
    deps.files = files.clone();
    deps.file_maintenance = files;
    deps.media_fetch = Arc::new(jt_files::CheckedMediaFetcher(egress.clone()));
    let ops = Arc::new(crate::ops::RuntimeOps {
        pool,
        uow: deps.uow.clone(),
        signals: deps.ops_signals.clone(),
        files: deps.files.clone(),
        files_dir: config.files_dir.clone(),
        recovery_dir: config.recovery_status_dir.clone(),
        wal_probe_state: std::sync::atomic::AtomicU8::new(0),
        started_at: crate::ops::process_started_at(),
        boot_complete: std::sync::atomic::AtomicBool::new(false),
    });
    deps.ops = ops.clone();
    rebuild_tenant_hosts(&egress, deps.uow.as_ref())
        .await
        .context("cannot rebuild the egress tenant tier from the capability records")?;
    ops.booted();
    Ok((deps, egress, ops))
}

/// The production ports over `pool`, sealing secrets under the configured secret key. One
/// [`Argon2Hasher`] for the whole process: its concurrency permits are per instance, and every
/// clone of the returned `Deps` shares it. Likewise one egress client, built here so that a bad
/// fixed-tier entry stops the start: its tenant tier is the use cases' `TenantHostRegistry`, and
/// the provider adapters ([`connectors::registry`]: Meta, NetGSM and X) send through this same
/// client, so that what the registry allows is what they reach; the tier lives in memory, so it
/// starts empty at every start.
///
/// The channel kinds a strategy may name are read from the capability registry, through the same
/// unit of work: a workspace has a channel kind while it has a capability of that kind that is
/// not retired.
///
/// The scheduled jobs' locks are Postgres advisory locks on a small pool of their own
/// ([`PgJobLock::with_own_pool`], [`JOB_LOCK_CONNECTIONS`] connections opened only when a lock is
/// asked for), so a job holding its lock never takes a connection the server needs.
///
/// The platform's provider apps and public address are the configuration's
/// ([`config::EnvPlatformApps`], read from the environment): the use cases and the three
/// adapters read the same apps. A kind whose app is not configured answers `CONFLICT` "provider
/// app not configured" to an OAuth flow, and without a public address no flow starts and no
/// webhook URL is shown (`CONFLICT` "public base url not configured"); NetGSM credentials entered
/// by hand need no app.
///
/// The tenant tier starts empty: [`boot`] refills it.
pub(crate) fn ports(pool: PgPool, config: &Config) -> (Deps, Arc<Egress>) {
    let egress = Arc::new(Egress::new(FIXED_HOSTS));
    let apps: Arc<dyn PlatformAppConfig> = Arc::new(config.apps.clone());
    let job_lock = Arc::new(PgJobLock::with_own_pool(&pool, JOB_LOCK_CONNECTIONS));
    let uow = Arc::new(PgUnitOfWork::new(pool));
    let deps = Deps {
        ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
        ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
        device_uploads: std::sync::Arc::new(
            jt_app::usecases::devices::uploads::UploadTurns::default(),
        ),
        bridge_signals: std::sync::Arc::new(jt_app::std_impls::LocalBridgeSignals::default()),
        billing: config.billing.clone(),
        uow: uow.clone(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(Argon2Hasher::default()),
        seal: Arc::new(AesSecretBox::new(*config.secret_key.bytes())),
        channels: Arc::new(UowChannelCatalog::new(uow)),
        // Studio cancellation shares the strategy transition transaction; file storage follows in T5.
        file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
        media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
        files: Arc::new(jt_app::ports::files::UnavailableFileStore),
        transition_hook: Arc::new(jt_app::usecases::studio::lifecycle::StudioTransition),
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(EgressTenantHosts::new(Arc::clone(&egress))),
        connectors: connectors::registry(Arc::clone(&egress), Arc::clone(&apps)),
        job_lock,
        apps,
    };
    (deps, egress)
}

/// One start-log line: which provider apps are configured (their names only, never an id or a
/// secret) and the public address, or that none is.
pub(crate) fn log_providers(config: &Config) {
    let configured = config.apps.configured();
    let providers = if configured.is_empty() {
        "none".to_owned()
    } else {
        configured.join(",")
    };
    let public_base_url = config.apps.public_base_url().map_or_else(
        || format!("unset ({})", config::PUBLIC_BASE_URL),
        |url| url.to_string(),
    );
    tracing::info!(
        providers,
        public_base_url,
        "provider apps: OAuth needs a configured app; webhook and redirect addresses need the \
         public base URL"
    );
}

/// The strategy gate over `pool`: open for a workspace while it has a committed approved strategy
/// version. The panel and the MCP endpoint share it.
pub(crate) fn strategy_gate(pool: PgPool) -> Arc<dyn StrategyGate> {
    Arc::new(PgStrategyGate::new(pool))
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
/// endpoint's, both behind the one strategy `gate`, and the webhook gate's (`/hooks/*`, which
/// providers call: outside the panel's session and request-header checks, which live inside the
/// panel's own router), with the security headers on every response and a one-line access log.
#[cfg(test)]
pub(crate) fn app(deps: Deps, gate: Arc<dyn StrategyGate>, config: &Config) -> Router {
    app_with_probes(deps, gate, config, None)
}
fn app_with_probes(
    deps: Deps,
    gate: Arc<dyn StrategyGate>,
    config: &Config,
    readiness: Option<Arc<crate::ops::RuntimeOps>>,
) -> Router {
    let panel = AppState {
        deps: deps.clone(),
        gate: Arc::clone(&gate),
        cookie_secure: config.cookie_secure,
        panel_dir: config.panel_dir.clone(),
    };
    let hooks = WebhookState {
        deps: Arc::new(deps.clone()),
    };
    let files = jt_files::router(
        deps.files.clone(),
        deps.clock.clone(),
        *config.secret_key.bytes(),
    );
    let process = crate::ops::router(
        deps.ops.clone(),
        deps.ops_signals.clone(),
        config.metrics_token.as_deref().unwrap_or(""),
        readiness,
    );
    let signals = deps.ops_signals.clone();
    let mcp = McpState::new(deps, gate).with_allowed_hosts(mcp_hosts(&config.allowed_hosts));
    jt_panel_http::router(panel)
        .merge(jt_mcp::http_service(mcp))
        .merge(jt_webhook::router(hooks))
        .merge(files)
        .merge(process)
        // The panel's router sets them on its own responses already (idempotently); this
        // covers the MCP endpoint and the webhook gate too.
        .layer(middleware::from_fn(jt_panel_http::security_headers))
        .layer(middleware::from_fn_with_state(
            signals,
            crate::ops::access_log,
        ))
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

/// Serves until SIGINT or SIGTERM (one received since `signals` were installed counts), then
/// calls `on_signal` (which stops the scheduled jobs from starting new runs), stops accepting and
/// lets open connections finish for at most [`DRAIN_TIMEOUT`].
async fn serve(
    listener: TcpListener,
    app: Router,
    mut signals: Signals,
    on_signal: impl FnOnce() + Send + 'static,
) -> Result<()> {
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
    on_signal();
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

/// SIGINT and SIGTERM, installed before the listener is announced: a signal from then on is
/// caught (and kept until [`serve`] waits for it) instead of ending the process, and a failure to
/// install stops the start.
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
    use jt_app::gate::NoStrategyYet;
    use jt_app::ports::connectors::Url;
    use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
    use jt_app::usecases::strategy::NoChannelsYet;
    use jt_testkit::fakes::{
        FakeAppConfig, FakeJobLock, InMemoryUow, PlainHasher, PlainSecretBox, RecordingTenantHosts,
        ScriptedRegistry,
    };
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
            seal: Arc::new(PlainSecretBox),
            channels: Arc::new(NoChannelsYet),
            file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
            media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
            files: Arc::new(jt_app::ports::files::UnavailableFileStore),
            transition_hook: Arc::new(jt_app::usecases::studio::lifecycle::StudioTransition),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
            apps: Arc::new(FakeAppConfig::default()),
            connectors: Arc::new(ScriptedRegistry::new()),
            ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
            ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
            device_uploads: std::sync::Arc::new(
                jt_app::usecases::devices::uploads::UploadTurns::default(),
            ),
            bridge_signals: std::sync::Arc::new(jt_app::std_impls::LocalBridgeSignals::default()),
            billing: jt_app::usecases::billing::BillingConfig {
                price_minor: 123,
                price_currency: "TRY".into(),
                bank_instructions: "Synthetic bank instructions".into(),
            },
            job_lock: Arc::new(FakeJobLock::new()),
        }
    }

    fn test_config(extra: &[(&str, &str)]) -> Config {
        let mut vars: HashMap<String, String> = [
            (config::DATABASE_URL, "postgres://localhost/unused"),
            (config::METRICS_TOKEN, "synthetic-metrics-token"),
            (config::SECRET_KEY, &"ab".repeat(32)[..]),
            (config::COOKIE_SECURE, "false"),
        ]
        .iter()
        .chain(extra)
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        vars.retain(|_, v| !v.is_empty());
        vars.insert("JEETA_PRICE_MINOR".into(), "123".into());
        vars.insert("JEETA_PRICE_CURRENCY".into(), "TRY".into());
        vars.insert(
            "JEETA_BANK_INSTRUCTIONS".into(),
            "Synthetic bank instructions".into(),
        );
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

    fn panel_get(uri: &str, cookie: &str) -> Request<Body> {
        Request::get(uri)
            .header(header::COOKIE, cookie)
            .header("x-requested-with", "jeeta-panel")
            .body(Body::empty())
            .unwrap()
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
        let app = app(test_deps(), Arc::new(NoStrategyYet), &test_config(&[]));

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

    /// The webhook gate is merged into the one router outside the panel's checks (a provider
    /// carries no session and no panel request header), with the security headers on its
    /// answers too.
    #[tokio::test]
    async fn the_webhook_gate_is_served_outside_the_panel_checks() {
        let mut deps = test_deps();
        deps.apps = Arc::new(FakeAppConfig::with_all_apps());
        let app = app(deps, Arc::new(NoStrategyYet), &test_config(&[]));

        let verify = Request::get(
            "/hooks/meta?hub.mode=subscribe&hub.verify_token=meta-verify-token&hub.challenge=42",
        )
        .body(Body::empty())
        .unwrap();
        let resp = app.clone().oneshot(verify).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        for (name, value) in jt_panel_http::headers::SECURITY_HEADERS {
            let all: Vec<_> = resp.headers().get_all(*name).iter().collect();
            assert_eq!(all, [*value], "{name}");
        }
        let text = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&text[..], b"42");

        // No panel request header, no session: the gate's own answers, not the panel's 403/401.
        let unsigned = Request::post("/hooks/meta").body(Body::from("{}")).unwrap();
        let resp = app.clone().oneshot(unsigned).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let netgsm = Request::post(format!(
            "/hooks/netgsm/0192f0c4-0000-7000-8000-000000000000/{}/mo",
            "0".repeat(64)
        ))
        .body(Body::from("mesaj=x"))
        .unwrap();
        let resp = app.clone().oneshot(netgsm).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mcp_accepts_loopback_hosts_and_the_configured_public_ones() {
        let deps = test_deps();
        let loopback_only = app(deps.clone(), Arc::new(NoStrategyYet), &test_config(&[]));
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
            Arc::new(NoStrategyYet),
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
    async fn the_served_ports_read_channels_from_the_capability_registry_and_guard_hosts() {
        // The production ports over a test database; only the hasher is swapped for speed.
        let db = jt_testkit::TestDb::new().await;
        let config = test_config(&[]);
        let (mut deps, _) = ports(db.pool.clone(), &config);
        deps.hasher = Arc::new(PlainHasher);
        let app = app(deps.clone(), strategy_gate(db.pool.clone()), &config);

        let (status, cookie, me) = call(
            &app,
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
        let ws = jt_testkit::panel::workspace_of(&me);
        jt_testkit::flows::activate_workspace(&deps, ws).await;
        let cookie = cookie.unwrap();
        let session = cookie.split(';').next().unwrap();

        // No capability, no channel kind; a declared phone is one.
        assert!(deps.channels.kinds_in_use(ws).await.unwrap().is_empty());
        let (status, _, body) = call(
            &app,
            panel_post(
                "/api/capabilities",
                Some(session),
                json!({ "kind_key": "phone", "name": "Saha telefonu" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let kinds: Vec<String> = deps
            .channels
            .kinds_in_use(ws)
            .await
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(kinds, ["phone"]);

        // The tenant hosts go through the egress guard: a loopback host is refused, a public one
        // accepted.
        let mailbox = |host: &str| {
            json!({
                "kind_key": "mailbox",
                "name": "Destek",
                "connector_public": { "hosts": [host] },
            })
        };
        let (status, _, body) = call(
            &app,
            panel_post("/api/capabilities", Some(session), mailbox("127.0.0.1")),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["message"], "host is not public");
        let (status, _, body) = call(
            &app,
            panel_post(
                "/api/capabilities",
                Some(session),
                mailbox("imap.example.com"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");

        // The three provider adapters are served; no provider app is configured here, nor a
        // public address: an OAuth flow cannot start (the missing address is named first, before
        // any app, and nothing reaches a provider), and no webhook address is shown.
        for provider in jt_connector::Provider::all() {
            let connector = deps.connectors.connector(*provider).expect("an adapter");
            assert_eq!(connector.provider(), *provider);
            assert_eq!(
                deps.connectors.mail_sender(*provider).is_some(),
                *provider == jt_connector::Provider::Mail
            );
            assert_eq!(
                deps.connectors.mailbox_poller(*provider).is_some(),
                *provider == jt_connector::Provider::Mail
            );
        }
        assert!(
            deps.connectors
                .oauth(jt_connector::Provider::Meta)
                .is_some()
        );
        assert!(deps.connectors.oauth(jt_connector::Provider::X).is_some());
        assert!(
            deps.connectors
                .oauth(jt_connector::Provider::Tiktok)
                .is_some()
        );
        assert!(
            deps.connectors
                .oauth(jt_connector::Provider::Linkedin)
                .is_some()
        );
        assert!(
            deps.connectors
                .sms(jt_connector::Provider::Netgsm)
                .is_some()
        );
        assert_eq!(deps.apps.meta_app(), None);
        assert_eq!(deps.apps.x_app(), None);
        assert_eq!(deps.apps.tiktok_app(), None);
        assert_eq!(deps.apps.linkedin_app(), None);
        assert_eq!(deps.apps.public_base_url(), None);
        let (status, _, body) = call(
            &app,
            panel_post(
                "/api/connectors/oauth/start",
                Some(session),
                json!({ "kind_key": "facebook_page" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["message"], "public base url not configured");
        assert_eq!(body["details"]["reason"], "public_base_url_not_configured");
        let (status, _, body) = call(&app, panel_get("/api/connectors/hooks", session)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["details"]["reason"], "public_base_url_not_configured");
    }

    /// The provider apps of the configuration reach every part that reads them: the OAuth flows
    /// (each app's client id, and its own redirect URI under the public address), the hook
    /// addresses, and the webhook gate's verification (the configured verify token).
    #[tokio::test]
    async fn the_configured_apps_reach_oauth_hooks_and_the_webhook_gate() {
        let db = jt_testkit::TestDb::new().await;
        let config = test_config(&[
            (config::META_APP_ID, "meta-id-1"),
            (config::META_APP_SECRET, "meta-secret-1"),
            (config::META_VERIFY_TOKEN, "verify-1"),
            (config::INSTAGRAM_APP_ID, "ig-id-1"),
            (config::INSTAGRAM_APP_SECRET, "ig-secret-1"),
            (config::X_CLIENT_ID, "x-id-1"),
            (config::X_CLIENT_SECRET, "x-secret-1"),
            (config::TIKTOK_CLIENT_KEY, "tt-key-1"),
            (config::TIKTOK_CLIENT_SECRET, "tt-secret-1"),
            (config::LINKEDIN_CLIENT_ID, "li-id-1"),
            (config::LINKEDIN_CLIENT_SECRET, "li-secret-1"),
            (config::PUBLIC_BASE_URL, "https://jeeta.example"),
        ]);
        let (mut deps, _) = ports(db.pool.clone(), &config);
        deps.hasher = Arc::new(PlainHasher);
        let app = app(deps.clone(), strategy_gate(db.pool.clone()), &config);
        let (status, cookie, me) = call(
            &app,
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
        jt_testkit::flows::activate_workspace(&deps, jt_testkit::panel::workspace_of(&me)).await;
        let cookie = cookie.unwrap();
        let session = cookie.split(';').next().unwrap();

        for (kind, id_param, client_id, callback) in [
            ("facebook_page", "client_id", "meta-id-1", "meta"),
            ("instagram", "client_id", "ig-id-1", "instagram"),
            ("x", "client_id", "x-id-1", "x"),
            // TikTok names its client id the client key.
            ("tiktok", "client_key", "tt-key-1", "tiktok"),
            ("linkedin_member", "client_id", "li-id-1", "linkedin"),
        ] {
            let (status, _, body) = call(
                &app,
                panel_post(
                    "/api/connectors/oauth/start",
                    Some(session),
                    json!({ "kind_key": kind }),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{kind}: {body}");
            let url = Url::parse(body["authorize_url"].as_str().unwrap()).unwrap();
            let param = |name: &str| {
                url.query_pairs()
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.into_owned())
            };
            assert_eq!(param(id_param).as_deref(), Some(client_id), "{kind}");
            assert_eq!(
                param("redirect_uri"),
                Some(format!("https://jeeta.example/oauth/callback/{callback}")),
                "{kind}"
            );
            for secret in [
                "meta-secret-1",
                "ig-secret-1",
                "x-secret-1",
                "tt-secret-1",
                "li-secret-1",
                "verify-1",
            ] {
                assert!(!body.to_string().contains(secret), "{kind}: {body}");
            }
        }

        let (status, _, hooks) = call(&app, panel_get("/api/connectors/hooks", session)).await;
        assert_eq!(status, StatusCode::OK, "{hooks}");
        assert_eq!(hooks["meta"]["url"], "https://jeeta.example/hooks/meta");
        assert!(
            hooks["netgsm"][0]["url"]
                .as_str()
                .unwrap()
                .starts_with("https://jeeta.example/hooks/netgsm/")
        );
        assert!(!hooks.to_string().contains("verify-1"));

        let verify = Request::get(
            "/hooks/meta?hub.mode=subscribe&hub.verify_token=verify-1&hub.challenge=7",
        )
        .body(Body::empty())
        .unwrap();
        let resp = app.clone().oneshot(verify).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            &to_bytes(resp.into_body(), usize::MAX).await.unwrap()[..],
            b"7"
        );
    }

    /// Review Focus 5 end to end: after a restart the egress tenant tier holds the hosts of live
    /// connector capabilities only, a retired capability's hosts staying out although its record
    /// still names them.
    #[tokio::test]
    async fn boot_rebuilds_the_tenant_tier_with_live_connector_hosts_only() {
        let db = jt_testkit::TestDb::new().await;
        let config = test_config(&[
            (config::FILES_DIR, "/tmp"),
            (config::PUBLIC_BASE_URL, "https://files.example.com"),
        ]);
        let (mut deps, _, _) = boot(db.pool.clone(), &config).await.unwrap();
        deps.hasher = Arc::new(PlainHasher);
        let app = app(deps.clone(), strategy_gate(db.pool.clone()), &config);

        // Before the restart: the owner declares two mailboxes naming their hosts, and retires
        // one.
        let (status, cookie, me) = call(
            &app,
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
        let ws = jt_testkit::panel::workspace_of(&me);
        jt_testkit::flows::activate_workspace(&deps, ws).await;
        let cookie = cookie.unwrap();
        let session = cookie.split(';').next().unwrap();
        let mut ids = Vec::new();
        for (name, host) in [
            ("Destek", "imap.live.example"),
            ("Eski", "imap.retired.example"),
        ] {
            let (status, _, body) = call(
                &app,
                panel_post(
                    "/api/capabilities",
                    Some(session),
                    json!({
                        "kind_key": "mailbox",
                        "name": name,
                        "connector_public": { "hosts": [host] },
                    }),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            ids.push(body["capability"]["id"].as_str().unwrap().to_owned());
        }
        let (status, _, body) = call(
            &app,
            panel_post(
                &format!("/api/capabilities/{}/retire", ids[1]),
                Some(session),
                json!({ "confirm": true }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["capability"]["status"], "retired");

        // The restart: a new process, whose tier starts empty, boots on the same database.
        let (_, egress, _) = boot(db.pool.clone(), &config).await.unwrap();
        let reaches = |url: &str| {
            egress.permits(
                jt_outbound::EgressScope::Tenant(ws),
                &Url::parse(url).unwrap(),
            )
        };
        assert!(reaches("https://imap.live.example/"));
        assert!(!reaches("https://imap.retired.example/"));
        // Without the boot step, the tier would be empty.
        let (_, cold) = ports(db.pool.clone(), &config);
        assert!(!cold.permits(
            jt_outbound::EgressScope::Tenant(ws),
            &Url::parse("https://imap.live.example/").unwrap(),
        ));
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
    fn a_build_with_test_loopback_refuses_to_start_unless_allowed() {
        // A production build: nothing to refuse, whatever the variable says.
        check_test_loopback(false, false).unwrap();
        check_test_loopback(false, true).unwrap();
        // A build with jt_outbound's test-loopback paths compiled in.
        let refused = format!("{:#}", check_test_loopback(true, false).unwrap_err());
        for needle in [
            "test-loopback",
            "cargo build --release -p jeeta",
            config::ALLOW_TEST_LOOPBACK,
        ] {
            assert!(refused.contains(needle), "{needle:?} in {refused}");
        }
        // The local-testing override lets it start.
        check_test_loopback(true, true).unwrap();
    }

    #[test]
    fn the_access_log_shows_route_templates_only() {
        assert_eq!(
            loggable_route(Some("/api/team/{membership_id}")),
            "/api/team/{membership_id}"
        );
        assert_eq!(loggable_route(Some("/mcp")), "/mcp");
        // A NetGSM callback is logged by its template: never the workspace's hook token.
        assert_eq!(
            loggable_route(Some("/hooks/netgsm/{workspace_id}/{token}/{purpose}")),
            "/hooks/netgsm/{workspace_id}/{token}/{purpose}"
        );
        // Pages and files (including `/invite/<token>`) match no route: no path at all.
        assert_eq!(loggable_route(None), "-");
        assert_eq!(loggable_route(Some("/api/platform/login")), "<redacted>");
    }
}
