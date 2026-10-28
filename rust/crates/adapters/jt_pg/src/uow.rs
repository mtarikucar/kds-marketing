//! The unit of work: opens repo bundles on a pool, each bundle one scoped transaction.
//!
//! [`PgTenantRepos`] holds a [`TenantTx`], [`PgPlatformRepos`] a [`PlatformTx`] and
//! [`PgUserRepos`] a [`UserTx`]. Each bundle implements its repo traits itself, so the accessors
//! hand out the bundle. `commit` commits; dropping a bundle uncommitted rolls it back.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::billing;
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

use crate::repos::{
    api_keys, calls, capabilities, ledger, map_sqlx, memberships, roles, workspaces,
};
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
    fn billing(&mut self) -> &mut dyn jt_app::ports::billing::BillingRepo {
        self
    }

    fn activation_codes(&mut self) -> &mut dyn jt_app::ports::billing::ActivationCodeRepo {
        self
    }

    fn studio(&mut self) -> &mut dyn jt_app::ports::studio::StudioRepo {
        self
    }

    fn studio_budget(&mut self) -> &mut dyn jt_app::ports::studio::StudioBudgetRepo {
        self
    }

    fn studio_control(&mut self) -> &mut dyn jt_app::ports::studio::StudioControlRepo {
        self
    }

    fn calls(&mut self) -> &mut dyn jt_app::ports::calls::CallRepo {
        self
    }

    fn consents(&mut self) -> &mut dyn jt_app::ports::inbox::ConsentRepo {
        self
    }
    fn suppressions(&mut self) -> &mut dyn jt_app::ports::inbox::SuppressionRepo {
        self
    }
    fn quotes(&mut self) -> &mut dyn jt_app::ports::inbox::QuoteRepo {
        self
    }
    fn appointments(&mut self) -> &mut dyn jt_app::ports::inbox::AppointmentRepo {
        self
    }
    fn commissions(&mut self) -> &mut dyn jt_app::ports::inbox::CommissionRepo {
        self
    }
    fn erasure(&mut self) -> &mut dyn jt_app::ports::inbox::ErasureRepo {
        self
    }
    fn mail_cursors(&mut self) -> &mut dyn jt_app::ports::inbox::MailCursorRepo {
        self
    }
    fn attribution(&mut self) -> &mut dyn jt_app::ports::inbox::AttributionRepo {
        self
    }

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
    async fn connector_health_counts(
        &mut self,
    ) -> Result<Vec<jt_app::ports::ops::ConnectorHealthCount>, AppError> {
        use jt_app::ports::ops::ConnectorHealthCount;
        use sqlx::Row;
        let mut out = std::collections::BTreeMap::new();
        // archtest: platform-wide
        let rows = sqlx::query("select workspace_id, kind_key, coalesce(connector_public->'reconnect_required' = 'true'::jsonb, false) as reconnect, connector_public->'access'->>'expires_at' as expiry from capabilities where connector_sealed is not null and status <> 'retired'")
            .fetch_all(self.tx.conn()).await.map_err(|e| map_sqlx(e, "connector health counts"))?;
        for r in rows {
            let ws = WorkspaceId(
                r.try_get("workspace_id")
                    .map_err(|e| map_sqlx(e, "health workspace"))?,
            );
            let kind: String = r
                .try_get("kind_key")
                .map_err(|e| map_sqlx(e, "health kind"))?;
            let row = out
                .entry((ws, kind.clone()))
                .or_insert(ConnectorHealthCount {
                    workspace_id: ws,
                    kind_key: kind,
                    reconnect_required: 0,
                    expires_before: None,
                });
            row.reconnect_required += u64::from(
                r.try_get::<bool, _>("reconnect")
                    .map_err(|e| map_sqlx(e, "health count"))?,
            );
            let expiry: Option<String> = r
                .try_get("expiry")
                .map_err(|e| map_sqlx(e, "health expiry"))?;
            if let Some(at) = expiry.and_then(|v| {
                OffsetDateTime::parse(&v, &time::format_description::well_known::Rfc3339).ok()
            }) {
                row.expires_before = Some(row.expires_before.map_or(at, |old| old.min(at)));
            }
        }
        Ok(out.into_values().collect())
    }

    async fn workspace_lock(&mut self, ws: WorkspaceId) -> Result<WorkspaceRow, AppError> {
        workspaces::lock(self.tx.conn(), ws).await
    }
    async fn payment_get(
        &mut self,
        ws: WorkspaceId,
        id: billing::PaymentId,
    ) -> Result<Option<billing::PaymentNotification>, AppError> {
        crate::repos::billing::payment_get(self.tx.conn(), ws, id).await
    }
    async fn payments_list(&mut self) -> Result<Vec<billing::PaymentNotification>, AppError> {
        crate::repos::billing::payments_list(&mut self.tx).await
    }
    async fn payment_entitlements_latest(
        &mut self,
    ) -> Result<Vec<billing::WorkspaceEntitlement>, AppError> {
        crate::repos::billing::payment_entitlements_latest(&mut self.tx).await
    }
    async fn entitlement_get(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<billing::WorkspaceEntitlement>, AppError> {
        crate::repos::billing::entitlement_get(self.tx.conn(), ws).await
    }
    async fn entitlement_insert(
        &mut self,
        row: billing::WorkspaceEntitlement,
    ) -> Result<(), AppError> {
        crate::repos::billing::entitlement_insert(self.tx.conn(), row).await
    }
    async fn entitlement_revoke(
        &mut self,
        ws: WorkspaceId,
        id: billing::EntitlementId,
        at: OffsetDateTime,
        reason: &str,
    ) -> Result<(), AppError> {
        crate::repos::billing::entitlement_revoke(self.tx.conn(), ws, id, at, reason).await
    }
    async fn activation_code_insert(
        &mut self,
        ws: WorkspaceId,
        row: billing::ActivationCodeRow,
    ) -> Result<(), AppError> {
        crate::repos::same_workspace(ws, row.workspace_id)?;
        crate::repos::billing::code_insert(self.tx.conn(), row).await
    }
    async fn activation_code_digest_exists(
        &mut self,
        ws: WorkspaceId,
        digest: &[u8],
    ) -> Result<bool, AppError> {
        sqlx::query_scalar(
            "select exists(select 1 from activation_codes where workspace_id=$1 and digest=$2)",
        )
        .bind(ws.as_uuid())
        .bind(digest)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| crate::repos::map_sqlx(e, "check activation history"))
    }
    async fn activation_code_lock_current_by_workspace(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<billing::ActivationCodeRow>, AppError> {
        crate::repos::billing::code_current(self.tx.conn(), ws).await
    }
    async fn activation_code_record_failed_attempt(
        &mut self,
        ws: WorkspaceId,
        id: billing::ActivationCodeId,
    ) -> Result<(), AppError> {
        crate::repos::billing::code_fail(self.tx.conn(), ws, id).await
    }
    async fn activation_code_invalidate_current(
        &mut self,
        ws: WorkspaceId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        crate::repos::billing::code_invalidate(self.tx.conn(), ws, at).await
    }
    async fn activation_code_consume(
        &mut self,
        ws: WorkspaceId,
        id: billing::ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        crate::repos::billing::code_consume(self.tx.conn(), ws, id, at, by).await
    }

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
        reason: &str,
        by: &jt_ledger::Actor,
    ) -> Result<(), AppError> {
        workspaces::set_status(self.tx.conn(), ws, status, reason, by).await
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

    async fn workspaces_with_live_agent_calls(&mut self) -> Result<Vec<WorkspaceId>, AppError> {
        calls::workspaces_with_live_agent_calls(&mut self.tx).await
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
