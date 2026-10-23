//! The in-memory tables, the checks shared by the bundles, and the unit of work with its
//! transactions.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    AgentConnectionRow, ApiKeyRow, LedgerRow, MembershipRow, MembershipView, OAuthPendingRow,
    OperatorRow, PlatformRepos, PlatformSessionRow, ProbeRun, SessionRow, TenantRepos, UnitOfWork,
    UserRepos, UserRow, WorkspacePolicy, WorkspaceRow,
};
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetSpend, Capability, CapabilityGroup, CapabilityGroupId,
    CapabilityId,
};
use jt_connector::InboundEvent;
use jt_ledger::{Actor, LedgerEntry};
use jt_strategy::{
    ConsultationEntry, Hypothesis, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{
    MembershipId, MembershipStatus, RoleDef, RoleId, SystemRole, UserId, WorkspaceId,
};
use time::OffsetDateTime;

use super::platform::MemPlatform;
use super::tenant::MemTenant;
use super::user::MemUser;

/// A role together with the workspace it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRole {
    pub workspace_id: WorkspaceId,
    pub role: RoleDef,
}

/// A hypothesis together with the version (and workspace) it belongs to and its place in the
/// version's list.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredHypothesis {
    pub workspace_id: WorkspaceId,
    pub version_id: StrategyVersionId,
    pub position: i32,
    pub hypothesis: Hypothesis,
}

/// A consultation entry together with the workspace it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredConsultationEntry {
    pub workspace_id: WorkspaceId,
    pub entry: ConsultationEntry,
}

/// A capability together with its sealed credentials. The stored `capability` keeps
/// `has_sealed_config` false and `budget_item_ids` empty: reads derive both, from `sealed` and
/// from the budget links, as `jt_pg` does.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCapability {
    pub capability: Capability,
    pub sealed: Option<Vec<u8>>,
    pub iys_sealed: Option<Vec<u8>>,
}

/// A capability group together with when it was created.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCapabilityGroup {
    pub group: CapabilityGroup,
    pub created_at: OffsetDateTime,
}

/// One capability in one group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredGroupMember {
    pub workspace_id: WorkspaceId,
    pub group_id: CapabilityGroupId,
    pub capability_id: CapabilityId,
}

/// One capability spending from one budget item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredBudgetLink {
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub budget_item_id: BudgetItemId,
}

/// An inbound event together with its raw body, as received (`None` once purged).
#[derive(Clone, Debug, PartialEq)]
pub struct StoredInboundEvent {
    pub event: InboundEvent,
    pub raw: Option<Vec<u8>>,
}

/// An outbound row plus the original provider-job and status views used by job assertions.
/// Both views are updated together when a delivery report is recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredOutboundJob {
    pub row: jt_app::ports::compliance::OutboundJobRow,
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub job_id: String,
    pub status: Option<jt_app::ports::connectors::DeliveryStatus>,
}

/// A workspace's policies together with when they were last set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredWorkspacePolicy {
    pub workspace_id: WorkspaceId,
    pub policy: WorkspacePolicy,
    pub updated_at: OffsetDateTime,
}

/// Every table, in insertion order.
#[derive(Clone, Debug, Default)]
pub struct MemState {
    pub inbox: super::inbox::MemInbox,
    pub workspaces: Vec<WorkspaceRow>,
    pub users: Vec<UserRow>,
    pub sessions: Vec<SessionRow>,
    pub roles: Vec<StoredRole>,
    pub memberships: Vec<MembershipRow>,
    pub api_keys: Vec<ApiKeyRow>,
    pub agent_connections: Vec<AgentConnectionRow>,
    pub ledger: Vec<LedgerRow>,
    pub operators: Vec<OperatorRow>,
    pub platform_sessions: Vec<PlatformSessionRow>,
    pub strategy_versions: Vec<StrategyVersion>,
    pub hypotheses: Vec<StoredHypothesis>,
    pub studio_learning: Vec<(WorkspaceId, jt_strategy::HypothesisId, String, f32)>,
    pub consultation: Vec<StoredConsultationEntry>,
    pub capabilities: Vec<StoredCapability>,
    pub capability_groups: Vec<StoredCapabilityGroup>,
    pub capability_group_members: Vec<StoredGroupMember>,
    pub budget_items: Vec<BudgetItem>,
    pub capability_budget_links: Vec<StoredBudgetLink>,
    pub budget_spend: Vec<BudgetSpend>,
    pub workspace_policies: Vec<StoredWorkspacePolicy>,
    pub inbound_events: Vec<StoredInboundEvent>,
    pub oauth_pending: Vec<OAuthPendingRow>,
    pub probe_runs: Vec<ProbeRun>,
    pub outbound_jobs: Vec<StoredOutboundJob>,
}

