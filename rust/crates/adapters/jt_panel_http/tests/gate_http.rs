//! The gate as a per-route layer: a `Gated` route is refused before its handler runs, whatever
//! the handler extracts, and the workspace-status check binds every route its status exemption
//! does not cover (the strategy and the pending work only while the workspace awaits payment).
//! In-memory ports; no database.

use std::sync::Arc;

use async_trait::async_trait;
use axum::Json;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{Method, Request, StatusCode, header};
use jt_app::catalog::{CATALOG, GateMode, Risk, StatusExemption, UseCase};
use jt_app::error::AppError;
use jt_app::gate::{NoStrategyYet, StrategyGate};
use jt_app::ports::UnitOfWork;
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_panel_http::gate::{OUTSIDE_CURRENT_WORKSPACE, applies};
use jt_panel_http::routes::api_route;
use jt_panel_http::{AppState, Authed, WorkspaceCtx, router, router_with_test_route};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{
    FakeAppConfig, FixedClock, InMemoryUow, PlainHasher, PlainSecretBox, RecordingTenantHosts,
    ScriptedRegistry, SeqIdGen,
};
use serde_json::{Value, json};
use time::macros::datetime;
use tower::ServiceExt;

/// Gated use cases that are not in the catalog (M0 has none), one per handler shape.
static GATED_AUTHED: UseCase = gated("demo.authed", "/api/demo/authed");
static GATED_BARE: UseCase = gated("demo.bare", "/api/demo/bare");
static GATED_CTX: UseCase = gated("demo.ctx", "/api/demo/ctx");

const fn gated(id: &'static str, path: &'static str) -> UseCase {
    UseCase {
        id,
        gate: GateMode::Gated,
        mcp_tool: None,
        panel_route: Some(("GET", path)),
        panel_only: true,
        mcp_only: false,
        status_exemption: StatusExemption::Never,
        risk: Risk::Read,
    }
}

/// A handler that only authenticates: it never looks at the workspace or the gate.
async fn authed_only(Authed(principal): Authed) -> Json<Value> {
    Json(json!({ "ran": true, "user_id": principal.user_id }))
}

/// A handler that extracts nothing about the caller at all.
async fn bare(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({ "ran": true }))
}

/// A handler with the workspace context.
async fn with_ctx(WorkspaceCtx(ctx): WorkspaceCtx) -> Json<Value> {
    Json(json!({ "ran": true, "workspace_id": ctx.workspace_id }))
}

/// A gate under which every workspace has an approved strategy.
struct Approved;

#[async_trait]
impl StrategyGate for Approved {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(true)
    }
}

struct World {
    uow: InMemoryUow,
    deps: Deps,
    ws: WorkspaceId,
    cookie: String,
}

impl World {
    /// A registered owner (whose new workspace awaits payment) with a session cookie.
    async fn new() -> World {
        let uow = InMemoryUow::new();
        let deps = Deps {
            uow: Arc::new(uow.clone()),
            clock: Arc::new(FixedClock(datetime!(2026-10-22 09:00 UTC))),
            ids: Arc::new(SeqIdGen::new()),
            tokens: Arc::new(jt_app::std_impls::RandTokenGen),
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
            job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
        };
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
        World {
            ws: out.me.current_workspace.unwrap(),
            cookie: format!("jt_session={}", out.token),
            uow,
            deps,
        }
    }

    fn state(&self, gate: Arc<dyn StrategyGate>) -> AppState {
        AppState {
            deps: self.deps.clone(),
            gate,
            cookie_secure: false,
            panel_dir: None,
        }
    }

    async fn set_status(&self, status: WorkspaceStatus) {
        let mut platform = self.uow.platform().await.unwrap();
        platform
            .workspace_set_status(
                self.ws,
                status,
                "test status transition",
                &jt_ledger::Actor::System {
                    component: "test".into(),
                },
            )
            .await
            .unwrap();
        platform.commit().await.unwrap();
    }
}

/// Every gated test route, each on its own router.
fn apps(state: &AppState) -> Vec<(&'static str, Router)> {
    vec![
        (
            "/api/demo/authed",
            router_with_test_route(
                state.clone(),
                api_route("GET", "/demo/authed", "demo.authed", authed_only),
                &GATED_AUTHED,
            ),
        ),
        (
            "/api/demo/bare",
            router_with_test_route(
                state.clone(),
                api_route("GET", "/demo/bare", "demo.bare", bare),
                &GATED_BARE,
            ),
        ),
        (
            "/api/demo/ctx",
            router_with_test_route(
                state.clone(),
                api_route("GET", "/demo/ctx", "demo.ctx", with_ctx),
                &GATED_CTX,
            ),
        ),
    ]
}

/// The status and the error code (or `"ran"`) of `GET path` with `cookie`.
async fn ask(app: &Router, path: &str, cookie: Option<&str>) -> (StatusCode, String) {
    let mut req = Request::builder().method(Method::GET).uri(path);
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    let resp = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap())
            .unwrap_or(Value::Null);
    let code = match body["ran"].as_bool() {
        Some(true) => "ran".to_owned(),
        _ => body["code"].as_str().unwrap_or("-").to_owned(),
    };
    (status, code)
}

