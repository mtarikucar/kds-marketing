//! The strategy use cases over the in-memory fakes: starting a consultation, recording it,
//! drafting sections and hypotheses, submitting, approving and archiving, and reading versions
//! and the consultation log. One test per rule.
//!
//! The fakes sit behind a [`Spy`], a unit of work that records the strategy repo calls each
//! tenant bundle makes (to check the draft lock and the lock order) and can make the database's
//! answers to a race happen on demand.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{
    AgentConnectionRepo, ApiKeyRepo, BudgetRepo, CapabilityGroupRepo, CapabilityRepo,
    ConsultationRepo, HypothesisRepo, InboundEventRepo, LedgerRepo, MembershipRepo,
    OAuthPendingRepo, OutboundJobRepo, PlatformRepos, ProbeRunRepo, RoleRepo, StrategyArchivedHook,
    StrategyRepo, TenantRepos, UnitOfWork, UserRepos, UserRow, WorkspacePolicyRepo, WorkspaceRepo,
};
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::groups;
use jt_app::usecases::roles::{self, CreateRole};
use jt_app::usecases::strategy::{
    self, ApproveInput, ArchiveInput, RecordInput, RecordKind, VersionOut,
};
use jt_ledger::{Actor, LedgerEntry, Subject};
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, Hypothesis, HypothesisId,
    HypothesisState, Sections, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{
    AgentConnectionId, Email, MembershipId, Permission, SystemRole, UserId, WorkspaceId,
};
use jt_testkit::fakes::{FIXED_NOW, FixedChannelCatalog, InMemoryUow, deps};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

// ---------------------------------------------------------------------------------------------
// The spy
// ---------------------------------------------------------------------------------------------

/// Calls that write a strategy row, a hypothesis or a consultation entry.
const WRITES: &[&str] = &[
    "strategy.insert",
    "strategy.update_sections",
    "strategy.set_submitted",
    "strategy.set_status(approved)",
    "strategy.set_status(archived)",
    "hypotheses.replace_all",
    "hypotheses.upsert",
    "hypotheses.set_state",
    "consultation.append",
];

/// An [`InMemoryUow`] that logs, in order, each tenant bundle it opens (`open`), every strategy,
/// hypothesis and consultation repo call, and each commit (`commit`).
#[derive(Clone)]
struct Spy {
    inner: InMemoryUow,
    log: Arc<Mutex<Vec<String>>>,
    /// Approving a version fails with `CONFLICT`, as the partial unique index answers when another
    /// approval committed first.
    approval_loses: Arc<AtomicBool>,
    /// Moving a version finds it already moved (0 rows), as when another transaction moved it.
    already_moved: Arc<AtomicBool>,
}

impl Spy {
    fn new(inner: InMemoryUow) -> Spy {
        Spy {
            inner,
            log: Arc::default(),
            approval_loses: Arc::default(),
            already_moved: Arc::default(),
        }
    }

    fn push(&self, call: impl Into<String>) {
        self.log.lock().unwrap().push(call.into());
    }

    /// The calls logged since the last `take`, which clears the log.
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

#[async_trait]
impl UnitOfWork for Spy {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        self.push("open");
        Ok(Box::new(SpyTenant {
            inner: self.inner.tenant(ws).await?,
            spy: self.clone(),
        }))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        self.inner.platform().await
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        self.inner.user().await
    }
}

struct SpyTenant {
    inner: Box<dyn TenantRepos>,
    spy: Spy,
}

#[async_trait]
impl TenantRepos for SpyTenant {
    fn billing(&mut self) -> &mut dyn jt_app::ports::billing::BillingRepo {
        self.inner.billing()
    }

    fn activation_codes(&mut self) -> &mut dyn jt_app::ports::billing::ActivationCodeRepo {
        self.inner.activation_codes()
    }

    fn studio(&mut self) -> &mut dyn jt_app::ports::studio::StudioRepo {
        self.inner.studio()
    }

    fn studio_budget(&mut self) -> &mut dyn jt_app::ports::studio::StudioBudgetRepo {
        self.inner.studio_budget()
    }

    fn studio_control(&mut self) -> &mut dyn jt_app::ports::studio::StudioControlRepo {
        self.inner.studio_control()
    }
    fn calls(&mut self) -> &mut dyn jt_app::ports::calls::CallRepo {
        self.inner.calls()
    }
    fn device_commands(&mut self) -> &mut dyn jt_app::ports::devices::DeviceCommandRepo {
        self.inner.device_commands()
    }

    fn consents(&mut self) -> &mut dyn jt_app::ports::inbox::ConsentRepo {
        self.inner.consents()
    }
    fn suppressions(&mut self) -> &mut dyn jt_app::ports::inbox::SuppressionRepo {
        self.inner.suppressions()
    }
    fn quotes(&mut self) -> &mut dyn jt_app::ports::inbox::QuoteRepo {
        self.inner.quotes()
    }
    fn appointments(&mut self) -> &mut dyn jt_app::ports::inbox::AppointmentRepo {
        self.inner.appointments()
    }
    fn commissions(&mut self) -> &mut dyn jt_app::ports::inbox::CommissionRepo {
        self.inner.commissions()
    }
    fn erasure(&mut self) -> &mut dyn jt_app::ports::inbox::ErasureRepo {
        self.inner.erasure()
    }
    fn mail_cursors(&mut self) -> &mut dyn jt_app::ports::inbox::MailCursorRepo {
        self.inner.mail_cursors()
    }
    fn attribution(&mut self) -> &mut dyn jt_app::ports::inbox::AttributionRepo {
        self.inner.attribution()
    }

    fn people(&mut self) -> &mut dyn jt_app::ports::inbox::PersonRepo {
        self.inner.people()
    }
    fn identities(&mut self) -> &mut dyn jt_app::ports::inbox::IdentityRepo {
        self.inner.identities()
    }
    fn conversations(&mut self) -> &mut dyn jt_app::ports::inbox::ConversationRepo {
        self.inner.conversations()
    }
    fn messages(&mut self) -> &mut dyn jt_app::ports::inbox::MessageRepo {
        self.inner.messages()
    }
    fn journeys(&mut self) -> &mut dyn jt_app::ports::inbox::JourneyRepo {
        self.inner.journeys()
    }
    fn tasks(&mut self) -> &mut dyn jt_app::ports::inbox::TaskRepo {
        self.inner.tasks()
    }
    fn notes(&mut self) -> &mut dyn jt_app::ports::inbox::NoteRepo {
        self.inner.notes()
    }
    fn merges(&mut self) -> &mut dyn jt_app::ports::inbox::MergeRepo {
        self.inner.merges()
    }
    fn lost_reasons(&mut self) -> &mut dyn jt_app::ports::inbox::LostReasonRepo {
        self.inner.lost_reasons()
    }
    fn consumption(&mut self) -> &mut dyn jt_app::ports::inbox::ConsumptionRepo {
        self.inner.consumption()
    }
    fn request_keys(&mut self) -> &mut dyn jt_app::ports::inbox::RequestKeyRepo {
        self.inner.request_keys()
    }
    fn outbox(&mut self) -> &mut dyn jt_app::ports::inbox::OutboxRepo {
        self.inner.outbox()
    }
    fn roles(&mut self) -> &mut dyn RoleRepo {
        self.inner.roles()
    }

    fn memberships(&mut self) -> &mut dyn MembershipRepo {
        self.inner.memberships()
    }

    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo {
        self.inner.api_keys()
    }

    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo {
        self.inner.agent_connections()
    }

    fn ledger(&mut self) -> &mut dyn LedgerRepo {
        self.inner.ledger()
    }

    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self.inner.workspace()
    }

    fn strategy(&mut self) -> &mut dyn StrategyRepo {
        self
    }

    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo {
        self
    }

    fn consultation(&mut self) -> &mut dyn ConsultationRepo {
        self
    }

    fn capabilities(&mut self) -> &mut dyn CapabilityRepo {
        self.inner.capabilities()
    }

    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo {
        self.inner.capability_groups()
    }

    fn budget(&mut self) -> &mut dyn BudgetRepo {
        self.inner.budget()
    }

    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo {
        self.inner.workspace_policy()
    }

    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo {
        self.inner.inbound_events()
    }

    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo {
        self.inner.oauth_pending()
    }

    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo {
        self.inner.probe_runs()
    }

    fn outbound_jobs(&mut self) -> &mut dyn OutboundJobRepo {
        self.inner.outbound_jobs()
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.spy.push("commit");
        self.inner.commit().await
    }
}

#[async_trait]
impl StrategyRepo for SpyTenant {
    async fn lock_execution_frame(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        self.spy.push("strategy.lock_execution_frame");
        self.inner.strategy().lock_execution_frame().await
    }

