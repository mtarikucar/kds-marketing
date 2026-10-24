//! What the webhook gate's tests share: a world over the in-memory fakes (one registered
//! workspace, every provider app configured), connected capabilities written straight to the
//! repos, signed Meta requests, NetGSM callback requests, a unit of work whose event inserts
//! fail, and a log capture.

#![allow(dead_code)]

use std::io::Write;
use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use hmac::{Hmac, KeyInit, Mac};
use jt_app::error::AppError;
use jt_app::ports::{
    AgentConnectionRepo, ApiKeyRepo, BudgetRepo, CapabilityGroupRepo, CapabilityRepo,
    ConsultationRepo, EventQuery, HypothesisRepo, InboundEventRepo, LedgerRepo, MembershipRepo,
    OAuthPendingRepo, OutboundJobRepo, PlatformRepos, ProbeRunRepo, RoleRepo, StrategyRepo,
    TenantRepos, UnitOfWork, UserRepos, WorkspacePolicyRepo, WorkspaceRepo,
};
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::webhook;
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{InboundEvent, InboundEventId, NetgsmPurpose};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, InMemoryUow, StoredInboundEvent, deps};
use jt_webhook::{WebhookState, router};
use sha2::Sha256;
use time::OffsetDateTime;
use tower::ServiceExt;

/// The Meta app secret and verify token of [`FakeAppConfig::with_all_apps`].
pub const APP_SECRET: &str = "meta-app-secret";
/// The Instagram app secret of [`FakeAppConfig::with_all_apps`].
pub const INSTAGRAM_SECRET: &str = "instagram-app-secret";
pub const VERIFY_TOKEN: &str = "meta-verify-token";