#[tokio::test]
async fn every_gated_route_is_refused_without_a_strategy() {
    let w = World::new().await;
    w.set_status(WorkspaceStatus::Active).await;
    let cookie = w.cookie.as_str();

    for (path, app) in apps(&w.state(Arc::new(NoStrategyYet))) {
        assert_eq!(
            ask(&app, path, Some(cookie)).await,
            (StatusCode::CONFLICT, "STRATEGY_REQUIRED".to_owned()),
            "{path}"
        );
        // Without a session the gate answers first, before any handler.
        assert_eq!(
            ask(&app, path, None).await,
            (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_owned()),
            "{path}"
        );
    }
    for (path, app) in apps(&w.state(Arc::new(Approved))) {
        assert_eq!(
            ask(&app, path, Some(cookie)).await,
            (StatusCode::OK, "ran".to_owned()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn an_inactive_workspace_closes_gated_routes_whatever_the_strategy() {
    let w = World::new().await;
    let cookie = w.cookie.as_str();
    for status in [WorkspaceStatus::PendingPayment, WorkspaceStatus::Suspended] {
        w.set_status(status).await;
        for (path, app) in apps(&w.state(Arc::new(Approved))) {
            assert_eq!(
                ask(&app, path, Some(cookie)).await,
                (StatusCode::LOCKED, "WORKSPACE_INACTIVE".to_owned()),
                "{path} {status:?}"
            );
        }
    }
}

/// The routes of every M0 use case that is not status-exempt and needs no path parameter.
const CLOSED_WHILE_INACTIVE: [&str; 6] = [
    "/api/team",
    "/api/roles",
    "/api/api-keys",
    "/api/agents",
    "/api/whoami",
    "/api/ledger",
];

#[tokio::test]
async fn the_status_check_binds_every_route_but_auth_workspace_and_platform() {
    let w = World::new().await;
    let app = router(w.state(Arc::new(NoStrategyYet)));
    let cookie = w.cookie.as_str();

    // A new workspace awaits payment: status-exempt routes answer, the others are closed.
    for path in ["/api/auth/me", "/api/workspace"] {
        assert_eq!(
            ask(&app, path, Some(cookie)).await.0,
            StatusCode::OK,
            "{path}"
        );
    }
    for path in CLOSED_WHILE_INACTIVE {
        assert_eq!(
            ask(&app, path, Some(cookie)).await,
            (StatusCode::LOCKED, "WORKSPACE_INACTIVE".to_owned()),
            "{path}"
        );
    }

    w.set_status(WorkspaceStatus::Active).await;
    for path in CLOSED_WHILE_INACTIVE {
        assert_eq!(
            ask(&app, path, Some(cookie)).await.0,
            StatusCode::OK,
            "{path}"
        );
    }
}

/// Routes of the strategy and the pending work that need no path parameter.
const OPEN_WHILE_PENDING_PAYMENT: [&str; 3] = [
    "/api/strategy",
    "/api/strategy/versions",
    "/api/work/pending",
];

#[tokio::test]
async fn suspended_blocks_strategy_and_work_too() {
    let w = World::new().await;
    let app = router(w.state(Arc::new(NoStrategyYet)));
    let cookie = w.cookie.as_str();

    // Awaiting payment, the strategy may be worked out and the pending work read.
    w.set_status(WorkspaceStatus::PendingPayment).await;
    for path in OPEN_WHILE_PENDING_PAYMENT {
        assert_eq!(
            ask(&app, path, Some(cookie)).await.0,
            StatusCode::OK,
            "{path}"
        );
    }

    // Suspended, only identity and the workspace itself answer.
    w.set_status(WorkspaceStatus::Suspended).await;
    for path in OPEN_WHILE_PENDING_PAYMENT
        .into_iter()
        .chain(CLOSED_WHILE_INACTIVE)
    {
        assert_eq!(
            ask(&app, path, Some(cookie)).await,
            (StatusCode::LOCKED, "WORKSPACE_INACTIVE".to_owned()),
            "{path}"
        );
    }
    for path in ["/api/auth/me", "/api/workspace"] {
        assert_eq!(
            ask(&app, path, Some(cookie)).await.0,
            StatusCode::OK,
            "{path}"
        );
    }
}

#[test]
fn the_layer_checks_every_use_case_but_those_exempt_from_both_checks() {
    for uc in CATALOG {
        let expected = uc.status_exemption != StatusExemption::Always
            && !OUTSIDE_CURRENT_WORKSPACE.contains(&uc.id);
        assert_eq!(applies(uc), expected, "{}", uc.id);
    }
    // The strategy and the pending work are checked: a suspended workspace closes them.
    for id in ["strategy.get", "strategy.approve", "work.pending"] {
        assert!(applies(jt_app::catalog::find(id).unwrap()), "{id}");
    }
    for uc in [&GATED_AUTHED, &GATED_BARE, &GATED_CTX] {
        assert!(applies(uc), "{}", uc.id);
    }
    // A gated use case is checked even when it is status-exempt or outside the workspace.
    let gated_status_exempt = UseCase {
        status_exemption: StatusExemption::Always,
        ..GATED_AUTHED
    };
    assert!(applies(&gated_status_exempt));
    // Every exception is a panel-only use case of the catalog, exempt from the strategy gate.
    for id in OUTSIDE_CURRENT_WORKSPACE {
        let uc = jt_app::catalog::find(id).unwrap();
        assert!(uc.panel_only && uc.gate == GateMode::Exempt, "{id}");
    }
}
