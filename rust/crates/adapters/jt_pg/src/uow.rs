//! The unit of work: opens repo bundles on a pool, each bundle one scoped transaction.
//!
//! [`PgTenantRepos`] holds a [`TenantTx`], [`PgPlatformRepos`] a [`PlatformTx`] and
//! [`PgUserRepos`] a [`UserTx`]. Each bundle implements its repo traits itself, so the accessors
//! hand out the bundle. `commit` commits; dropping a bundle uncommitted rolls it back.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::inbox::*;
use jt_app::ports::{
    AgentConnectionRepo, ApiKeyRepo, ApiKeyRow, BudgetRepo, CapabilityGroupRepo, CapabilityRepo,
    ConsultationRepo, HypothesisRepo, InboundEventRepo, LedgerRepo, MembershipRepo, MembershipRow,
    MembershipView, OAuthPendingRepo, OperatorRepo, OutboundJobRepo, PlatformRepos,
    PlatformSessionRepo, ProbeRunRepo, RoleRepo, SessionRepo, StrategyRepo, TenantRepos,
    UnitOfWork, UserRepo, UserRepos, WorkspacePolicyRepo, WorkspaceRepo, WorkspaceRow,
};
use jt_capability::Capability;
use jt_ledger::LedgerEntry;
use jt_tenancy::{Email, MembershipId, RoleDef, RoleId, UserId, WorkspaceId, WorkspaceStatus};
use sqlx::{PgConnection, PgPool};
use time::OffsetDateTime;

use crate::repos::{api_keys, capabilities, ledger, map_sqlx, memberships, roles, workspaces};
use crate::tx::{PlatformTx, TenantTx, UserTx};

/// Opens repo bundles on a pool. Clones share the pool.
#[derive(Clone, Debug)]
pub struct PgUnitOfWork {
    pool: PgPool,
}

impl PgUnitOfWork {
    /// A unit of work over `pool`, which must connect as a role row-level security binds.
    pub fn new(pool: PgPool) -> PgUnitOfWork {
        PgUnitOfWork { pool }
    }
}

#[async_trait]
impl UnitOfWork for PgUnitOfWork {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        let tx = TenantTx::begin(&self.pool, ws)
            .await
            .map_err(|e| map_sqlx(e, "begin tenant transaction"))?;
        Ok(Box::new(PgTenantRepos { tx }))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        let tx = PlatformTx::begin(&self.pool)
            .await
            .map_err(|e| map_sqlx(e, "begin platform transaction"))?;
        Ok(Box::new(PgPlatformRepos { tx }))
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        let tx = UserTx::begin(&self.pool)
            .await
            .map_err(|e| map_sqlx(e, "begin user transaction"))?;
        Ok(Box::new(PgUserRepos { tx }))
    }
}

/// Fails when an earlier statement aborted the transaction. Postgres answers `COMMIT` on an
/// aborted transaction with a silent `ROLLBACK`; without this check `commit` would report success
/// for writes that were all discarded.
async fn ensure_not_aborted(conn: &mut PgConnection) -> Result<(), AppError> {
    sqlx::query("select 1")
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|_| {
            AppError::internal(
                "an earlier statement failed, so the transaction was rolled back and nothing was \
                 committed",
            )
        })
}

// ---------------------------------------------------------------------------------------------
// Tenant bundle
// ---------------------------------------------------------------------------------------------

/// One transaction scoped to a single workspace. Its repo impls live in [`crate::repos`].
pub struct PgTenantRepos {
    pub(crate) tx: TenantTx<'static>,
}

impl PgTenantRepos {
    /// The workspace this bundle is scoped to.
    pub fn workspace_id(&self) -> WorkspaceId {
        self.tx.workspace_id()
    }
}

#[async_trait]
impl TenantRepos for PgTenantRepos {
    fn people(&mut self) -> &mut dyn PersonRepo {
        self
    }
    fn identities(&mut self) -> &mut dyn IdentityRepo {
        self
    }
    fn conversations(&mut self) -> &mut dyn ConversationRepo {
        self
    }
    fn messages(&mut self) -> &mut dyn MessageRepo {
        self
    }
    fn journeys(&mut self) -> &mut dyn JourneyRepo {
        self
    }
    fn tasks(&mut self) -> &mut dyn TaskRepo {
        self
    }
    fn notes(&mut self) -> &mut dyn NoteRepo {
        self
    }
    fn merges(&mut self) -> &mut dyn MergeRepo {
        self
    }
    fn lost_reasons(&mut self) -> &mut dyn LostReasonRepo {
        self
    }
    fn consumption(&mut self) -> &mut dyn ConsumptionRepo {
        self
    }
    fn request_keys(&mut self) -> &mut dyn RequestKeyRepo {
        self
    }
    fn outbox(&mut self) -> &mut dyn OutboxRepo {
        self
    }

    fn roles(&mut self) -> &mut dyn RoleRepo {
        self
    }

    fn memberships(&mut self) -> &mut dyn MembershipRepo {
        self
    }

    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo {
        self
    }

    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo {
        self
    }

