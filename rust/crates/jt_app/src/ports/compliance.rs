//! Compliance persistence. Tenant-bound repos share the inbox unit-of-work transaction.
use super::connectors::{DeliveryStatus, MailboxCursor};
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuoteRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    #[serde(flatten)]
    pub quote: Quote,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppointmentRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    #[serde(flatten)]
    pub appointment: Appointment,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommissionRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    #[serde(flatten)]
    pub commission: Commission,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErasureLog {
    pub workspace_id: WorkspaceId,
    pub person_id: PersonId,
    pub requested_via: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}
/// Immutable first acquisition. Nullable upstream identifiers are never inferred.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyAttribution {
    pub workspace_id: WorkspaceId,
    pub journey_id: JourneyId,
    pub provider: String,
    pub ad_id: Option<String>,
    pub adset_id: Option<String>,
    pub campaign_id: Option<String>,
    pub form_id: Option<String>,
    pub leadgen_id: String,
    #[serde(with = "time::serde::rfc3339")]
    pub acquired_at: OffsetDateTime,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundJobState {
    Queued,
    Sent,
    Delivered,
    Failed,
    Unknown,
    Refused,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundJobRow {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    /// Missing after an uncertain provider submission must remain missing.
    pub provider_job_id: Option<String>,
    pub message_id: Option<MessageId>,
    pub state: OutboundJobState,
    pub last_status: Option<DeliveryStatus>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}
#[async_trait]
pub trait ConsentRepo: Send + Sync {
    async fn insert(&mut self, row: Consent) -> Result<(), AppError>;
    /// Ascending (effective time,id); effective_consent resolves withdrawal ties.
    async fn list(&mut self, person: PersonId) -> Result<Vec<Consent>, AppError>;
    /// Pending/retryable IYS channels (SMS/phone/email) on nonerased people only (aliases retain pending decisions).
    /// Filter before the ascending (at,id) page limit, clamped to 1..=1000.
    async fn pending_sync(&mut self, limit: u32) -> Result<Vec<Consent>, AppError>;
    /// Mutates sync metadata only; the underlying decision is immutable.
    async fn set_sync(
        &mut self,
        id: ConsentId,
        state: SyncState,
        attempts: u32,
    ) -> Result<(), AppError>;
}
#[async_trait]
pub trait SuppressionRepo: Send + Sync {
    /// Idempotent by (person,channel,reason).
    async fn insert(&mut self, row: Suppression) -> Result<(), AppError>;
    async fn list(&mut self, person: PersonId) -> Result<Vec<Suppression>, AppError>;
    async fn remove(
        &mut self,
        person: PersonId,
        channel: Channel,
        reason: SuppressionReason,
    ) -> Result<(), AppError>;
}
#[async_trait]
pub trait QuoteRepo: Send + Sync {
    async fn insert(&mut self, row: QuoteRow) -> Result<(), AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<QuoteRow>, AppError>;
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<QuoteRow>, AppError>;
    async fn set_state(&mut self, id: Uuid, state: QuoteState) -> Result<(), AppError>;
}
#[async_trait]
pub trait AppointmentRepo: Send + Sync {
    async fn insert(&mut self, row: AppointmentRow) -> Result<(), AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<AppointmentRow>, AppError>;
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<AppointmentRow>, AppError>;
    async fn set_state(&mut self, id: Uuid, state: AppointmentState) -> Result<(), AppError>;
}
#[async_trait]
pub trait CommissionRepo: Send + Sync {
    /// Duplicate journey or id is CONFLICT; never overwrites the won snapshot.
    async fn insert(&mut self, row: CommissionRow) -> Result<(), AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<CommissionRow>, AppError>;
    async fn by_journey(&mut self, journey: JourneyId) -> Result<Option<CommissionRow>, AppError>;
    async fn list(&mut self) -> Result<Vec<CommissionRow>, AppError>;
    async fn set_state(&mut self, id: Uuid, state: CommissionState) -> Result<(), AppError>;
    async fn default_rate(&mut self) -> Result<Option<u16>, AppError>;
    async fn set_default_rate(&mut self, rate_bp: u16) -> Result<(), AppError>;
    async fn user_rate(&mut self, user: UserId) -> Result<Option<u16>, AppError>;
    /// None removes an override so callers fall back to the workspace default.
    async fn set_user_rate(&mut self, user: UserId, rate_bp: Option<u16>) -> Result<(), AppError>;
}
#[async_trait]
pub trait ErasureRepo: Send + Sync {
    /// First request wins; replays preserve its timestamp and source.
    async fn record(&mut self, row: ErasureLog) -> Result<(), AppError>;
    async fn get(&mut self, person: PersonId) -> Result<Option<ErasureLog>, AppError>;
    async fn remember_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<(), AppError>;
    async fn is_erased_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<bool, AppError>;
}
#[async_trait]
pub trait MailCursorRepo: Send + Sync {
    async fn get(&mut self, capability: CapabilityId) -> Result<MailboxCursor, AppError>;
    /// Upserts each supplied mailbox position in the same transaction as inbound drafts.
    async fn store(
        &mut self,
        capability: CapabilityId,
        cursor: MailboxCursor,
    ) -> Result<(), AppError>;
}
#[async_trait]
pub trait AttributionRepo: Send + Sync {
    /// First write wins globally by journey id; false denotes an existing first acquisition.
    async fn insert_once(&mut self, row: JourneyAttribution) -> Result<bool, AppError>;
    async fn by_journey(
        &mut self,
        journey: JourneyId,
    ) -> Result<Option<JourneyAttribution>, AppError>;
    /// Half-open [from,to), ascending (acquired_at,journey_id).
    async fn by_ad(
        &mut self,
        ad_id: &str,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<JourneyAttribution>, AppError>;
}
/// Committed attribution reads for analytics; each read establishes its tenant context.
#[async_trait]
pub trait AttributionReader: Send + Sync {
    async fn by_journey(
        &self,
        ws: WorkspaceId,
        journey: JourneyId,
    ) -> Result<Option<JourneyAttribution>, AppError>;
    async fn by_ad(
        &self,
        ws: WorkspaceId,
        ad_id: &str,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<JourneyAttribution>, AppError>;
}
/// Read adapter over a unit of work, usable with both Pg and in-memory implementations.
pub struct UowAttributionReader(pub std::sync::Arc<dyn super::UnitOfWork>);
#[async_trait]
impl AttributionReader for UowAttributionReader {
    async fn by_journey(
        &self,
        ws: WorkspaceId,
        journey: JourneyId,
    ) -> Result<Option<JourneyAttribution>, AppError> {
        self.0
            .tenant(ws)
            .await?
            .attribution()
            .by_journey(journey)
            .await
    }
    async fn by_ad(
        &self,
        ws: WorkspaceId,
        ad_id: &str,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<JourneyAttribution>, AppError> {
        self.0
            .tenant(ws)
            .await?
            .attribution()
            .by_ad(ad_id, from, to)
            .await
    }
}