    async fn insert(&mut self, version: StrategyVersion) -> Result<(), AppError> {
        self.spy.push("strategy.insert");
        self.inner.strategy().insert(version).await
    }

    async fn find(&mut self, id: StrategyVersionId) -> Result<Option<StrategyVersion>, AppError> {
        self.spy.push("strategy.find");
        self.inner.strategy().find(id).await
    }

    async fn current_approved(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        self.spy.push("strategy.current_approved");
        self.inner.strategy().current_approved().await
    }

    async fn current_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        self.spy.push("strategy.current_draft");
        self.inner.strategy().current_draft().await
    }

    async fn lock_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        self.spy.push("strategy.lock_draft");
        self.inner.strategy().lock_draft().await
    }

    async fn list(&mut self) -> Result<Vec<StrategyVersion>, AppError> {
        self.spy.push("strategy.list");
        self.inner.strategy().list().await
    }

    async fn update_sections(
        &mut self,
        id: StrategyVersionId,
        sections: Sections,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.spy.push("strategy.update_sections");
        self.inner
            .strategy()
            .update_sections(id, sections, at)
            .await
    }

    async fn set_submitted(
        &mut self,
        id: StrategyVersionId,
        at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        self.spy.push("strategy.set_submitted");
        self.inner.strategy().set_submitted(id, at).await
    }

    async fn set_status(
        &mut self,
        id: StrategyVersionId,
        status: VersionStatus,
        at: OffsetDateTime,
        by: Option<UserId>,
    ) -> Result<u64, AppError> {
        self.spy
            .push(format!("strategy.set_status({})", status.key()));
        if self.spy.already_moved.load(Ordering::SeqCst) {
            return Ok(0);
        }
        if status == VersionStatus::Approved && self.spy.approval_loses.load(Ordering::SeqCst) {
            return Err(AppError::conflict(
                "the workspace already has an approved strategy version",
            ));
        }
        self.inner.strategy().set_status(id, status, at, by).await
    }

    async fn next_number(&mut self) -> Result<i32, AppError> {
        self.spy.push("strategy.next_number");
        self.inner.strategy().next_number().await
    }
}

#[async_trait]
impl HypothesisRepo for SpyTenant {
    async fn set_derived_confidence(
        &mut self,
        id: HypothesisId,
        confidence: f32,
        evidence_key: &str,
    ) -> Result<(), AppError> {
        self.inner
            .hypotheses()
            .set_derived_confidence(id, confidence, evidence_key)
            .await
    }
    async fn append_draft_hypothesis(
        &mut self,
        id: StrategyVersionId,
        input: jt_strategy::HypothesisInput,
    ) -> Result<HypothesisId, AppError> {
        self.inner
            .hypotheses()
            .append_draft_hypothesis(id, input)
            .await
    }

    async fn replace_all(
        &mut self,
        version_id: StrategyVersionId,
        hypotheses: Vec<Hypothesis>,
    ) -> Result<(), AppError> {
        self.spy.push("hypotheses.replace_all");
        self.inner
            .hypotheses()
            .replace_all(version_id, hypotheses)
            .await
    }

    async fn list(&mut self, version_id: StrategyVersionId) -> Result<Vec<Hypothesis>, AppError> {
        self.spy.push("hypotheses.list");
        self.inner.hypotheses().list(version_id).await
    }

    async fn upsert(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis: Hypothesis,
    ) -> Result<(), AppError> {
        self.spy.push("hypotheses.upsert");
        self.inner.hypotheses().upsert(version_id, hypothesis).await
    }

    async fn set_state(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis_id: HypothesisId,
        state: HypothesisState,
    ) -> Result<(), AppError> {
        self.spy.push("hypotheses.set_state");
        self.inner
            .hypotheses()
            .set_state(version_id, hypothesis_id, state)
            .await
    }
}

#[async_trait]
impl ConsultationRepo for SpyTenant {
    async fn append(&mut self, entry: ConsultationEntry) -> Result<ConsultationEntryId, AppError> {
        self.spy.push("consultation.append");
        self.inner.consultation().append(entry).await
    }

    async fn list(
        &mut self,
        version_id: StrategyVersionId,
        limit: u32,
        before: Option<(OffsetDateTime, ConsultationEntryId)>,
    ) -> Result<Vec<ConsultationEntry>, AppError> {
        self.spy.push("consultation.list");
        self.inner
            .consultation()
            .list(version_id, limit, before)
            .await
    }

    async fn list_kind(
        &mut self,
        version_id: StrategyVersionId,
        kind: ConsultationKind,
        limit: u32,
    ) -> Result<Vec<ConsultationEntry>, AppError> {
        self.spy.push("consultation.list_kind");
        self.inner
            .consultation()
            .list_kind(version_id, kind, limit)
            .await
    }

    async fn count(&mut self, version_id: StrategyVersionId) -> Result<i64, AppError> {
        self.spy.push("consultation.count");
        self.inner.consultation().count(version_id).await
    }
}

/// What the hook was told, with the version's status in the committed tables at that moment.
type Told = (WorkspaceId, StrategyVersionId, Option<VersionStatus>);

/// A hook that records each archived version with the status the committed tables show for it
/// at the moment it is told.
#[derive(Clone)]
struct HookSpy {
    uow: InMemoryUow,
    seen: Arc<Mutex<Vec<Told>>>,
}

#[async_trait]
impl StrategyArchivedHook for HookSpy {
    async fn on_archived(
        &self,
        ws: WorkspaceId,
        version_id: StrategyVersionId,
    ) -> Result<(), AppError> {
        let committed = self
            .uow
            .snapshot()
            .strategy_versions
            .into_iter()
            .find(|v| v.id == version_id)
            .map(|v| v.status);
        self.seen.lock().unwrap().push((ws, version_id, committed));
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

/// The workspace "Acme", registered by its owner, with `instagram` and `mailbox` capabilities.
struct World {
    uow: InMemoryUow,
    spy: Spy,
    deps: Deps,
    ws: WorkspaceId,
    owner: UserId,
    owner_ctx: Ctx,
}

fn kinds(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

async fn world() -> World {
    let uow = InMemoryUow::new();
    let spy = Spy::new(uow.clone());
    let mut deps = deps(Arc::new(spy.clone()));
    deps.channels = Arc::new(FixedChannelCatalog(kinds(&["instagram", "mailbox"])));
    let out = auth::register(
        &deps,
        RegisterInput {
            email: "owner@acme.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Acme".into(),
        },
    )
    .await
    .unwrap();
    let ws = out.me.current_workspace.unwrap();
    let owner = out.me.user_id;
    let owner_ctx = human(ws, owner, "owner", SystemRole::Owner.permissions());
    World {
        uow,
        spy,
        deps,
        ws,
        owner,
        owner_ctx,
    }
}

fn human(ws: WorkspaceId, user: UserId, role_key: &str, permissions: BTreeSet<Permission>) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions,
        role_key: Some(role_key.to_owned()),
        now: FIXED_NOW,
        agent_connection_id: None,
    }
}

impl World {
    /// A new active member holding the role `role_key`, and their context.
    async fn member(&self, role_key: &str) -> (UserId, Ctx) {
        let role = {
            let mut t = self.uow.tenant(self.ws).await.unwrap();
            t.roles().find_by_key(role_key).await.unwrap().unwrap()
        };
        let user = UserId::new_v7();
        let mut u = self.uow.user().await.unwrap();
        u.users()
            .insert(UserRow {
                id: user,
                email: Email::parse(&format!("{role_key}@acme.example")).unwrap(),
                password_hash: "plain:pw".into(),
                display_name: role_key.into(),
                created_at: FIXED_NOW,
            })
            .await
            .unwrap();
        u.memberships_insert_active(MembershipId::new_v7(), self.ws, user, role.id, FIXED_NOW)
            .await
            .unwrap();
        u.commit().await.unwrap();
        let ctx = human(self.ws, user, role_key, role.permissions);
        (user, ctx)
    }

    /// The context of an agent acting through a new key the owner issues with `scopes`.
    async fn owner_agent(&self, scopes: &[&str]) -> Ctx {
        self.agent(&self.owner_ctx, scopes).await
    }

