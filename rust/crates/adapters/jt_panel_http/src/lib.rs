//! Panel HTTP adapter: axum JSON API, session cookies, request-header check and static panel
//! files.
//!
//! [`router`] serves:
//! - `/api/*`: the JSON API of [`ROUTES`]. Users sign in with the `jt_session` cookie
//!   ([`session`]); the platform console's `/api/platform/*` routes take the operator's separate
//!   `jt_platform` cookie ([`platform_session`]). Every mutating request must carry
//!   `X-Requested-With: jeeta-panel` ([`csrf`]), checked before authentication and body
//!   parsing. Each route is then wrapped in the gate of its catalog use case ([`gate`]), which
//!   runs before the handler whatever the handler extracts. Errors, including bad bodies,
//!   malformed path parameters and unknown paths, are structured:
//!   `{ "code", "message", "details" }`.
//! - `/healthz`: `200 {"ok":true}`.
//! - Everything else: the built panel from [`AppState::panel_dir`] ([`static_files`]), or a
//!   structured `404` when there is none.
//!
//! Every response carries the security headers of [`headers`] (`nosniff`, `no-referrer`,
//! `frame-ancestors 'none'`).

pub mod csrf;
pub mod error;
pub mod gate;
pub mod headers;
pub mod platform_session;
pub mod routes;
pub mod session;
pub mod state;
pub mod static_files;

use axum::extract::Request;
use axum::{Router, middleware};
use jt_app::catalog::{CATALOG, UseCase};
use routes::ApiRoute;

pub use error::{ApiError, ApiJson, ApiPath, ApiQuery};
pub use headers::security_headers;
pub use platform_session::PlatformAuthed;
pub use routes::ROUTES;
pub use session::{Authed, WorkspaceCtx};
pub use state::AppState;

/// The path under which the JSON API lives.
pub const API_PREFIX: &str = "/api";

/// The panel's HTTP service: the routes of [`ROUTES`], the request-header check on the API and
/// the static panel (see the crate docs).
///
/// # Panics
///
/// When an API route's use case is missing from `CATALOG` or listed there at another route
/// (see [`routes::resolve`]); the server then stops at startup.
pub fn router(state: AppState) -> Router {
    build(state, routes::api_routes(), CATALOG)
}

/// [`router`] with one more API route, `route`, for `use_case`, which need not be in the
/// catalog. Meant for tests (e.g. a `Gated` use case, which the catalog does not have yet, or a
/// handler with unusual extractors); the binary serves [`router`] as it is.
///
/// # Panics
///
/// As [`router`]; when `use_case` is not `route`'s (its id and panel route must match); and when
/// the catalog already has a use case with its id.
pub fn router_with_test_route(
    state: AppState,
    route: ApiRoute,
    use_case: &'static UseCase,
) -> Router {
    assert!(
        jt_app::catalog::find(use_case.id).is_none(),
        "use case `{}` is already in the catalog",
        use_case.id
    );
    let mut api_routes = routes::api_routes();
    api_routes.push(route);
    let mut catalog: Vec<UseCase> = CATALOG.to_vec();
    catalog.push(*use_case);
    build(state, api_routes, &catalog)
}

