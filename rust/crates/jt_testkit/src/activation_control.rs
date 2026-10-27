//! Transaction decorators for deterministic races and a last-write audit failure.
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{inbox::*, *},
};
use jt_capability::Capability;
use jt_ledger::{Actor, LedgerEntry};
use jt_tenancy::{AgentConnectionId, Email, UserId, WorkspaceId, WorkspaceStatus};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use time::OffsetDateTime;

#[derive(Default)]
pub struct Hold {
    pub reached: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
    used: AtomicBool,
}
impl Hold {
    async fn pause(&self) {
        if !self.used.swap(true, Ordering::SeqCst) {
            self.reached.notify_one();
            self.release.notified().await;
        }
    }
}
pub struct ControlledUow {
    pub inner: Arc<dyn UnitOfWork>,
    pub tenant_hold: Option<Arc<Hold>>,
    pub platform_hold: Option<Arc<Hold>>,
    pub fail_activation_audit: bool,
}
#[async_trait]
impl UnitOfWork for ControlledUow {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        Ok(Box::new(Tenant {
            inner: self.inner.tenant(ws).await?,
            hold: self.tenant_hold.clone(),
            fail: self.fail_activation_audit,
        }))
    }
    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        Ok(Box::new(Platform {
            inner: self.inner.platform().await?,
            hold: self.platform_hold.clone(),
        }))
    }
    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        self.inner.user().await
    }
}
struct Tenant {
    inner: Box<dyn TenantRepos>,
    hold: Option<Arc<Hold>>,
    fail: bool,
}
struct Platform {
    inner: Box<dyn PlatformRepos>,
    hold: Option<Arc<Hold>>,
}

#[async_trait]
impl TenantRepos for Tenant {
    fn billing(&mut self) -> &mut dyn billing::BillingRepo {
        self.inner.billing()
    }
    fn activation_codes(&mut self) -> &mut dyn billing::ActivationCodeRepo {
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
    fn consents(&mut self) -> &mut dyn ConsentRepo {
        self.inner.consents()
    }
    fn suppressions(&mut self) -> &mut dyn SuppressionRepo {
        self.inner.suppressions()
    }
    fn quotes(&mut self) -> &mut dyn QuoteRepo {
        self.inner.quotes()
    }
    fn appointments(&mut self) -> &mut dyn AppointmentRepo {
        self.inner.appointments()
    }
    fn commissions(&mut self) -> &mut dyn CommissionRepo {
        self.inner.commissions()
    }
    fn erasure(&mut self) -> &mut dyn ErasureRepo {
        self.inner.erasure()
    }
    fn mail_cursors(&mut self) -> &mut dyn MailCursorRepo {
        self.inner.mail_cursors()
    }
    fn attribution(&mut self) -> &mut dyn AttributionRepo {
        self.inner.attribution()
    }
    fn people(&mut self) -> &mut dyn PersonRepo {
        self.inner.people()
    }
    fn identities(&mut self) -> &mut dyn IdentityRepo {
        self.inner.identities()
    }
    fn conversations(&mut self) -> &mut dyn ConversationRepo {
        self.inner.conversations()
    }
    fn messages(&mut self) -> &mut dyn MessageRepo {
        self.inner.messages()
    }
    fn journeys(&mut self) -> &mut dyn JourneyRepo {
        self.inner.journeys()
    }
    fn tasks(&mut self) -> &mut dyn TaskRepo {
        self.inner.tasks()
    }
    fn notes(&mut self) -> &mut dyn NoteRepo {
        self.inner.notes()
    }
    fn merges(&mut self) -> &mut dyn MergeRepo {
        self.inner.merges()
    }
    fn lost_reasons(&mut self) -> &mut dyn LostReasonRepo {
        self.inner.lost_reasons()
    }
    fn consumption(&mut self) -> &mut dyn ConsumptionRepo {
        self.inner.consumption()
    }
    fn request_keys(&mut self) -> &mut dyn RequestKeyRepo {
        self.inner.request_keys()
    }
    fn outbox(&mut self) -> &mut dyn OutboxRepo {
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
        self
    }
    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self
    }
    fn strategy(&mut self) -> &mut dyn StrategyRepo {
        self.inner.strategy()
    }
    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo {
        self.inner.hypotheses()
    }
    fn consultation(&mut self) -> &mut dyn ConsultationRepo {
        self.inner.consultation()
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
        self.inner.commit().await
    }
}

#[async_trait]
impl WorkspaceRepo for Tenant {
    async fn lock(&mut self) -> Result<WorkspaceRow, AppError> {
        let row = self.inner.workspace().lock().await?;
        if let Some(hold) = &self.hold {
            hold.pause().await;
        }
        Ok(row)
    }
    async fn set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
        reason: &str,
        by: &Actor,
    ) -> Result<(), AppError> {
        self.inner
            .workspace()
            .set_status(ws, status, reason, by)
            .await
    }
    async fn get(&mut self) -> Result<WorkspaceRow, AppError> {
        self.inner.workspace().get().await
    }
}