/// A fixture's bytes, from `tests/fixtures/`.
pub fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The `X-Hub-Signature-256` value of `body` under `secret`.
pub fn signature(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

/// `POST /hooks/meta` with `body` and, when given, the signature header.
pub fn meta_post(body: &[u8], signature: Option<&str>) -> Request<Body> {
    let mut req = Request::post("/hooks/meta").header(header::CONTENT_TYPE, "application/json");
    if let Some(signature) = signature {
        req = req.header("X-Hub-Signature-256", signature);
    }
    req.body(Body::from(body.to_vec())).unwrap()
}

/// `POST /hooks/meta` with `body` signed by the platform's app secret.
pub fn signed(body: &[u8]) -> Request<Body> {
    meta_post(body, Some(&signature(APP_SECRET, body)))
}

/// `POST /hooks/netgsm/{ws}/{token}/{purpose}` with `body`.
pub fn netgsm_post(ws: &str, token: &str, purpose: &str, body: &[u8]) -> Request<Body> {
    Request::post(format!("/hooks/netgsm/{ws}/{token}/{purpose}"))
        .body(Body::from(body.to_vec()))
        .unwrap()
}

pub async fn send(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
}

/// The status and the body as text.
pub async fn answer(app: &Router, req: Request<Body>) -> (StatusCode, String) {
    let resp = send(app, req).await;
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

/// The world: one workspace "Acme" registered over the in-memory fakes, with every provider app
/// configured.
pub struct World {
    pub uow: InMemoryUow,
    pub deps: Deps,
    pub ws: WorkspaceId,
}

impl World {
    pub async fn new() -> World {
        let uow = InMemoryUow::new();
        let mut deps = deps(Arc::new(uow.clone()));
        deps.apps = Arc::new(FakeAppConfig::with_all_apps());
        let ws = register(&deps, "owner@acme.example", "Acme").await;
        World { uow, deps, ws }
    }

    /// The same world without any provider app.
    pub fn without_apps(&self) -> World {
        self.with_apps(FakeAppConfig::default())
    }

    /// The same world with these provider apps.
    pub fn with_apps(&self, apps: FakeAppConfig) -> World {
        let mut deps = self.deps.clone();
        deps.apps = Arc::new(apps);
        World {
            uow: self.uow.clone(),
            deps,
            ws: self.ws,
        }
    }

    /// The gate over this world's ports.
    pub fn app(&self) -> Router {
        router(WebhookState {
            deps: Arc::new(self.deps.clone()),
        })
    }

    /// The gate over these ports.
    pub fn app_with(&self, deps: Deps) -> Router {
        router(WebhookState {
            deps: Arc::new(deps),
        })
    }

    /// Another workspace, "Beta", registered in the same database.
    pub async fn other_workspace(&self) -> WorkspaceId {
        register(&self.deps, "owner@beta.example", "Beta").await
    }

    /// Sets workspace `ws`'s status straight in the repos.
    pub async fn set_status(&self, ws: WorkspaceId, status: WorkspaceStatus) {
        let mut p = self.uow.platform().await.unwrap();
        p.workspace_set_status(ws, status).await.unwrap();
        p.commit().await.unwrap();
    }

    /// A capability of `kind` holding `external_id` in `ws`, sealed, with this stored status and
    /// verified once by a probe when `verified_once`.
    pub async fn capability(
        &self,
        ws: WorkspaceId,
        kind: &str,
        external_id: &str,
        status: StoredStatus,
        verified_once: bool,
    ) -> CapabilityId {
        capability(&self.uow, ws, kind, external_id, status, verified_once).await
    }

    /// A connected capability: sealed and verified by a probe.
    pub async fn connected(&self, ws: WorkspaceId, kind: &str, external_id: &str) -> CapabilityId {
        self.capability(ws, kind, external_id, StoredStatus::Verified, true)
            .await
    }

    /// Every stored event, in every workspace, in the order stored.
    pub fn stored(&self) -> Vec<StoredInboundEvent> {
        self.uow.snapshot().inbound_events
    }

    pub fn events_of(&self, ws: WorkspaceId) -> Vec<InboundEvent> {
        self.stored()
            .into_iter()
            .map(|s| s.event)
            .filter(|e| e.workspace_id == ws)
            .collect()
    }

    /// The workspace's NetGSM hook token for `purpose`.
    pub fn token(&self, ws: WorkspaceId, purpose: NetgsmPurpose) -> String {
        webhook::netgsm_hook_token(&self.deps, ws, purpose).unwrap()
    }
}

/// Registers `email` with a new workspace and activates it (straight in the repos).
async fn register(deps: &Deps, email: &str, workspace: &str) -> WorkspaceId {
    let out = auth::register(
        deps,
        RegisterInput {
            email: email.into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: workspace.into(),
        },
    )
    .await
    .unwrap();
    let ws = out.me.current_workspace.unwrap();
    let mut p = deps.uow.platform().await.unwrap();
    p.workspace_set_status(ws, WorkspaceStatus::Active)
        .await
        .unwrap();
    p.commit().await.unwrap();
    ws
}

/// A capability of `kind` holding `external_id` in `ws` through `uow` (see
/// [`World::capability`]).
pub async fn capability(
    uow: &dyn UnitOfWork,
    ws: WorkspaceId,
    kind: &str,
    external_id: &str,
    status: StoredStatus,
    verified_once: bool,
) -> CapabilityId {
    let mut c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {external_id}"),
            external_id: Some(external_id.into()),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = status;
    c.last_verified_at = verified_once.then_some(FIXED_NOW);
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities()
        .insert(c.clone(), Some(b"sealed".to_vec()))
        .await
        .unwrap();
    t.commit().await.unwrap();
    c.id
}

// ---------------------------------------------------------------------------------------------
// A unit of work whose event inserts fail
// ---------------------------------------------------------------------------------------------

/// The in-memory unit of work, but every `InboundEventRepo::insert_if_new` fails with `INTERNAL`,
/// as a database that went away would.
#[derive(Clone)]
pub struct FailingInserts(pub InMemoryUow);

struct FailingTenant(Box<dyn TenantRepos>);

#[async_trait]
impl UnitOfWork for FailingInserts {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        Ok(Box::new(FailingTenant(self.0.tenant(ws).await?)))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        self.0.platform().await
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        self.0.user().await
    }
}

#[async_trait]
impl TenantRepos for FailingTenant {
    fn studio(&mut self) -> &mut dyn jt_app::ports::studio::StudioRepo {
        self.0.studio()
    }

    fn studio_budget(&mut self) -> &mut dyn jt_app::ports::studio::StudioBudgetRepo {
        self.0.studio_budget()
    }

    fn studio_control(&mut self) -> &mut dyn jt_app::ports::studio::StudioControlRepo {
        self.0.studio_control()
    }

    fn consents(&mut self) -> &mut dyn jt_app::ports::inbox::ConsentRepo {
        self.0.consents()
    }
    fn suppressions(&mut self) -> &mut dyn jt_app::ports::inbox::SuppressionRepo {
        self.0.suppressions()
    }
    fn quotes(&mut self) -> &mut dyn jt_app::ports::inbox::QuoteRepo {
        self.0.quotes()
    }
    fn appointments(&mut self) -> &mut dyn jt_app::ports::inbox::AppointmentRepo {
        self.0.appointments()
    }
    fn commissions(&mut self) -> &mut dyn jt_app::ports::inbox::CommissionRepo {
        self.0.commissions()
    }
    fn erasure(&mut self) -> &mut dyn jt_app::ports::inbox::ErasureRepo {
        self.0.erasure()
    }
    fn mail_cursors(&mut self) -> &mut dyn jt_app::ports::inbox::MailCursorRepo {
        self.0.mail_cursors()
    }
    fn attribution(&mut self) -> &mut dyn jt_app::ports::inbox::AttributionRepo {
        self.0.attribution()
    }

    fn people(&mut self) -> &mut dyn jt_app::ports::inbox::PersonRepo {
        self.0.people()
    }
    fn identities(&mut self) -> &mut dyn jt_app::ports::inbox::IdentityRepo {
        self.0.identities()
    }
    fn conversations(&mut self) -> &mut dyn jt_app::ports::inbox::ConversationRepo {
        self.0.conversations()
    }
    fn messages(&mut self) -> &mut dyn jt_app::ports::inbox::MessageRepo {
        self.0.messages()
    }
    fn journeys(&mut self) -> &mut dyn jt_app::ports::inbox::JourneyRepo {
        self.0.journeys()
    }
    fn tasks(&mut self) -> &mut dyn jt_app::ports::inbox::TaskRepo {
        self.0.tasks()
    }
    fn notes(&mut self) -> &mut dyn jt_app::ports::inbox::NoteRepo {
        self.0.notes()
    }
    fn merges(&mut self) -> &mut dyn jt_app::ports::inbox::MergeRepo {
        self.0.merges()
    }
    fn lost_reasons(&mut self) -> &mut dyn jt_app::ports::inbox::LostReasonRepo {
        self.0.lost_reasons()
    }
    fn consumption(&mut self) -> &mut dyn jt_app::ports::inbox::ConsumptionRepo {
        self.0.consumption()
    }
    fn request_keys(&mut self) -> &mut dyn jt_app::ports::inbox::RequestKeyRepo {
        self.0.request_keys()
    }
    fn outbox(&mut self) -> &mut dyn jt_app::ports::inbox::OutboxRepo {
        self.0.outbox()
    }
    fn roles(&mut self) -> &mut dyn RoleRepo {
        self.0.roles()
    }
    fn memberships(&mut self) -> &mut dyn MembershipRepo {
        self.0.memberships()
    }
    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo {
        self.0.api_keys()
    }
    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo {
        self.0.agent_connections()
    }
    fn ledger(&mut self) -> &mut dyn LedgerRepo {
        self.0.ledger()
    }
    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self.0.workspace()
    }
    fn strategy(&mut self) -> &mut dyn StrategyRepo {
        self.0.strategy()
    }
    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo {
        self.0.hypotheses()
    }
    fn consultation(&mut self) -> &mut dyn ConsultationRepo {
        self.0.consultation()
    }
    fn capabilities(&mut self) -> &mut dyn CapabilityRepo {
        self.0.capabilities()
    }
    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo {
        self.0.capability_groups()
    }
    fn budget(&mut self) -> &mut dyn BudgetRepo {
        self.0.budget()
    }
    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo {
        self.0.workspace_policy()
    }
    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo {
        self
    }
    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo {
        self.0.oauth_pending()
    }
    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo {
        self.0.probe_runs()
    }

    fn outbound_jobs(&mut self) -> &mut dyn OutboundJobRepo {
        self.0.outbound_jobs()
    }
    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.0.commit().await
    }
}