    /// The context of an agent acting through a new key `issuer` issues with `scopes`.
    async fn agent(&self, issuer: &Ctx, scopes: &[&str]) -> Ctx {
        let key = api_keys::create(
            &self.deps,
            issuer,
            CreateKey {
                name: format!("agent {}", scopes.join(" ")),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap();
        let principal = api_keys::authenticate(&self.deps, &key.plaintext)
            .await
            .unwrap();
        api_keys::ctx_for_agent(&principal, AgentConnectionId::new_v7(), FIXED_NOW)
    }

    /// The same world with the workspace's channel kinds set to `names`.
    fn with_channels(&self, names: &[&str]) -> Deps {
        Deps {
            channels: Arc::new(FixedChannelCatalog(kinds(names))),
            ..self.deps.clone()
        }
    }

    fn versions(&self) -> Vec<StrategyVersion> {
        self.uow.snapshot().strategy_versions
    }

    fn version(&self, id: StrategyVersionId) -> StrategyVersion {
        self.versions().into_iter().find(|v| v.id == id).unwrap()
    }

    fn hypotheses(&self, version: StrategyVersionId) -> Vec<Hypothesis> {
        let mut rows: Vec<_> = self
            .uow
            .snapshot()
            .hypotheses
            .into_iter()
            .filter(|h| h.version_id == version)
            .collect();
        rows.sort_by_key(|h| h.position);
        rows.into_iter().map(|h| h.hypothesis).collect()
    }

    /// The version's consultation log, oldest first.
    fn log(&self, version: StrategyVersionId) -> Vec<ConsultationEntry> {
        self.uow
            .snapshot()
            .consultation
            .into_iter()
            .map(|e| e.entry)
            .filter(|e| e.version_id == version)
            .collect()
    }

    /// The ledger entries whose action starts with `strategy.`, oldest first.
    fn ledger(&self) -> Vec<LedgerEntry> {
        self.uow
            .snapshot()
            .ledger
            .into_iter()
            .map(|row| row.entry)
            .filter(|e| e.action.as_str().starts_with("strategy."))
            .collect()
    }

    fn entries(&self, action: &str) -> Vec<LedgerEntry> {
        self.ledger()
            .into_iter()
            .filter(|e| e.action.as_str() == action)
            .collect()
    }
}

/// Every section, complete: one segment (`students`), the `instagram` channel, an organic lane.
fn complete_sections() -> Vec<(&'static str, Value)> {
    vec![
        (
            "identity",
            json!({ "product": "Kahve", "voice": "sıcak", "positioning": "mahalle", "usp": "taze" }),
        ),
        (
            "audience",
            json!([{ "key": "students", "name": "Öğrenciler", "description": "kampüs" }]),
        ),
        (
            "channels",
            json!([{ "channel": "instagram", "rationale": "genç kitle" }]),
        ),
        (
            "goals",
            json!({ "objective": "ayda 50 DM", "kpis": [{ "name": "dm", "target": "50" }] }),
        ),
        (
            "budget_frame",
            json!({ "lanes": [{ "lane": "organic", "period": "monthly", "cap_minor": 0, "currency": "TRY" }] }),
        ),
        ("prohibitions", json!(["rakip adı"])),
        (
            "cadence",
            json!({ "per_week": 3, "channel_mix": [{ "channel": "instagram", "share_pct": 100 }] }),
        ),
        ("paid_enabled", json!(false)),
    ]
}

fn one_hypothesis(channel: &str) -> Value {
    json!([{
        "title": "Sınav haftası",
        "segment_key": "students",
        "angle": "gece açık",
        "channel": channel,
        "metric": "dm",
        "prior_confidence": 0.6,
    }])
}

/// Archiving `version_id`, confirmed.
fn archiving(version_id: StrategyVersionId) -> ArchiveInput {
    ArchiveInput {
        version_id,
        confirm: true,
    }
}

fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn gap_fields(err: &AppError) -> Vec<String> {
    err.details["gaps"]
        .as_array()
        .unwrap_or_else(|| panic!("no gaps in {err:?}"))
        .iter()
        .map(|g| g["field"].as_str().unwrap().to_owned())
        .collect()
}

/// Starts a consultation as `ctx` and writes every section and one hypothesis on `instagram`.
async fn complete_draft(w: &World, ctx: &Ctx) -> VersionOut {
    strategy::start_consultation(&w.deps, ctx).await.unwrap();
    for (key, value) in complete_sections() {
        strategy::write_section(&w.deps, ctx, key.to_owned(), value)
            .await
            .unwrap();
    }
    strategy::set_hypotheses(&w.deps, ctx, one_hypothesis("instagram"))
        .await
        .unwrap()
}

/// A complete draft, submitted and approved by the owner.
async fn approved(w: &World) -> VersionOut {
    complete_draft(w, &w.owner_ctx).await;
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    strategy::approve(&w.deps, &w.owner_ctx, as_read(w))
        .await
        .unwrap()
}

/// What approving the draft as it now stands takes: its id and its submission time, as a caller
/// that has just read it sends them (read past the spy). Without a draft, a made-up one.
fn as_read(w: &World) -> ApproveInput {
    match w
        .versions()
        .into_iter()
        .find(|v| v.status == VersionStatus::Draft)
    {
        Some(draft) => ApproveInput {
            version_id: draft.id,
            submitted_at: draft.submitted_at.unwrap_or(FIXED_NOW),
        },
        None => ApproveInput {
            version_id: StrategyVersionId::new_v7(),
            submitted_at: FIXED_NOW,
        },
    }
}

// ---------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn get_needs_workspace_read() {
    let w = world().await;
    let ctx = human(w.ws, w.owner, "owner", BTreeSet::new());
    let err = strategy::get(&w.deps, &ctx).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details, json!({ "permission": "workspace.read" }));
}

#[tokio::test]
async fn draft_version_out_lists_assumptions_newest_first() {
    let w = world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let record = |kind, text: &str, minutes: i64| {
        let ctx = Ctx {
            now: FIXED_NOW + time::Duration::minutes(minutes),
            ..w.owner_ctx.clone()
        };
        let input = RecordInput {
            kind,
            section_key: Some("audience".into()),
            text: text.into(),
        };
        let deps = w.deps.clone();
        async move { strategy::record(&deps, &ctx, input).await.unwrap() }
    };
    let first = record(RecordKind::Assumption, "öğrenciler gece çalışır", 1).await;
    record(RecordKind::Question, "kitle kim?", 2).await;
    let second = record(RecordKind::Assumption, "fiyat sabit", 3).await;
    record(RecordKind::Note, "not", 4).await;

    let draft = strategy::get(&w.deps, &w.owner_ctx)
        .await
        .unwrap()
        .draft
        .unwrap();
    let listed: Vec<_> = draft
        .assumptions
        .iter()
        .map(|e| (e.id, e.kind, e.text.as_str()))
        .collect();
    assert_eq!(
        listed,
        [
            (second, ConsultationKind::Assumption, "fiyat sabit"),
            (
                first,
                ConsultationKind::Assumption,
                "öğrenciler gece çalışır"
            ),
        ]
    );
    assert_eq!(
        draft.assumptions[0].section_key.as_deref(),
        Some("audience")
    );
    let wire = serde_json::to_value(&draft).unwrap();
    assert_eq!(wire["assumptions"][0]["kind"], "assumption");
    assert_eq!(wire["assumptions"][0]["text"], "fiyat sabit");

    // Every answer about the draft lists them; an approved version lists none.
    for (key, value) in complete_sections() {
        let out = strategy::write_section(&w.deps, &w.owner_ctx, key.to_owned(), value)
            .await
            .unwrap();
        assert_eq!(out.assumptions.len(), 2);
    }
    strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("instagram"))
        .await
        .unwrap();
    let submitted = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(submitted.assumptions, draft.assumptions);
    let out = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    assert!(out.assumptions.is_empty());
    let got = strategy::get(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(got.approved.unwrap().assumptions.is_empty());
}

#[tokio::test]
async fn get_shows_the_approved_version_and_the_draft_with_its_gaps() {
    let w = world().await;
    let none = strategy::get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!((none.approved, none.draft), (None, None));
    assert!(none.gaps.is_empty());

    let v1 = approved(&w).await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::write_section(&w.deps, &w.owner_ctx, "audience".into(), json!([]))
        .await
        .unwrap();

    let (_, rep) = w.member("rep").await;
    let out = strategy::get(&w.deps, &rep).await.unwrap();
    let approved = out.approved.unwrap();
    assert_eq!((approved.id, approved.number), (v1.id, 1));
    assert_eq!(approved.status, VersionStatus::Approved);
    assert!(approved.gaps.is_empty());
    let draft = out.draft.unwrap();
    assert_eq!((draft.number, draft.status), (2, VersionStatus::Draft));
    // The draft lost its segments, so its hypothesis names a segment that is gone too.
    let fields: Vec<&str> = out.gaps.iter().map(|g| g.field.as_str()).collect();
    assert_eq!(fields, ["audience", "hypotheses[0].segment_key"]);
    assert_eq!(draft.gaps, out.gaps);
}

// ---------------------------------------------------------------------------------------------
// start_consultation
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn start_consultation_opens_a_numbered_draft_with_a_started_note() {
    let w = world().await;
    let out = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    assert_eq!(out.number, 1);
    assert_eq!(out.status, VersionStatus::Draft);
    assert_eq!(out.sections, Sections::default());
    assert!(out.hypotheses.is_empty());
    assert_eq!(out.created_at, FIXED_NOW);
    assert_eq!(out.consultation_count, 1);
    assert!(!out.gaps.is_empty(), "an empty draft has gaps");

    let stored = w.version(out.id);
    assert_eq!(stored.created_by, w.owner_ctx.actor);
    let log = w.log(out.id);
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].kind, ConsultationKind::Note);
    assert_eq!(log[0].text, "consultation started");

    let entries = w.entries("strategy.start_consultation");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "strategy_version".into(),
            id: out.id.to_string(),
        })
    );
    assert_eq!(entries[0].strategy_version_id, None);
}