impl MemState {
    pub(super) fn workspace(&self, ws: WorkspaceId) -> Option<&WorkspaceRow> {
        self.workspaces.iter().find(|w| w.id == ws)
    }

    pub(super) fn user(&self, id: UserId) -> Option<&UserRow> {
        self.users.iter().find(|u| u.id == id)
    }

    pub(super) fn role_in(&self, ws: WorkspaceId, id: RoleId) -> Option<&RoleDef> {
        self.roles
            .iter()
            .find(|r| r.workspace_id == ws && r.role.id == id)
            .map(|r| &r.role)
    }

    pub(super) fn version_in(
        &self,
        ws: WorkspaceId,
        id: StrategyVersionId,
    ) -> Option<&StrategyVersion> {
        self.strategy_versions
            .iter()
            .find(|v| v.workspace_id == ws && v.id == id)
    }

    /// `NOT_FOUND` unless version `id` belongs to `ws`, as `jt_pg` checks before hanging a
    /// hypothesis or a consultation entry off it.
    pub(super) fn ensure_version(
        &self,
        ws: WorkspaceId,
        id: StrategyVersionId,
    ) -> Result<(), AppError> {
        self.version_in(ws, id)
            .map(|_| ())
            .ok_or_else(|| AppError::not_found("no such strategy version"))
    }

    /// The workspace's version in `status`.
    pub(super) fn version_with_status(
        &self,
        ws: WorkspaceId,
        status: VersionStatus,
    ) -> Option<&StrategyVersion> {
        self.strategy_versions
            .iter()
            .find(|v| v.workspace_id == ws && v.status == status)
    }

    pub(super) fn membership_in(
        &self,
        ws: WorkspaceId,
        id: MembershipId,
    ) -> Option<&MembershipRow> {
        self.memberships
            .iter()
            .find(|m| m.workspace_id == ws && m.id == id)
    }

    /// Whether `user` holds a membership in `ws` that is not `Removed`, other than `except`.
    pub(super) fn has_live_membership(
        &self,
        ws: WorkspaceId,
        user: UserId,
        except: MembershipId,
    ) -> bool {
        self.memberships.iter().any(|m| {
            m.workspace_id == ws
                && m.user_id == Some(user)
                && m.status != MembershipStatus::Removed
                && m.id != except
        })
    }

    pub(super) fn is_owner_role(&self, ws: WorkspaceId, id: RoleId) -> bool {
        self.role_in(ws, id)
            .is_some_and(|r| r.is_system && r.key == SystemRole::Owner.key())
    }

    /// Active owner memberships of `ws`, oldest first.
    pub(super) fn active_owners(&self, ws: WorkspaceId) -> Vec<&MembershipRow> {
        let mut owners: Vec<&MembershipRow> = self
            .memberships
            .iter()
            .filter(|m| {
                m.workspace_id == ws
                    && m.status == MembershipStatus::Active
                    && self.is_owner_role(ws, m.role_id)
            })
            .collect();
        owners.sort_by_key(|m| (m.created_at, m.id));
        owners
    }

    /// Checks the role for `ws`: a dangling workspace is `INTERNAL`, a taken key or id `CONFLICT`.
    pub(super) fn check_new_role(&self, ws: WorkspaceId, role: &RoleDef) -> Result<(), AppError> {
        exists(self.workspace(ws).is_some(), "roles.workspace_id")?;
        unique(
            !self
                .roles
                .iter()
                .any(|r| r.role.id == role.id || (r.workspace_id == ws && r.role.key == role.key)),
            "role key is already taken",
        )
    }