#[async_trait]
impl LedgerRepo for Tenant {
    async fn append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        if self.fail && entry.action.as_str() == "billing.activated" {
            return Err(AppError::internal("synthetic audit failure"));
        }
        self.inner.ledger().append(entry).await
    }
    async fn list(&mut self, filter: LedgerFilter) -> Result<Vec<LedgerRow>, AppError> {
        self.inner.ledger().list(filter).await
    }
    async fn last_checkin_at(
        &mut self,
        connection_id: AgentConnectionId,
    ) -> Result<Option<OffsetDateTime>, AppError> {
        self.inner.ledger().last_checkin_at(connection_id).await
    }
}

#[async_trait]
impl PlatformRepos for Platform {
    async fn connector_health_counts(
        &mut self,
    ) -> Result<Vec<jt_app::ports::ops::ConnectorHealthCount>, AppError> {
        self.inner.connector_health_counts().await
    }

    async fn workspace_lock(&mut self, ws: WorkspaceId) -> Result<WorkspaceRow, AppError> {
        let row = self.inner.workspace_lock(ws).await?;
        if let Some(hold) = &self.hold {
            hold.pause().await;
        }
        Ok(row)
    }
    async fn payment_get(
        &mut self,
        ws: WorkspaceId,
        id: billing::PaymentId,
    ) -> Result<Option<billing::PaymentNotification>, AppError> {
        self.inner.payment_get(ws, id).await
    }
    async fn payments_list(&mut self) -> Result<Vec<billing::PaymentNotification>, AppError> {
        self.inner.payments_list().await
    }
    async fn payment_entitlements_latest(
        &mut self,
    ) -> Result<Vec<billing::WorkspaceEntitlement>, AppError> {
        self.inner.payment_entitlements_latest().await
    }
    async fn entitlement_get(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<billing::WorkspaceEntitlement>, AppError> {
        self.inner.entitlement_get(ws).await
    }
    async fn entitlement_insert(
        &mut self,
        row: billing::WorkspaceEntitlement,
    ) -> Result<(), AppError> {
        self.inner.entitlement_insert(row).await
    }
    async fn entitlement_revoke(
        &mut self,
        ws: WorkspaceId,
        id: billing::EntitlementId,
        at: OffsetDateTime,
        reason: &str,
    ) -> Result<(), AppError> {
        self.inner.entitlement_revoke(ws, id, at, reason).await
    }
    async fn activation_code_insert(
        &mut self,
        ws: WorkspaceId,
        row: billing::ActivationCodeRow,
    ) -> Result<(), AppError> {
        self.inner.activation_code_insert(ws, row).await
    }
    async fn activation_code_digest_exists(
        &mut self,
        ws: WorkspaceId,
        digest: &[u8],
    ) -> Result<bool, AppError> {
        self.inner.activation_code_digest_exists(ws, digest).await
    }
    async fn activation_code_lock_current_by_workspace(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<billing::ActivationCodeRow>, AppError> {
        self.inner
            .activation_code_lock_current_by_workspace(ws)
            .await
    }
    async fn activation_code_record_failed_attempt(
        &mut self,
        ws: WorkspaceId,
        id: billing::ActivationCodeId,
    ) -> Result<(), AppError> {
        self.inner
            .activation_code_record_failed_attempt(ws, id)
            .await
    }
    async fn activation_code_invalidate_current(
        &mut self,
        ws: WorkspaceId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.inner.activation_code_invalidate_current(ws, at).await
    }
    async fn activation_code_consume(
        &mut self,
        ws: WorkspaceId,
        id: billing::ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.inner.activation_code_consume(ws, id, at, by).await
    }
    fn operators(&mut self) -> &mut dyn OperatorRepo {
        self.inner.operators()
    }
    fn platform_sessions(&mut self) -> &mut dyn PlatformSessionRepo {
        self.inner.platform_sessions()
    }
    async fn workspaces_list(&mut self) -> Result<Vec<WorkspaceRow>, AppError> {
        self.inner.workspaces_list().await
    }
    async fn workspace_get(&mut self, ws: WorkspaceId) -> Result<Option<WorkspaceRow>, AppError> {
        self.inner.workspace_get(ws).await
    }
    async fn workspace_set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
        reason: &str,
        by: &Actor,
    ) -> Result<(), AppError> {
        self.inner
            .workspace_set_status(ws, status, reason, by)
            .await
    }
    async fn workspace_owner_email(&mut self, ws: WorkspaceId) -> Result<Option<Email>, AppError> {
        self.inner.workspace_owner_email(ws).await
    }
    async fn workspace_member_count(&mut self, ws: WorkspaceId) -> Result<i64, AppError> {
        self.inner.workspace_member_count(ws).await
    }
    async fn api_key_find_by_hash(
        &mut self,
        key_hash: &str,
    ) -> Result<Option<ApiKeyRow>, AppError> {
        self.inner.api_key_find_by_hash(key_hash).await
    }
    async fn membership_find_by_invite_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<MembershipRow>, AppError> {
        self.inner.membership_find_by_invite_hash(token_hash).await
    }
    async fn capability_by_external(
        &mut self,
        kind_keys: &[&str],
        external_id: &str,
    ) -> Result<Option<Capability>, AppError> {
        self.inner
            .capability_by_external(kind_keys, external_id)
            .await
    }
    async fn workspaces_with_verified(
        &mut self,
        kind_keys: &[&str],
    ) -> Result<Vec<WorkspaceId>, AppError> {
        self.inner.workspaces_with_verified(kind_keys).await
    }
    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.inner.ledger_append(entry).await
    }
    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.inner.commit().await
    }
}