/// [`router`] over the given API routes, resolved in `catalog`.
fn build(state: AppState, api_routes: Vec<ApiRoute>, catalog: &[UseCase]) -> Router {
    let mut api = Router::new();
    for route in api_routes {
        let use_case = routes::resolve(&route, catalog);
        let gate = gate::RouteGate {
            state: state.clone(),
            use_case,
        };
        let handler = route
            .handler
            .route_layer(middleware::from_fn_with_state(gate, gate::require_gate));
        let handler = if matches!(use_case.id, "studio.file_upload" | "studio.piece_submit") {
            handler.layer(axum::extract::DefaultBodyLimit::max(280_000_000))
        } else {
            handler
        };
        api = api.route(route.path, handler);
    }
    let api = api
        .fallback(error::not_found)
        .method_not_allowed_fallback(error::not_found)
        // Wraps every API route and the API fallbacks, so it runs before any extractor
        // (authentication, body parsing) and also covers unknown API paths.
        .layer(middleware::from_fn(csrf::require_requested_with));

    let mut app = Router::new();
    for route in routes::root_routes() {
        app = app.route(route.path, route.handler);
    }
    let panel = state.panel_dir.as_deref().map(static_files::Panel::new);
    app.method_not_allowed_fallback(error::not_found)
        .nest(API_PREFIX, api)
        .fallback(move |req: Request| static_files::serve(panel.clone(), req))
        // Outermost, so every response gets them: routes, fallbacks and early refusals alike.
        .layer(middleware::from_fn(headers::security_headers))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, StatusCode, header};
    use jt_app::catalog::{GateMode, Risk, StatusExemption};
    use jt_app::error::AppError;
    use jt_app::gate::{NoStrategyYet, StrategyGate};
    use jt_app::ports::UnitOfWork;
    use jt_app::usecases::Deps;
    use jt_app::usecases::auth::{self, RegisterInput};
    use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
    use jt_tenancy::{WorkspaceId, WorkspaceStatus};
    use jt_testkit::fakes::{
        FakeAppConfig, FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox,
        RecordingTenantHosts, ScriptedRegistry, SeqIdGen,
    };
    use serde_json::Value;
    use time::macros::datetime;
    use tower::ServiceExt;

    use super::*;

    /// A gated use case, served by the `workspace.info` handler at `GET /api/demo`.
    const DEMO: UseCase = UseCase {
        id: "demo.read",
        gate: GateMode::Gated,
        mcp_tool: Some("jeeta.demo.read"),
        panel_route: Some(("GET", "/api/demo")),
        panel_only: false,
        mcp_only: false,
        status_exemption: StatusExemption::Never,
        risk: Risk::Read,
    };

    fn demo_routes(use_case: &'static str) -> Vec<ApiRoute> {
        vec![routes::api_route(
            "GET",
            "/demo",
            use_case,
            routes::workspace::info,
        )]
    }

    /// A gate under which every workspace has an approved strategy.
    struct Approved;

    #[async_trait]
    impl StrategyGate for Approved {
        async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
            Ok(true)
        }
    }

    fn deps(uow: &InMemoryUow) -> Deps {
        Deps {
            uow: Arc::new(uow.clone()),
            clock: Arc::new(FixedClock(datetime!(2026-10-22 09:00 UTC))),
            ids: Arc::new(SeqIdGen::new()),
            tokens: Arc::new(FixedTokenGen::new(["aaaa", "session-1"])),
            hasher: Arc::new(PlainHasher),
            seal: Arc::new(PlainSecretBox),
            channels: Arc::new(NoChannelsYet),
            file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
            media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
            files: Arc::new(jt_app::ports::files::UnavailableFileStore),
            transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
            apps: Arc::new(FakeAppConfig::default()),
            connectors: Arc::new(ScriptedRegistry::new()),
            ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
            ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
            billing: jt_app::usecases::billing::BillingConfig {
                price_minor: 123,
                price_currency: "TRY".into(),
                bank_instructions: "Synthetic bank instructions".into(),
            },
            job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
        }
    }

    fn state(deps: Deps, gate: Arc<dyn StrategyGate>) -> AppState {
        AppState {
            deps,
            gate,
            cookie_secure: false,
            panel_dir: None,
        }
    }

    #[test]
    #[should_panic(
        expected = "route GET /api/demo names use case `demo.read`, which is not in the catalog"
    )]
    fn a_route_whose_use_case_is_not_in_the_catalog_panics_at_build() {
        let uow = InMemoryUow::new();
        let _ = build(
            state(deps(&uow), Arc::new(NoStrategyYet)),
            demo_routes("demo.read"),
            CATALOG,
        );
    }

    #[test]
    #[should_panic(
        expected = "route GET /api/demo names use case `workspace.info`, whose catalog panel route \
                    is Some((\"GET\", \"/api/workspace\"))"
    )]
    fn a_route_the_catalog_lists_elsewhere_panics_at_build() {
        let uow = InMemoryUow::new();
        let _ = build(
            state(deps(&uow), Arc::new(NoStrategyYet)),
            demo_routes("workspace.info"),
            CATALOG,
        );
    }

    /// The status (and, for `GET`, the error code) of `GET` and `HEAD /api/demo`.
    async fn ask(app: &Router) -> Vec<(Method, StatusCode, Option<String>)> {
        let mut answers = Vec::new();
        for method in [Method::GET, Method::HEAD] {
            let req = Request::builder()
                .method(method.clone())
                .uri("/api/demo")
                .header(header::COOKIE, "jt_session=session-1")
                .body(Body::empty())
                .unwrap();
            let resp = app.clone().oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            let code = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|body| body["code"].as_str().map(str::to_owned));
            answers.push((method, status, code));
        }
        answers
    }

    #[tokio::test]
    async fn gated_routes_answer_with_the_gate_for_get_and_head() {
        let uow = InMemoryUow::new();
        let deps = deps(&uow);
        let out = auth::register(
            &deps,
            RegisterInput {
                email: "owner@example.com".into(),
                password: "correct horse battery".into(),
                display_name: "Owner".into(),
                workspace_name: "Acme".into(),
            },
        )
        .await
        .unwrap();
        let ws = out.me.current_workspace.unwrap();
        let catalog = [DEMO];
        let without_strategy = build(
            state(deps.clone(), Arc::new(NoStrategyYet)),
            demo_routes("demo.read"),
            &catalog,
        );
        let with_strategy = build(
            state(deps.clone(), Arc::new(Approved)),
            demo_routes("demo.read"),
            &catalog,
        );
        let refused = |status: StatusCode, code: &str| {
            vec![
                (Method::GET, status, Some(code.to_owned())),
                (Method::HEAD, status, None),
            ]
        };

        // A new workspace awaits payment: inactive, whatever the strategy.
        assert_eq!(
            ask(&with_strategy).await,
            refused(StatusCode::LOCKED, "WORKSPACE_INACTIVE")
        );

        let mut platform = uow.platform().await.unwrap();
        platform
            .workspace_set_status(
                ws,
                WorkspaceStatus::Active,
                "test status transition",
                &jt_ledger::Actor::System {
                    component: "test".into(),
                },
            )
            .await
            .unwrap();
        platform.commit().await.unwrap();
        assert_eq!(
            ask(&without_strategy).await,
            refused(StatusCode::CONFLICT, "STRATEGY_REQUIRED")
        );
        assert_eq!(
            ask(&with_strategy).await,
            vec![
                (Method::GET, StatusCode::OK, None),
                (Method::HEAD, StatusCode::OK, None),
            ]
        );
    }
}