#[tokio::test]
async fn start_consultation_returns_the_open_draft_instead_of_a_second_one() {
    let w = world().await;
    let first = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let again = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    assert_eq!(again, first);
    assert_eq!(w.versions().len(), 1);
    assert_eq!(w.log(first.id).len(), 1);
    assert_eq!(w.entries("strategy.start_consultation").len(), 1);
}

#[tokio::test]
async fn start_consultation_copies_the_approved_version_with_its_hypotheses_kept() {
    let w = world().await;
    let v1 = approved(&w).await;
    let v2 = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    assert_eq!(v2.number, 2);
    assert_ne!(v2.id, v1.id);
    assert_eq!(v2.sections, v1.sections);
    assert_eq!(v2.hypotheses.len(), 1);
    assert_eq!(v2.hypotheses[0].id, v1.hypotheses[0].id);
    assert_eq!(v2.hypotheses[0].state, HypothesisState::Kept);
    assert!(v2.gaps.is_empty());
    // Under the approved version, which stays in force.
    let entry = &w.entries("strategy.start_consultation")[1];
    assert_eq!(entry.strategy_version_id, Some(v1.id.as_uuid()));
    assert_eq!(w.version(v1.id).status, VersionStatus::Approved);
}

#[tokio::test]
async fn rep_cannot_run_the_consultation() {
    let w = world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let (_, rep) = w.member("rep").await;
    let record = RecordInput {
        kind: RecordKind::Note,
        section_key: None,
        text: "not mine".into(),
    };
    let refusals = [
        strategy::start_consultation(&w.deps, &rep)
            .await
            .map(|_| ()),
        strategy::record(&w.deps, &rep, record).await.map(|_| ()),
        strategy::write_section(&w.deps, &rep, "paid_enabled".into(), json!(true))
            .await
            .map(|_| ()),
        strategy::set_hypotheses(&w.deps, &rep, json!([]))
            .await
            .map(|_| ()),
        strategy::submit(&w.deps, &rep).await.map(|_| ()),
    ];
    for r in refusals {
        let err = r.unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details, json!({ "permission": "team.manage" }));
    }
}

#[tokio::test]
async fn a_custom_role_with_team_manage_may_run_the_consultation_but_not_approve() {
    let w = world().await;
    roles::create(
        &w.deps,
        &w.owner_ctx,
        CreateRole {
            key: "strategist".into(),
            name: "Strategist".into(),
            permissions: vec!["workspace.read".into(), "team.manage".into()],
        },
    )
    .await
    .unwrap();
    let (_, strategist) = w.member("strategist").await;
    complete_draft(&w, &strategist).await;
    strategy::submit(&w.deps, &strategist).await.unwrap();
    let err = strategy::approve(&w.deps, &strategist, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details, json!({ "reason": "owner_or_manager" }));
}

// ---------------------------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn record_needs_a_draft() {
    let w = world().await;
    let input = RecordInput {
        kind: RecordKind::Question,
        section_key: None,
        text: "Ne satıyorsunuz?".into(),
    };
    let err = strategy::record(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "no draft");
    assert_eq!(err.details, json!({ "reason": "no_draft" }));
}

#[tokio::test]
async fn record_appends_each_kind_to_the_drafts_log() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let kinds = [
        (RecordKind::Question, ConsultationKind::Question),
        (RecordKind::Answer, ConsultationKind::Answer),
        (RecordKind::Assumption, ConsultationKind::Assumption),
        (RecordKind::Note, ConsultationKind::Note),
    ];
    for (kind, _) in kinds {
        strategy::record(
            &w.deps,
            &w.owner_ctx,
            RecordInput {
                kind,
                section_key: Some("audience".into()),
                text: "  Öğrenciler  ".into(),
            },
        )
        .await
        .unwrap();
    }
    let log = w.log(draft.id);
    assert_eq!(log.len(), 5);
    for (entry, (_, kind)) in log[1..].iter().zip(kinds) {
        assert_eq!(entry.kind, kind);
        assert_eq!(entry.section_key.as_deref(), Some("audience"));
        assert_eq!(entry.text, "Öğrenciler");
        assert_eq!(entry.actor, w.owner_ctx.actor);
        assert_eq!(entry.at, FIXED_NOW);
    }
}

#[tokio::test]
async fn record_checks_the_text_and_the_section_key() {
    let w = world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let cases = [
        (None, "   ".to_owned(), "text"),
        (None, "x".repeat(20_001), "text"),
        (Some("pillars".to_owned()), "ok".to_owned(), "section_key"),
    ];
    for (section_key, text, field) in cases {
        let input = RecordInput {
            kind: RecordKind::Note,
            section_key,
            text,
        };
        let err = strategy::record(&w.deps, &w.owner_ctx, input)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.details["field"], field);
    }
    // 20,000 characters (not bytes) is the most.
    let input = RecordInput {
        kind: RecordKind::Answer,
        section_key: None,
        text: "ğ".repeat(20_000),
    };
    strategy::record(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap();
}

#[tokio::test]
async fn record_payload_never_contains_the_text() {
    let w = world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let secret = "Bütçemiz aslında 2 milyon";
    let id = strategy::record(
        &w.deps,
        &w.owner_ctx,
        RecordInput {
            kind: RecordKind::Answer,
            section_key: Some("budget_frame".into()),
            text: secret.into(),
        },
    )
    .await
    .unwrap();
    let entries = w.entries("strategy.record");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({ "kind": "answer", "section_key": "budget_frame" })
    );
    let everything = serde_json::to_string(&w.ledger()).unwrap();
    assert!(!everything.contains(secret));
    assert!(!everything.contains("2 milyon"));
    // The text itself is in the consultation log.
    let entry = w
        .uow
        .snapshot()
        .consultation
        .into_iter()
        .find(|e| e.entry.id == id);
    assert_eq!(entry.unwrap().entry.text, secret);
}

// ---------------------------------------------------------------------------------------------
// write_section
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn write_section_needs_a_draft() {
    let w = world().await;
    let r =
        strategy::write_section(&w.deps, &w.owner_ctx, "paid_enabled".into(), json!(true)).await;
    assert_eq!(code(r), ErrorCode::Conflict);
}

#[tokio::test]
async fn write_section_refuses_an_unknown_section_key() {
    let w = world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let err = strategy::write_section(&w.deps, &w.owner_ctx, "pillars".into(), json!([]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.details["field"], "section_key");
}

#[tokio::test]
async fn write_section_parses_strictly_and_lists_every_unknown_key() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let value = json!({
        "lanes": [
            { "lane": "organic", "period": "monthly", "cap_minor": 0, "currency": "TRY" },
            { "lane": "paid", "period": "weekly", "cap_minor": 100, "currency": "TRY", "note": "x" },
        ],
        "total": 5,
    });
    let err = strategy::write_section(&w.deps, &w.owner_ctx, "budget_frame".into(), value)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(
        gap_fields(&err),
        ["budget_frame.total", "budget_frame.lanes[1].note"]
    );
    // A wrong type is a gap too.
    let err = strategy::write_section(&w.deps, &w.owner_ctx, "paid_enabled".into(), json!("yes"))
        .await
        .unwrap_err();
    assert_eq!(gap_fields(&err), ["paid_enabled"]);
    // Nothing was written.
    assert_eq!(w.version(draft.id).sections, Sections::default());
    assert_eq!(w.log(draft.id).len(), 1);
}