    /// Checks a new membership's references and the one-live-membership-per-user rule. A role that
    /// is not the membership's workspace's is `NOT_FOUND`, checked first as in `jt_pg`.
    pub(super) fn check_new_membership(&self, row: &MembershipRow) -> Result<(), AppError> {
        role_in_workspace(self, row.workspace_id, row.role_id)?;
        exists(
            self.workspace(row.workspace_id).is_some(),
            "memberships.workspace_id",
        )?;
        if let Some(user) = row.user_id {
            exists(self.user(user).is_some(), "memberships.user_id")?;
        }
        if let Some(by) = row.invited_by {
            exists(self.user(by).is_some(), "memberships.invited_by")?;
        }
        unique(
            !self.memberships.iter().any(|m| m.id == row.id),
            "membership id is already taken",
        )?;
        if let Some(hash) = &row.invite_token_hash {
            unique(
                !self
                    .memberships
                    .iter()
                    .any(|m| m.invite_token_hash.as_ref() == Some(hash)),
                "invite token is already taken",
            )?;
        }
        if let (Some(user), true) = (row.user_id, row.status != MembershipStatus::Removed) {
            unique(
                !self.has_live_membership(row.workspace_id, user, row.id),
                "the user is already a member of this workspace",
            )?;
        }
        Ok(())
    }

    pub(super) fn check_new_ledger_entry(&self, entry: &LedgerEntry) -> Result<(), AppError> {
        exists(
            self.workspace(entry.workspace_id).is_some(),
            "ledger_entries.workspace_id",
        )
    }

    pub(super) fn membership_view(&self, m: &MembershipRow) -> Result<MembershipView, AppError> {
        let ws = self
            .workspace(m.workspace_id)
            .ok_or_else(|| dangling("memberships.workspace_id"))?;
        let role = self
            .role_in(m.workspace_id, m.role_id)
            .ok_or_else(|| dangling("memberships.role_id"))?;
        Ok(MembershipView {
            membership_id: m.id,
            workspace_id: ws.id,
            workspace_name: ws.name.clone(),
            workspace_slug: ws.slug.clone(),
            workspace_status: ws.status,
            role_key: role.key.clone(),
            permissions: role.permissions.clone(),
        })
    }
}

pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) fn dangling(reference: &str) -> AppError {
    AppError::internal(format!("{reference} references a row that does not exist"))
}

/// Refuses a write whose reference, a foreign key in the schema named `table.column`, points
/// nowhere, answering as `jt_pg::map_sqlx` does: `NOT_FOUND` for a role, user or workspace (which
/// the caller supplied), `INTERNAL` for anything else.
pub(super) fn exists(found: bool, reference: &str) -> Result<(), AppError> {
    if found {
        return Ok(());
    }
    let column = reference.rsplit('.').next().unwrap_or(reference);
    let kind = if column.ends_with("role_id") {
        Some("role")
    } else if column.ends_with("workspace_id") {
        Some("workspace")
    } else if matches!(
        column,
        "user_id" | "invited_by" | "issued_by" | "approved_by" | "started_by"
    ) {
        Some("user")
    } else {
        None
    };
    match kind {
        Some(kind) => Err(AppError::not_found(format!("no such {kind}"))),
        None => Err(dangling(reference)),
    }
}

/// `NOT_FOUND` unless role `id` belongs to workspace `ws`, as `jt_pg` checks before every write
/// that sets a role (a foreign key alone would accept another workspace's role).
pub(super) fn role_in_workspace(
    state: &MemState,
    ws: WorkspaceId,
    id: RoleId,
) -> Result<(), AppError> {
    if state.role_in(ws, id).is_some() {
        Ok(())
    } else {
        Err(AppError::not_found("no such role"))
    }
}

/// `CONFLICT` unless the value is free (a unique key in the schema).
pub(super) fn unique(free: bool, message: &str) -> Result<(), AppError> {
    if free {
        Ok(())
    } else {
        Err(AppError::conflict(message))
    }
}

/// `INTERNAL` when a row for `row_ws` is handed to the tenant bundle of `ws`.
pub(super) fn same_workspace(ws: WorkspaceId, row_ws: WorkspaceId) -> Result<(), AppError> {
    if ws == row_ws {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "a row for workspace {row_ws} was given to the bundle of workspace {ws}"
        )))
    }
}

pub(super) fn actor_kind(actor: &Actor) -> &'static str {
    match actor {
        Actor::Human { .. } => "human",
        Actor::Agent { .. } => "agent",
        Actor::System { .. } => "system",
    }
}

// ---------------------------------------------------------------------------------------------
// The unit of work and its transactions
// ---------------------------------------------------------------------------------------------