    fn ledger(&mut self) -> &mut dyn LedgerRepo {
        self
    }

    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self
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
        self
    }

    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo {
        self
    }

    fn budget(&mut self) -> &mut dyn BudgetRepo {
        self
    }

    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo {
        self
    }

    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo {
        self
    }

    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo {
        self
    }

    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo {
        self
    }

    /// A stub until M2 adds the table of sent messages (see `repos::outbound_jobs`).
    fn outbound_jobs(&mut self) -> &mut dyn OutboundJobRepo {
        self
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        let mut this = *self;
        ensure_not_aborted(this.tx.conn()).await?;
        this.tx.commit().await.map_err(|e| map_sqlx(e, "commit"))
    }
}

// ---------------------------------------------------------------------------------------------
// User bundle
// ---------------------------------------------------------------------------------------------

/// One transaction over user-level data and registration.
pub struct PgUserRepos {
    pub(crate) tx: UserTx<'static>,
}

#[async_trait]
impl UserRepos for PgUserRepos {
    async fn lost_reasons_initialize(&mut self, ws: WorkspaceId) -> Result<(), AppError> {
        crate::repos::inbox::lost_reasons::initialize(self.tx.conn(), ws).await
    }
    fn users(&mut self) -> &mut dyn UserRepo {
        self
    }

    fn sessions(&mut self) -> &mut dyn SessionRepo {
        self
    }

    async fn memberships_of_user(
        &mut self,
        user_id: UserId,
    ) -> Result<Vec<MembershipView>, AppError> {
        memberships::of_user(&mut self.tx, user_id).await
    }

    async fn workspaces_create(
        &mut self,
        id: WorkspaceId,
        name: &str,
        slug: &str,
        status: WorkspaceStatus,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError> {
        workspaces::create(&mut self.tx, id, name, slug, status, created_at).await
    }

    async fn roles_create_system(
        &mut self,
        ws: WorkspaceId,
        roles: &[RoleDef],
    ) -> Result<(), AppError> {
        roles::create_system(&mut self.tx, ws, roles).await
    }

    async fn memberships_insert_active(
        &mut self,
        id: MembershipId,
        workspace_id: WorkspaceId,
        user_id: UserId,
        role_id: RoleId,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError> {
        memberships::insert_active(&mut self.tx, id, workspace_id, user_id, role_id, created_at)
            .await
    }

    async fn memberships_activate(
        &mut self,
        workspace_id: WorkspaceId,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        memberships::activate(self.tx.conn(), workspace_id, id, user_id, at).await
    }

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        ledger::insert(self.tx.conn(), &entry).await
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        let mut this = *self;
        ensure_not_aborted(this.tx.conn()).await?;
        this.tx.commit().await.map_err(|e| map_sqlx(e, "commit"))
    }
}

// ---------------------------------------------------------------------------------------------
// Platform bundle
// ---------------------------------------------------------------------------------------------

/// One platform-wide transaction.
pub struct PgPlatformRepos {
    pub(crate) tx: PlatformTx<'static>,
}

#[async_trait]
impl PlatformRepos for PgPlatformRepos {
    fn operators(&mut self) -> &mut dyn OperatorRepo {
        self
    }

    fn platform_sessions(&mut self) -> &mut dyn PlatformSessionRepo {
        self
    }

    async fn workspaces_list(&mut self) -> Result<Vec<WorkspaceRow>, AppError> {
        workspaces::list(&mut self.tx).await
    }

    async fn workspace_get(&mut self, ws: WorkspaceId) -> Result<Option<WorkspaceRow>, AppError> {
        workspaces::get(&mut self.tx, ws).await
    }

    async fn workspace_set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
    ) -> Result<(), AppError> {
        workspaces::set_status(&mut self.tx, ws, status).await
    }

    async fn workspace_owner_email(&mut self, ws: WorkspaceId) -> Result<Option<Email>, AppError> {
        workspaces::owner_email(&mut self.tx, ws).await
    }

    async fn workspace_member_count(&mut self, ws: WorkspaceId) -> Result<i64, AppError> {
        workspaces::member_count(&mut self.tx, ws).await
    }

    async fn api_key_find_by_hash(
        &mut self,
        key_hash: &str,
    ) -> Result<Option<ApiKeyRow>, AppError> {
        api_keys::find_by_hash(&mut self.tx, key_hash).await
    }

    async fn membership_find_by_invite_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<MembershipRow>, AppError> {
        memberships::find_by_invite_hash(&mut self.tx, token_hash).await
    }

    async fn capability_by_external(
        &mut self,
        kind_keys: &[&str],
        external_id: &str,
    ) -> Result<Option<Capability>, AppError> {
        capabilities::by_external(&mut self.tx, kind_keys, external_id).await
    }

    async fn workspaces_with_verified(
        &mut self,
        kind_keys: &[&str],
    ) -> Result<Vec<WorkspaceId>, AppError> {
        capabilities::workspaces_with_verified(&mut self.tx, kind_keys).await
    }

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        ledger::insert(self.tx.conn(), &entry).await
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        let mut this = *self;
        ensure_not_aborted(this.tx.conn()).await?;
        this.tx.commit().await.map_err(|e| map_sqlx(e, "commit"))
    }
}