#[tokio::test]
async fn write_section_stores_the_section_and_reports_gaps_without_blocking() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let identity = json!({ "product": "Kahve", "voice": "sıcak", "positioning": "", "usp": "" });
    let out = strategy::write_section(&w.deps, &w.owner_ctx, "identity".into(), identity.clone())
        .await
        .unwrap();
    assert_eq!(out.sections.identity.product, "Kahve");
    assert_eq!(w.version(draft.id).sections.identity.voice, "sıcak");
    // Still incomplete: no segment, no channel, no hypothesis.
    let fields: Vec<&str> = out.gaps.iter().map(|g| g.field.as_str()).collect();
    assert_eq!(fields, ["audience", "channels", "hypotheses"]);

    let log = w.log(draft.id);
    let last = log.last().unwrap();
    assert_eq!(last.kind, ConsultationKind::SectionDraft);
    assert_eq!(last.section_key.as_deref(), Some("identity"));
    assert_eq!(serde_json::from_str::<Value>(&last.text).unwrap(), identity);
    assert_eq!(out.consultation_count, 2);

    let entries = w.entries("strategy.write_section");
    assert_eq!(
        entries[0].payload,
        json!({ "section_key": "identity", "gaps": 3 })
    );
}

#[tokio::test]
async fn editing_a_submitted_draft_withdraws_the_submission() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    let submitted = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(submitted.submitted_at, Some(FIXED_NOW));

    let out = strategy::write_section(&w.deps, &w.owner_ctx, "prohibitions".into(), json!([]))
        .await
        .unwrap();
    assert_eq!(out.submitted_at, None);
    assert_eq!(w.version(out.id).submitted_at, None);
    let r = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w)).await;
    assert_eq!(code(r), ErrorCode::Conflict);

    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("any"))
        .await
        .unwrap();
    assert_eq!(out.submitted_at, None);
}

#[tokio::test]
async fn recording_an_assumption_withdraws_a_pending_submission() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    let submitted = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let stamp = as_read(&w);
    assert_eq!(stamp.submitted_at, FIXED_NOW);

    // A question, an answer or a note leaves the submission standing.
    for kind in [RecordKind::Question, RecordKind::Answer, RecordKind::Note] {
        strategy::record(
            &w.deps,
            &w.owner_ctx,
            RecordInput {
                kind,
                section_key: None,
                text: "Teslimat süresi?".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(w.version(submitted.id).submitted_at, Some(FIXED_NOW));
    }
    assert!(w.entries("strategy.submission_withdrawn").is_empty());

    // An assumption changes what approval would accept: the submission is withdrawn with it.
    strategy::record(
        &w.deps,
        &w.owner_ctx,
        RecordInput {
            kind: RecordKind::Assumption,
            section_key: Some("audience".into()),
            text: "Müşteriler İstanbul'da".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(w.version(submitted.id).submitted_at, None);
    let withdrawn = w.entries("strategy.submission_withdrawn");
    assert_eq!(withdrawn.len(), 1);
    assert_eq!(
        withdrawn[0].payload,
        json!({ "version_id": submitted.id, "reason": "assumption_recorded" })
    );
    assert_eq!(
        withdrawn[0].subject,
        Some(Subject {
            kind: "strategy_version".into(),
            id: submitted.id.to_string(),
        })
    );

    // Approving with the stamp read before the assumption is refused.
    let r = strategy::approve(&w.deps, &w.owner_ctx, stamp).await;
    assert_eq!(code(r), ErrorCode::Conflict);
    assert_eq!(w.version(submitted.id).status, VersionStatus::Draft);

    // An assumption on a draft that is not submitted withdraws nothing.
    strategy::record(
        &w.deps,
        &w.owner_ctx,
        RecordInput {
            kind: RecordKind::Assumption,
            section_key: None,
            text: "Kargo ücretsiz".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(w.entries("strategy.submission_withdrawn").len(), 1);
}

// ---------------------------------------------------------------------------------------------
// set_hypotheses
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn set_hypotheses_adds_new_ones_with_fresh_ids() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let mut two = one_hypothesis("instagram");
    two.as_array_mut().unwrap().push(json!({
        "title": "Kahve molası", "segment_key": "students", "angle": "ucuz",
        "channel": "any", "metric": "ziyaret", "prior_confidence": 0.3,
    }));
    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, two)
        .await
        .unwrap();
    assert_eq!(out.hypotheses.len(), 2);
    assert!(
        out.hypotheses
            .iter()
            .all(|h| h.state == HypothesisState::Added)
    );
    assert_ne!(out.hypotheses[0].id, out.hypotheses[1].id);
    assert_eq!(out.hypotheses[1].title, "Kahve molası");
    assert_eq!(w.hypotheses(draft.id), out.hypotheses);
    assert_eq!(
        w.entries("strategy.set_hypotheses")[0].payload,
        json!({ "added": 2, "retired": 0, "kept": 0 })
    );

    // Listing an added one again by its id keeps it added; leaving one out drops it.
    let first = &out.hypotheses[0];
    let again = json!([{
        "id": first.id, "title": "Sınav haftası (gece)", "segment_key": "students",
        "angle": "gece açık", "channel": "instagram", "metric": "dm", "prior_confidence": 0.7,
    }]);
    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, again)
        .await
        .unwrap();
    assert_eq!(out.hypotheses.len(), 1);
    assert_eq!(out.hypotheses[0].id, first.id);
    assert_eq!(out.hypotheses[0].state, HypothesisState::Added);
    assert_eq!(out.hypotheses[0].title, "Sınav haftası (gece)");
}

#[tokio::test]
async fn set_hypotheses_keeps_retires_and_adds_against_the_approved_version() {
    let w = world().await;
    let v1 = approved(&w).await;
    let kept_id = v1.hypotheses[0].id;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    // Another hypothesis approved in version 1 as well: approve a second version holding two.
    let two = json!([
        { "id": kept_id, "title": "Sınav haftası", "segment_key": "students", "angle": "gece açık",
          "channel": "instagram", "metric": "dm", "prior_confidence": 0.6 },
        { "title": "Kahve molası", "segment_key": "students", "angle": "ucuz",
          "channel": "any", "metric": "ziyaret", "prior_confidence": 0.3 },
    ]);
    strategy::set_hypotheses(&w.deps, &w.owner_ctx, two)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let v2 = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    let retired_id = v2.hypotheses[1].id;

    // Version 3 keeps (and edits) the first, leaves the second out and adds a third.
    let v3 = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let input = json!([
        { "id": kept_id, "title": "Sınav haftası", "segment_key": "students", "angle": "sabah",
          "channel": "instagram", "metric": "dm", "prior_confidence": 0.8 },
        { "title": "Termos", "segment_key": "students", "angle": "hediye",
          "channel": "instagram", "metric": "satış", "prior_confidence": 0.2 },
    ]);
    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap();
    let states: Vec<(HypothesisId, HypothesisState)> =
        out.hypotheses.iter().map(|h| (h.id, h.state)).collect();
    assert_eq!(states.len(), 3);
    assert_eq!(states[0], (kept_id, HypothesisState::Kept));
    assert_eq!(out.hypotheses[0].angle, "sabah");
    assert_eq!(states[1].1, HypothesisState::Added);
    assert_eq!(states[2], (retired_id, HypothesisState::Retired));
    // The retired one keeps what it was.
    assert_eq!(out.hypotheses[2].title, "Kahve molası");
    assert_eq!(w.hypotheses(v3.id), out.hypotheses);
    assert_eq!(
        w.entries("strategy.set_hypotheses").last().unwrap().payload,
        json!({ "added": 1, "retired": 1, "kept": 1 })
    );
    // The approved version is untouched.
    assert_eq!(w.hypotheses(v2.id), v2.hypotheses);

    // Listing the retired one again brings it back as kept.
    let input = json!([
        { "id": retired_id, "title": "Kahve molası", "segment_key": "students", "angle": "ucuz",
          "channel": "any", "metric": "ziyaret", "prior_confidence": 0.3 },
    ]);
    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap();
    let states: Vec<(HypothesisId, HypothesisState)> =
        out.hypotheses.iter().map(|h| (h.id, h.state)).collect();
    assert_eq!(
        states,
        [
            (retired_id, HypothesisState::Kept),
            (kept_id, HypothesisState::Retired)
        ]
    );
}

#[tokio::test]
async fn set_hypotheses_refuses_unknown_keys_unknown_ids_duplicates_and_bad_confidence() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let err = strategy::set_hypotheses(
        &w.deps,
        &w.owner_ctx,
        json!([{ "title": "t", "colour": "red" }]),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(gap_fields(&err), ["hypotheses[0].colour"]);

    let unknown = HypothesisId::new_v7();
    let input = json!([
        { "id": unknown, "title": "a", "prior_confidence": 0.5 },
        { "title": "b", "prior_confidence": 1.5 },
    ]);
    let err = strategy::set_hypotheses(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(
        gap_fields(&err),
        ["hypotheses[0].id", "hypotheses[1].prior_confidence"]
    );

    let out = strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("instagram"))
        .await
        .unwrap();
    let id = out.hypotheses[0].id;
    let twice = json!([
        { "id": id, "title": "a", "prior_confidence": 0.5 },
        { "id": id, "title": "b", "prior_confidence": 0.5 },
    ]);
    let err = strategy::set_hypotheses(&w.deps, &w.owner_ctx, twice)
        .await
        .unwrap_err();
    assert_eq!(gap_fields(&err), ["hypotheses[1].id"]);
    assert_eq!(w.hypotheses(draft.id), out.hypotheses);
}

// ---------------------------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn submit_refuses_gaps_with_validation_listing_them() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let err = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(
        gap_fields(&err),
        ["identity.product", "audience", "channels", "hypotheses"]
    );
    assert_eq!(w.version(draft.id).submitted_at, None);
    assert!(w.entries("strategy.submit").is_empty());
}