/// An in-memory `UnitOfWork`. Clones share the same tables.
#[derive(Clone, Default)]
pub struct InMemoryUow {
    state: Arc<Mutex<MemState>>,
    ledger_seq: Arc<AtomicI64>,
    /// How many of the next `CapabilityRepo::set_sealed` calls fail
    /// ([`InMemoryUow::fail_set_sealed`]).
    set_sealed_faults: Arc<AtomicUsize>,
    inbox_task_status_faults: Arc<AtomicUsize>,
    inbox_consumption_faults: Arc<AtomicUsize>,
    mail_cursor_faults: Arc<AtomicUsize>,
    capability_after_list: Arc<Mutex<Option<StoredCapability>>>,
}

impl InMemoryUow {
    pub fn new() -> Self {
        Self::default()
    }

    /// A copy of the committed tables, for assertions.
    pub fn snapshot(&self) -> MemState {
        lock(&self.state).clone()
    }

    /// Model an attach committing after a capability list under READ COMMITTED. The next
    /// list returns the old row; subsequent reads see this committed replacement.
    pub fn replace_capability_after_list(&self, row: StoredCapability) {
        *lock(&self.capability_after_list) = Some(row);
    }

    pub fn fail_mail_cursor(&self, times: usize) {
        self.mail_cursor_faults.store(times, Ordering::SeqCst);
    }

    /// Fail completion after consumer effects to exercise atomic rollback.
    pub fn fail_inbox_consumption(&self, times: usize) {
        self.inbox_consumption_faults.store(times, Ordering::SeqCst);
    }

    /// Fail the next task-status effect calls to exercise transaction rollback.
    pub fn fail_inbox_task_status(&self, times: usize) {
        self.inbox_task_status_faults.store(times, Ordering::SeqCst);
    }
    /// Makes the next `times` calls of `CapabilityRepo::set_sealed`, in any bundle, fail with
    /// `INTERNAL` (spoiling their bundle, as a failed statement aborts a Postgres transaction):
    /// a database failing at the moment a credential is written.
    pub fn fail_set_sealed(&self, times: usize) {
        self.set_sealed_faults.store(times, Ordering::SeqCst);
    }

    /// Seeds a queued provider job at the current time for delivery-poll tests.
    pub fn add_outbound_job(&self, ws: WorkspaceId, capability_id: CapabilityId, job_id: &str) {
        let now = OffsetDateTime::now_utc();
        lock(&self.state).outbound_jobs.push(StoredOutboundJob {
            row: jt_app::ports::compliance::OutboundJobRow {
                id: uuid::Uuid::now_v7(),
                workspace_id: ws,
                capability_id,
                provider_job_id: Some(job_id.to_owned()),
                message_id: None,
                state: jt_app::ports::compliance::OutboundJobState::Queued,
                last_status: None,
                created_at: now,
                updated_at: now,
            },
            workspace_id: ws,
            capability_id,
            job_id: job_id.to_owned(),
            status: None,
        });
    }
}

type Op = Box<dyn Fn(&mut MemState) + Send + Sync>;

/// One bundle's transaction: a private working copy plus the writes to replay on commit.
pub(super) struct MemTx {
    shared: Arc<Mutex<MemState>>,
    ledger_seq: Arc<AtomicI64>,
    set_sealed_faults: Arc<AtomicUsize>,
    inbox_task_status_faults: Arc<AtomicUsize>,
    inbox_consumption_faults: Arc<AtomicUsize>,
    mail_cursor_faults: Arc<AtomicUsize>,
    capability_after_list: Arc<Mutex<Option<StoredCapability>>>,
    pub(super) work: MemState,
    pub(super) inbox_write_at: Option<OffsetDateTime>,
    ops: Vec<Op>,
    /// Set once a call on the bundle has failed; `commit` then refuses.
    spoiled: bool,
}

impl MemTx {
    pub(super) fn begin(uow: &InMemoryUow) -> MemTx {
        MemTx {
            shared: Arc::clone(&uow.state),
            ledger_seq: Arc::clone(&uow.ledger_seq),
            set_sealed_faults: Arc::clone(&uow.set_sealed_faults),
            inbox_task_status_faults: Arc::clone(&uow.inbox_task_status_faults),
            inbox_consumption_faults: Arc::clone(&uow.inbox_consumption_faults),
            mail_cursor_faults: Arc::clone(&uow.mail_cursor_faults),
            capability_after_list: Arc::clone(&uow.capability_after_list),
            work: lock(&uow.state).clone(),
            inbox_write_at: None,
            ops: Vec::new(),
            spoiled: false,
        }
    }

