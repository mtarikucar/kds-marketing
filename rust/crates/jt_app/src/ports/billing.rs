//! Durable one-time payment evidence, permanent grants and owner activation challenges.
use super::Masked;
use crate::error::AppError;
use async_trait::async_trait;
use jt_tenancy::{OperatorId, UserId, WorkspaceId, define_id};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

define_id!(PaymentId);
define_id!(EntitlementId);
define_id!(ActivationCodeId);

#[derive(Clone, PartialEq, Eq)]
pub struct PaymentNotification {
    pub id: PaymentId,
    pub workspace_id: WorkspaceId,
    pub reported_by: UserId,
    pub reference_sealed: Vec<u8>,
    pub request_key: String,
    pub amount_minor: i64,
    pub currency: String,
    pub paid_at: OffsetDateTime,
    pub reported_at: OffsetDateTime,
}
impl std::fmt::Debug for PaymentNotification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaymentNotification")
            .field("id", &self.id)
            .field("workspace_id", &self.workspace_id)
            .field("reference_sealed", &Masked)
            .field("request_key", &Masked)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntitlementSource {
    Paid,
    Grandfathered,
}
impl EntitlementSource {
    pub fn key(self) -> &'static str {
        match self {
            Self::Paid => "paid",
            Self::Grandfathered => "grandfathered",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "paid" => Some(Self::Paid),
            "grandfathered" => Some(Self::Grandfathered),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntitlement {
    pub id: EntitlementId,
    pub workspace_id: WorkspaceId,
    pub source: EntitlementSource,
    pub payment_id: Option<PaymentId>,
    pub confirmed_by: Option<OperatorId>,
    pub confirmed_at: OffsetDateTime,
    pub activated_at: Option<OffsetDateTime>,
    pub redeemed_by: Option<UserId>,
    pub revoked_at: Option<OffsetDateTime>,
    pub reason: Option<String>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct ActivationCodeRow {
    pub id: ActivationCodeId,
    pub workspace_id: WorkspaceId,
    pub entitlement_id: EntitlementId,
    pub action: String,
    pub digest: Vec<u8>,
    pub issued_by: OperatorId,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub attempts: i32,
    pub invalidated_at: Option<OffsetDateTime>,
    pub consumed_at: Option<OffsetDateTime>,
    pub redeemed_by: Option<UserId>,
}
impl std::fmt::Debug for ActivationCodeRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivationCodeRow")
            .field("id", &self.id)
            .field("workspace_id", &self.workspace_id)
            .field("digest", &Masked)
            .finish_non_exhaustive()
    }
}
/// Writers acquire the workspace lock first and retain it until the bundle commits/drops.
#[async_trait]
pub trait BillingRepo: Send + Sync {
    async fn get_payment(&mut self, id: PaymentId)
    -> Result<Option<PaymentNotification>, AppError>;
    async fn find_request(&mut self, key: &str) -> Result<Option<PaymentNotification>, AppError>;
    async fn insert_payment(&mut self, row: PaymentNotification) -> Result<(), AppError>;
    /// Stable normalized reference; random collision retries happen inside the workspace lock.
    async fn reference_get_or_create(&mut self) -> Result<String, AppError>;
    /// The open grant, whether activated or awaiting redemption.
    async fn entitlement(&mut self) -> Result<Option<WorkspaceEntitlement>, AppError>;
    async fn activate_entitlement(
        &mut self,
        id: EntitlementId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError>;
}
#[async_trait]
pub trait ActivationCodeRepo: Send + Sync {
    async fn insert(&mut self, row: ActivationCodeRow) -> Result<(), AppError>;
    /// Newest noninvalidated challenge, INCLUDING consumed challenges for replay refusal.
    async fn lock_current_by_workspace(&mut self) -> Result<Option<ActivationCodeRow>, AppError>;
    async fn record_failed_attempt(&mut self, id: ActivationCodeId) -> Result<(), AppError>;
    async fn invalidate_current(&mut self, at: OffsetDateTime) -> Result<(), AppError>;
    async fn consume(
        &mut self,
        id: ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError>;
}