#[tokio::test]
async fn a_channel_narrowed_to_a_capability_group_needs_the_group() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    let channels = |group_id: Value| json!([{ "channel": "instagram", "rationale": "genç kitle", "group_id": group_id }]);
    let missing = uuid::Uuid::from_u128(4242);
    let out = strategy::write_section(
        &w.deps,
        &w.owner_ctx,
        "channels".into(),
        channels(json!(missing)),
    )
    .await
    .unwrap();
    let fields: Vec<&str> = out.gaps.iter().map(|g| g.field.as_str()).collect();
    assert_eq!(fields, ["channels[0].group_id"]);
    let err = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap_err();
    assert_eq!(gap_fields(&err), ["channels[0].group_id"]);

    // A group of the workspace will do.
    let group = groups::create(&w.deps, &w.owner_ctx, "Marka A".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let out = strategy::write_section(
        &w.deps,
        &w.owner_ctx,
        "channels".into(),
        channels(json!(group)),
    )
    .await
    .unwrap();
    assert!(out.gaps.is_empty(), "{:?}", out.gaps);
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
}

#[tokio::test]
async fn submit_marks_the_draft_submitted() {
    let w = world().await;
    let draft = complete_draft(&w, &w.owner_ctx).await;
    assert!(draft.gaps.is_empty(), "{:?}", draft.gaps);
    let out = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(out.submitted_at, Some(FIXED_NOW));
    assert_eq!(out.status, VersionStatus::Draft);
    assert_eq!(w.version(draft.id).submitted_at, Some(FIXED_NOW));
    let last = w.log(draft.id).pop().unwrap();
    assert_eq!(last.kind, ConsultationKind::Submitted);
    assert_eq!(
        w.entries("strategy.submit")[0].payload,
        json!({ "number": 1 })
    );
}

#[tokio::test]
async fn a_chosen_channel_must_be_a_kind_the_workspace_has() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    let deps = w.with_channels(&["mailbox"]);
    let err = strategy::submit(&deps, &w.owner_ctx).await.unwrap_err();
    assert_eq!(
        gap_fields(&err),
        ["channels[0].channel", "hypotheses[0].channel"]
    );
    assert!(
        err.details["gaps"][0]["message"]
            .as_str()
            .unwrap()
            .contains("no capability")
    );
}

#[tokio::test]
async fn hypothesis_channel_must_be_a_chosen_channel_or_any() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    // The workspace has a mailbox, but the strategy chose only instagram.
    strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("mailbox"))
        .await
        .unwrap();
    let err = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(gap_fields(&err), ["hypotheses[0].channel"]);
    assert_eq!(
        err.details["gaps"][0]["message"],
        "\"mailbox\" is not one of the strategy's channels"
    );
    // A kind the workspace lacks altogether says so.
    strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("tiktok"))
        .await
        .unwrap();
    let err = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap_err();
    assert_eq!(gap_fields(&err), ["hypotheses[0].channel"]);
    assert!(
        err.details["gaps"][0]["message"]
            .as_str()
            .unwrap()
            .contains("no capability")
    );
    // `any` is always accepted.
    strategy::set_hypotheses(&w.deps, &w.owner_ctx, one_hypothesis("any"))
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
}

// ---------------------------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn approve_needs_a_submitted_draft() {
    let w = world().await;
    let err = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, err.details),
        (ErrorCode::Conflict, json!({ "reason": "no_draft" }))
    );
    complete_draft(&w, &w.owner_ctx).await;
    let err = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "not submitted");
    assert_eq!(err.details, json!({ "reason": "not_submitted" }));
}

#[tokio::test]
async fn approve_refuses_a_changed_draft() {
    let w = world().await;
    let draft = complete_draft(&w, &w.owner_ctx).await;
    let read = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let seen = ApproveInput {
        version_id: read.id,
        submitted_at: read.submitted_at.unwrap(),
    };
    let stands = |submitted_at: OffsetDateTime| {
        json!({
            "version_id": draft.id,
            "submitted_at": submitted_at.format(&Rfc3339).unwrap(),
        })
    };

    // Another draft than the one read.
    let other = ApproveInput {
        version_id: StrategyVersionId::new_v7(),
        ..seen
    };
    let err = strategy::approve(&w.deps, &w.owner_ctx, other)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "the draft changed since you read it");
    assert_eq!(err.details, stands(FIXED_NOW));

    // The same draft, submitted again since it was read.
    let later = FIXED_NOW + time::Duration::minutes(5);
    let resubmitter = Ctx {
        now: later,
        ..w.owner_ctx.clone()
    };
    strategy::submit(&w.deps, &resubmitter).await.unwrap();
    let err = strategy::approve(&w.deps, &w.owner_ctx, seen)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.details, stands(later));
    assert_eq!(w.version(draft.id).status, VersionStatus::Draft);
    assert!(w.entries("strategy.approve").is_empty());

    // The draft as it now stands is approved.
    let now = ApproveInput {
        submitted_at: later,
        ..seen
    };
    let out = strategy::approve(&w.deps, &w.owner_ctx, now).await.unwrap();
    assert_eq!(out.status, VersionStatus::Approved);
}

#[tokio::test]
async fn approve_input_reads_the_submission_time_as_rfc_3339() {
    let id = StrategyVersionId::new_v7();
    let input = ApproveInput::parse(id, "2026-10-22T09:30:00.123456Z").unwrap();
    assert_eq!(input.version_id, id);
    assert_eq!(input.submitted_at.microsecond(), 123_456);
    let err = ApproveInput::parse(id, "yesterday").unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.details["field"], "submitted_at");
}

#[tokio::test]
async fn approve_refuses_gaps_with_validation_listing_them() {
    let w = world().await;
    // A draft submitted with no hypothesis at all, as the store holds it.
    complete_draft(&w, &w.owner_ctx).await;
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let draft = strategy::get(&w.deps, &w.owner_ctx)
        .await
        .unwrap()
        .draft
        .unwrap();
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.hypotheses().replace_all(draft.id, vec![]).await.unwrap();
        t.commit().await.unwrap();
    }
    let err = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(gap_fields(&err), ["hypotheses"]);

    // A hypothesis whose channel the workspace no longer has (its capability went away after
    // the submission).
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.hypotheses()
            .replace_all(draft.id, draft.hypotheses.clone())
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let deps = w.with_channels(&["mailbox"]);
    let err = strategy::approve(&deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(
        gap_fields(&err),
        ["channels[0].channel", "hypotheses[0].channel"]
    );
    assert_eq!(w.version(draft.id).status, VersionStatus::Draft);
    assert!(w.entries("strategy.approve").is_empty());
}

#[tokio::test]
async fn approve_makes_the_draft_the_strategy_in_force() {
    let w = world().await;
    let draft = complete_draft(&w, &w.owner_ctx).await;
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let out = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    assert_eq!(out.id, draft.id);
    assert_eq!(out.status, VersionStatus::Approved);
    assert_eq!(out.approved_at, Some(FIXED_NOW));
    assert_eq!(
        out.approved_by_email.as_ref().map(Email::as_str),
        Some("owner@acme.example")
    );
    assert!(out.gaps.is_empty());
    let stored = w.version(draft.id);
    assert_eq!(stored.approved_by, Some(w.owner));
    assert_eq!(
        w.log(draft.id).pop().unwrap().kind,
        ConsultationKind::Approved
    );

    let entry = &w.entries("strategy.approve")[0];
    assert_eq!(entry.payload, json!({ "number": 1, "hypotheses": 1 }));
    assert_eq!(entry.strategy_version_id, Some(draft.id.as_uuid()));
    let none = strategy::get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(none.draft, None);
    assert_eq!(none.approved.unwrap().id, draft.id);
}