    pub(super) fn commit_capability_after_list(&mut self, ws: WorkspaceId) {
        let mut pending = lock(&self.capability_after_list);
        if pending
            .as_ref()
            .is_none_or(|r| r.capability.workspace_id != ws)
        {
            return;
        }
        let row = pending.take().expect("checked above");
        for state in [&mut *lock(&self.shared), &mut self.work] {
            let stored = state
                .capabilities
                .iter_mut()
                .find(|c| c.capability.id == row.capability.id)
                .expect("existing capability");
            *stored = row.clone();
        }
    }

    /// Applies `op` to the working copy now and records it for commit.
    pub(super) fn write(&mut self, op: impl Fn(&mut MemState) + Send + Sync + 'static) {
        op(&mut self.work);
        self.ops.push(Box::new(op));
    }

    /// Replays the writes onto the shared tables, or, when a call failed, refuses with `INTERNAL`
    /// and writes nothing.
    pub(super) fn commit(self) -> Result<(), AppError> {
        if self.spoiled {
            return Err(AppError::internal(
                "an earlier call failed, so the transaction was rolled back and nothing was \
                 committed",
            ));
        }
        let mut shared = lock(&self.shared);
        for op in &self.ops {
            op(&mut shared);
        }
        Ok(())
    }

    /// `MembershipRepo::activate` for membership `id` of `ws`.
    pub(super) fn activate(
        &mut self,
        ws: WorkspaceId,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let m = self
            .work
            .membership_in(ws, id)
            .ok_or_else(|| AppError::not_found("no such membership"))?;
        let open = m.status == MembershipStatus::Invited
            && m.invite_expires_at.is_some_and(|expires| expires > at);
        if !open {
            return Err(AppError::conflict(
                "the membership is not an open invitation",
            ));
        }
        exists(self.work.user(user_id).is_some(), "memberships.user_id")?;
        unique(
            !self.work.has_live_membership(ws, user_id, id),
            "the user is already a member of this workspace",
        )?;
        self.write(move |s| {
            if let Some(m) = s.memberships.iter_mut().find(|m| m.id == id) {
                m.user_id = Some(user_id);
                m.status = MembershipStatus::Active;
                m.invite_token_hash = None;
                m.invite_expires_at = None;
            }
        });
        Ok(())
    }

    pub(super) fn mail_cursor_fails(&self) -> bool {
        self.mail_cursor_faults
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }

    pub(super) fn inbox_consumption_fails(&self) -> bool {
        self.inbox_consumption_faults
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }

    /// Whether this task-status effect is scheduled to fail.
    pub(super) fn inbox_task_status_fails(&self) -> bool {
        self.inbox_task_status_faults
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }
    /// Whether this `set_sealed` call is one [`InMemoryUow::fail_set_sealed`] asked to fail.
    pub(super) fn set_sealed_fails(&self) -> bool {
        self.set_sealed_faults
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }

    pub(super) fn append_ledger(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.work.check_new_ledger_entry(&entry)?;
        let id = self.ledger_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let row = LedgerRow { id, entry };
        self.write(move |s| s.ledger.push(row.clone()));
        Ok(id)
    }
}

/// A bundle over one [`MemTx`].
pub(super) trait MemBundle: Sized {
    fn tx(&mut self) -> &mut MemTx;

    /// Runs one fallible repo call. An error spoils the transaction, so `commit` refuses it.
    /// Every call that can fail goes through here.
    fn call<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, AppError>) -> Result<T, AppError> {
        let result = f(self);
        if result.is_err() {
            self.tx().spoiled = true;
        }
        result
    }
}

#[async_trait]
impl UnitOfWork for InMemoryUow {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        Ok(Box::new(MemTenant {
            tx: MemTx::begin(self),
            ws,
        }))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        Ok(Box::new(MemPlatform {
            tx: MemTx::begin(self),
        }))
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        Ok(Box::new(MemUser {
            tx: MemTx::begin(self),
        }))
    }
}