#[async_trait]
impl InboundEventRepo for FailingTenant {
    async fn call_events(
        &mut self,
        unique_id: &str,
        until: OffsetDateTime,
    ) -> Result<Vec<InboundEvent>, AppError> {
        self.0.inbound_events().call_events(unique_id, until).await
    }

    async fn list_for_consumer(
        &mut self,
        consumer: &str,
        cursor: Option<(OffsetDateTime, InboundEventId)>,
        limit: u32,
    ) -> Result<Vec<InboundEvent>, AppError> {
        self.0
            .inbound_events()
            .list_for_consumer(consumer, cursor, limit)
            .await
    }
    async fn insert_if_new(
        &mut self,
        _event: InboundEvent,
        _raw: Option<Vec<u8>>,
    ) -> Result<Option<InboundEventId>, AppError> {
        Err(AppError::internal("the database went away"))
    }
    async fn list_pending(&mut self, limit: u32) -> Result<Vec<InboundEvent>, AppError> {
        self.0.inbound_events().list_pending(limit).await
    }
    async fn mark_processed(
        &mut self,
        id: InboundEventId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        self.0.inbound_events().mark_processed(id, at).await
    }
    async fn purge_raw_before(&mut self, cutoff: OffsetDateTime) -> Result<u64, AppError> {
        self.0.inbound_events().purge_raw_before(cutoff).await
    }
    async fn list(&mut self, query: EventQuery) -> Result<Vec<InboundEvent>, AppError> {
        self.0.inbound_events().list(query).await
    }
    async fn count_pending(&mut self, cap: u32) -> Result<u32, AppError> {
        self.0.inbound_events().count_pending(cap).await
    }
}

// ---------------------------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------------------------

thread_local! {
    /// The log lines written on this thread since its last [`Logs::capture`].
    static LINES: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The log lines written on the calling thread. One process-wide subscriber writes each line
/// into the buffer of the thread that wrote it (a `#[tokio::test]` runs on a thread of its own),
/// so parallel tests do not see each other's lines, and no callsite is ever disabled for want of
/// a subscriber.
pub struct Logs;

impl Logs {
    /// Starts capturing this thread's lines afresh.
    pub fn capture() -> Logs {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let subscriber = tracing_subscriber::fmt()
                .with_writer(|| ThreadWriter)
                .with_ansi(false)
                .with_max_level(tracing::Level::DEBUG)
                .finish();
            tracing::subscriber::set_global_default(subscriber)
                .expect("no other global subscriber in this test binary");
        });
        LINES.with(|lines| lines.borrow_mut().clear());
        Logs
    }

    /// What this thread logged since [`Logs::capture`].
    pub fn text(&self) -> String {
        LINES.with(|lines| String::from_utf8(lines.borrow().clone()).unwrap())
    }
}

struct ThreadWriter;

impl Write for ThreadWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        LINES.with(|lines| lines.borrow_mut().extend_from_slice(buf));
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