#[tokio::test]
async fn approve_archives_the_previous_version_in_the_same_transaction() {
    let w = world().await;
    let v1 = approved(&w).await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    w.spy.take();
    let v2 = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    let calls = w.spy.take();
    // One bundle, one commit, both moves inside it.
    assert_eq!(
        calls.iter().filter(|c| *c == "open").count(),
        1,
        "{calls:?}"
    );
    assert_eq!(calls.last().map(String::as_str), Some("commit"));
    assert!(calls.contains(&"strategy.set_status(archived)".to_owned()));

    let old = w.version(v1.id);
    assert_eq!(old.status, VersionStatus::Archived);
    assert_eq!(old.archived_at, Some(FIXED_NOW));
    assert_eq!(w.version(v2.id).status, VersionStatus::Approved);
    let approved: Vec<_> = w
        .versions()
        .into_iter()
        .filter(|v| v.status == VersionStatus::Approved)
        .collect();
    assert_eq!(approved.len(), 1);
    assert_eq!(w.log(v1.id).pop().unwrap().kind, ConsultationKind::Archived);
}

#[tokio::test]
async fn approve_locks_the_draft_before_archiving() {
    let w = world().await;
    approved(&w).await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    w.spy.take();
    strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    let calls = w.spy.take();
    let at = |call: &str| {
        calls
            .iter()
            .position(|c| c == call)
            .unwrap_or_else(|| panic!("{call} not in {calls:?}"))
    };
    assert!(at("strategy.lock_draft") < at("strategy.set_status(archived)"));
    assert!(at("strategy.set_status(archived)") < at("strategy.set_status(approved)"));
}

#[tokio::test]
async fn second_approval_loses_with_conflict() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    let draft = strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    w.spy.approval_loses.store(true, Ordering::SeqCst);
    let err = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "another approval won");
    assert_eq!(err.details, json!({ "reason": "another_approval_won" }));
    assert_eq!(w.version(draft.id).status, VersionStatus::Draft);
    assert!(w.entries("strategy.approve").is_empty());
}

#[tokio::test]
async fn a_version_moved_by_another_transaction_is_conflict() {
    let w = world().await;
    let v1 = approved(&w).await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    w.spy.already_moved.store(true, Ordering::SeqCst);
    let err = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "the version has already moved");
    let err = strategy::archive(&w.deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "the version has already moved");
}

#[tokio::test]
async fn rep_cannot_approve() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let (_, rep) = w.member("rep").await;
    let err = strategy::approve(&w.deps, &rep, as_read(&w))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details, json!({ "reason": "owner_or_manager" }));
    // No role known never counts.
    let nobody = Ctx {
        role_key: None,
        ..w.owner_ctx.clone()
    };
    assert_eq!(
        code(strategy::approve(&w.deps, &nobody, as_read(&w)).await),
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn manager_can_approve_and_is_named_as_approver() {
    let w = world().await;
    complete_draft(&w, &w.owner_ctx).await;
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let (manager, ctx) = w.member("manager").await;
    let out = strategy::approve(&w.deps, &ctx, as_read(&w)).await.unwrap();
    assert_eq!(w.version(out.id).approved_by, Some(manager));
    assert_eq!(
        out.approved_by_email.as_ref().map(Email::as_str),
        Some("manager@acme.example")
    );
}

#[tokio::test]
async fn owner_key_without_team_manage_is_refused_everywhere() {
    let w = world().await;
    let agent = w.owner_agent(&["workspace.read"]).await;
    assert_eq!(agent.role_key.as_deref(), Some("owner"));
    let record = RecordInput {
        kind: RecordKind::Note,
        section_key: None,
        text: "n".into(),
    };
    let refusals = [
        strategy::start_consultation(&w.deps, &agent)
            .await
            .map(|_| ()),
        strategy::record(&w.deps, &agent, record).await.map(|_| ()),
        strategy::write_section(&w.deps, &agent, "paid_enabled".into(), json!(true))
            .await
            .map(|_| ()),
        strategy::set_hypotheses(&w.deps, &agent, json!([]))
            .await
            .map(|_| ()),
        strategy::submit(&w.deps, &agent).await.map(|_| ()),
        strategy::approve(&w.deps, &agent, as_read(&w))
            .await
            .map(|_| ()),
        strategy::archive(&w.deps, &agent, archiving(StrategyVersionId::new_v7())).await,
    ];
    for r in refusals {
        let err = r.unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details, json!({ "permission": "team.manage" }));
    }
    assert!(w.ledger().is_empty());
    assert!(w.versions().is_empty());
    // It may still read.
    strategy::get(&w.deps, &agent).await.unwrap();
}

#[tokio::test]
async fn manager_role_without_team_manage_cannot_approve() {
    let w = world().await;
    let v1 = approved(&w).await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let (_, manager) = w.member("manager").await;
    let agent = w.agent(&manager, &["workspace.read"]).await;
    assert_eq!(agent.role_key.as_deref(), Some("manager"));
    for err in [
        strategy::approve(&w.deps, &agent, as_read(&w))
            .await
            .map(|_| ())
            .unwrap_err(),
        strategy::archive(&w.deps, &agent, archiving(v1.id))
            .await
            .unwrap_err(),
    ] {
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.details, json!({ "permission": "team.manage" }));
    }
    assert_eq!(w.version(v1.id).status, VersionStatus::Approved);
    assert_eq!(w.entries("strategy.approve").len(), 1);
}

#[tokio::test]
async fn agent_with_owner_key_can_approve() {
    let w = world().await;
    let agent = w.owner_agent(&["workspace.read", "team.manage"]).await;
    complete_draft(&w, &agent).await;
    strategy::submit(&w.deps, &agent).await.unwrap();
    let out = strategy::approve(&w.deps, &agent, as_read(&w))
        .await
        .unwrap();
    assert_eq!(out.status, VersionStatus::Approved);
    // On the issuer's authority: the owner is the approver.
    assert_eq!(w.version(out.id).approved_by, Some(w.owner));
    let entry = &w.entries("strategy.approve")[0];
    assert_eq!(entry.actor, agent.actor);
    assert_eq!(w.log(out.id).pop().unwrap().actor, agent.actor);
}

// ---------------------------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn archive_requires_confirm() {
    let w = world().await;
    let v1 = approved(&w).await;
    let input = ArchiveInput {
        version_id: v1.id,
        confirm: false,
    };
    let err = strategy::archive(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.details, json!({ "field": "confirm" }));
    assert_eq!(w.version(v1.id).status, VersionStatus::Approved);
    assert!(w.entries("strategy.archive").is_empty());
}

#[tokio::test]
async fn archive_closes_the_strategy() {
    let w = world().await;
    let v1 = approved(&w).await;
    strategy::archive(&w.deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap();
    let stored = w.version(v1.id);
    assert_eq!(stored.status, VersionStatus::Archived);
    assert_eq!(stored.archived_at, Some(FIXED_NOW));
    assert_eq!(w.log(v1.id).pop().unwrap().kind, ConsultationKind::Archived);
    let entry = &w.entries("strategy.archive")[0];
    assert_eq!(
        entry.payload,
        json!({ "number": 1, "version_id": v1.id.to_string() })
    );
    assert_eq!(entry.strategy_version_id, Some(v1.id.as_uuid()));
    assert_eq!(
        strategy::get(&w.deps, &w.owner_ctx).await.unwrap().approved,
        None
    );
    // Nothing is left to archive.
    let err = strategy::archive(&w.deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, err.details),
        (
            ErrorCode::Conflict,
            json!({ "reason": "no_approved_version" })
        )
    );
}

#[tokio::test]
async fn archive_leaves_an_open_draft_alone() {
    let w = world().await;
    let v1 = approved(&w).await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::archive(&w.deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap();
    assert_eq!(w.version(draft.id).status, VersionStatus::Draft);
}

#[tokio::test]
async fn archive_refuses_when_the_approved_version_changed() {
    let w = world().await;
    let v1 = approved(&w).await;
    // Version 2 is approved after the caller looked: an archive naming version 1 must not take
    // down version 2.
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::submit(&w.deps, &w.owner_ctx).await.unwrap();
    let v2 = strategy::approve(&w.deps, &w.owner_ctx, as_read(&w))
        .await
        .unwrap();
    let err = strategy::archive(&w.deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.message, "the approved version changed");
    assert_eq!(
        err.details,
        json!({ "approved_version_id": v2.id.to_string() })
    );
    assert_eq!(w.version(v2.id).status, VersionStatus::Approved);
    assert!(w.entries("strategy.archive").is_empty());
    // Naming the version in force archives it.
    strategy::archive(&w.deps, &w.owner_ctx, archiving(v2.id))
        .await
        .unwrap();
    assert_eq!(w.version(v2.id).status, VersionStatus::Archived);
}

#[tokio::test]
async fn only_owner_or_manager_may_archive() {
    let w = world().await;
    let v1 = approved(&w).await;
    let (_, rep) = w.member("rep").await;
    let err = strategy::archive(&w.deps, &rep, archiving(v1.id))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details, json!({ "reason": "owner_or_manager" }));
    let (_, manager) = w.member("manager").await;
    strategy::archive(&w.deps, &manager, archiving(v1.id))
        .await
        .unwrap();
}

#[tokio::test]
async fn archive_calls_the_hook_after_commit() {
    let w = world().await;
    let v1 = approved(&w).await;
    let hook = HookSpy {
        uow: w.uow.clone(),
        seen: Arc::default(),
    };
    let deps = Deps {
        file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
        media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
        files: Arc::new(jt_app::ports::files::UnavailableFileStore),
        transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
        archived_hook: Arc::new(hook.clone()),
        ..w.deps.clone()
    };
    strategy::archive(&deps, &w.owner_ctx, archiving(v1.id))
        .await
        .unwrap();
    assert_eq!(
        *hook.seen.lock().unwrap(),
        [(w.ws, v1.id, Some(VersionStatus::Archived))]
    );
    // A refused archive tells nobody.
    let _ = strategy::archive(&deps, &w.owner_ctx, archiving(v1.id)).await;
    assert_eq!(hook.seen.lock().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Reading versions and the log
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_versions_is_newest_first() {
    let w = world().await;
    let v1 = approved(&w).await;
    let v2 = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let (_, rep) = w.member("rep").await;
    let list = strategy::list_versions(&w.deps, &rep).await.unwrap();
    let rows: Vec<_> = list
        .iter()
        .map(|v| (v.id, v.number, v.status, v.approved_at, v.archived_at))
        .collect();
    assert_eq!(
        rows,
        [
            (v2.id, 2, VersionStatus::Draft, None, None),
            (v1.id, 1, VersionStatus::Approved, Some(FIXED_NOW), None),
        ]
    );
    let nobody = human(w.ws, w.owner, "owner", BTreeSet::new());
    assert_eq!(
        code(strategy::list_versions(&w.deps, &nobody).await),
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn consultation_pages_the_log_newest_first() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    for text in ["bir", "iki", "üç"] {
        strategy::record(
            &w.deps,
            &w.owner_ctx,
            RecordInput {
                kind: RecordKind::Note,
                section_key: None,
                text: text.into(),
            },
        )
        .await
        .unwrap();
    }
    let (_, rep) = w.member("rep").await;
    let page = strategy::consultation(&w.deps, &rep, draft.id, 2, None)
        .await
        .unwrap();
    let texts: Vec<&str> = page.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(texts, ["üç", "iki"]);
    let last = page.last().unwrap();
    let rest = strategy::consultation(&w.deps, &rep, draft.id, 10, Some((last.at, last.id)))
        .await
        .unwrap();
    let texts: Vec<&str> = rest.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(texts, ["bir", "consultation started"]);

    let nobody = human(w.ws, w.owner, "owner", BTreeSet::new());
    assert_eq!(
        code(strategy::consultation(&w.deps, &nobody, draft.id, 10, None).await),
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn another_workspaces_version_is_not_found() {
    let w = world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let other = auth::register(
        &w.deps,
        RegisterInput {
            email: "owner@other.example".into(),
            password: "correct horse battery".into(),
            display_name: "Other".into(),
            workspace_name: "Other".into(),
        },
    )
    .await
    .unwrap();
    let ctx = human(
        other.me.current_workspace.unwrap(),
        other.me.user_id,
        "owner",
        SystemRole::Owner.permissions(),
    );
    let r = strategy::consultation(&w.deps, &ctx, draft.id, 10, None).await;
    assert_eq!(code(r), ErrorCode::NotFound);
    assert!(
        strategy::list_versions(&w.deps, &ctx)
            .await
            .unwrap()
            .is_empty()
    );
}

// ---------------------------------------------------------------------------------------------
// Across the use cases
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn every_draft_mutation_locks_the_draft() {
    let w = world().await;
    approved(&w).await;
    type Mutation<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>;
    let world = &w;
    let deps = &w.deps;
    let ctx = &w.owner_ctx;
    let mutations: Vec<(&str, Mutation<'_>)> = vec![
        (
            "start_consultation",
            Box::pin(async move {
                strategy::start_consultation(deps, ctx).await.unwrap();
            }),
        ),
        (
            "record",
            Box::pin(async move {
                let input = RecordInput {
                    kind: RecordKind::Question,
                    section_key: None,
                    text: "?".into(),
                };
                strategy::record(deps, ctx, input).await.unwrap();
            }),
        ),
        (
            "write_section",
            Box::pin(async move {
                strategy::write_section(deps, ctx, "paid_enabled".into(), json!(false))
                    .await
                    .unwrap();
            }),
        ),
        (
            "set_hypotheses",
            Box::pin(async move {
                strategy::set_hypotheses(deps, ctx, one_hypothesis("instagram"))
                    .await
                    .unwrap();
            }),
        ),
        (
            "submit",
            Box::pin(async move {
                strategy::submit(deps, ctx).await.unwrap();
            }),
        ),
        (
            "approve",
            Box::pin(async move {
                // Read past the spy, so that only the approval's own calls are logged.
                strategy::approve(deps, ctx, as_read(world)).await.unwrap();
            }),
        ),
        (
            "archive",
            Box::pin(async move {
                // Read past the spy, so that only the archive's own calls are logged.
                let approved = world
                    .versions()
                    .into_iter()
                    .find(|v| v.status == VersionStatus::Approved)
                    .unwrap();
                strategy::archive(deps, ctx, archiving(approved.id))
                    .await
                    .unwrap();
            }),
        ),
    ];
    for (name, mutation) in mutations {
        w.spy.take();
        mutation.await;
        let calls = w.spy.take();
        let strategy_calls: Vec<&str> = calls
            .iter()
            .map(String::as_str)
            .filter(|c| *c != "open" && *c != "commit")
            .collect();
        if matches!(name, "approve" | "archive") {
            assert_eq!(
                &strategy_calls[..2],
                &["strategy.lock_draft", "strategy.lock_execution_frame"],
                "{name}: {calls:?}"
            );
        } else {
            assert_eq!(
                strategy_calls.first(),
                Some(&"strategy.lock_draft"),
                "{name}: {calls:?}"
            );
        }
        assert!(
            strategy_calls.iter().any(|c| WRITES.contains(c)),
            "{name} wrote nothing: {calls:?}"
        );
        assert_eq!(
            calls.iter().filter(|c| *c == "open").count(),
            1,
            "{name}: {calls:?}"
        );
    }
}

#[tokio::test]
async fn every_mutation_writes_one_ledger_entry_about_its_version() {
    let w = world().await;
    let v1 = approved(&w).await;
    let ledger = w.ledger();
    let actions: Vec<&str> = ledger.iter().map(|e| e.action.as_str()).collect();
    let expected: Vec<&str> = std::iter::once("strategy.start_consultation")
        .chain(std::iter::repeat_n("strategy.write_section", 8))
        .chain([
            "strategy.set_hypotheses",
            "strategy.submit",
            "strategy.approve",
        ])
        .collect();
    assert_eq!(actions, expected);
    for entry in &ledger {
        assert_eq!(
            entry.subject,
            Some(Subject {
                kind: "strategy_version".into(),
                id: v1.id.to_string(),
            }),
            "{}",
            entry.action.as_str()
        );
        assert_eq!(entry.actor, w.owner_ctx.actor);
        assert_eq!(entry.at, FIXED_NOW);
    }
    // Before the approval there was no strategy in force; the approval names the new one.
    let (approval, before) = ledger.split_last().unwrap();
    assert!(before.iter().all(|e| e.strategy_version_id.is_none()));
    assert_eq!(approval.strategy_version_id, Some(v1.id.as_uuid()));

    // While version 1 is in force, work on version 2 is recorded under it.
    let v2 = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    strategy::write_section(&w.deps, &w.owner_ctx, "paid_enabled".into(), json!(false))
        .await
        .unwrap();
    let last = w.ledger().pop().unwrap();
    assert_eq!(last.strategy_version_id, Some(v1.id.as_uuid()));
    assert_eq!(last.subject.unwrap().id, v2.id.to_string());
}
