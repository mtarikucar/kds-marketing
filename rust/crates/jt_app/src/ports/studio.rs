//! Controller contracts. T1 owns pure domain behavior; T2 supplies durable repositories.
//! Repo calls run inside the caller's tenant transaction; no provider I/O under its locks.
use super::{
    TenantRepos,
    connectors::{MediaUpload, PublishReceipt},
};
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::{BudgetItemId, CapabilityId};
use jt_strategy::{HypothesisId, LaneKind, StrategyVersionId};
use jt_tenancy::{WorkspaceId, define_id};
use std::collections::BTreeMap;
use time::OffsetDateTime;

define_id!(ArmId);
define_id!(SlotId);
define_id!(PieceId);
define_id!(FileId);
define_id!(PublishAttemptId);
define_id!(MeasurementId);
define_id!(ReservationId);

#[derive(Clone, Debug, PartialEq)]
pub struct Chain {
    pub workspace_id: WorkspaceId,
    pub born_version_id: StrategyVersionId,
    pub hypothesis_id: HypothesisId,
    pub arm_id: ArmId,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ArmKey {
    pub hypothesis_id: HypothesisId,
    pub content_type: String,
    pub channel: String,
    pub lane: LaneKind,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Arm {
    pub id: ArmId,
    pub workspace_id: WorkspaceId,
    pub key: ArmKey,
    pub alpha: f64,
    pub beta: f64,
    pub weight: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotState {
    Planned,
    Ready,
    Published,
    Measured,
    Retired,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    pub id: SlotId,
    pub chain: Chain,
    pub capability_id: CapabilityId,
    pub scheduled_at: OffsetDateTime,
    pub state: SlotState,
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaAsset {
    HostedUrl {
        url: url::Url,
        mime: String,
        size_bytes: u64,
    },
    File {
        id: FileId,
    },
    Bytes {
        upload: MediaUpload,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelContent {
    pub text: String,
    pub media: Vec<MediaAsset>,
    pub link: Option<url::Url>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub id: PieceId,
    pub chain: Chain,
    pub revision: u64,
    pub text: String,
    pub media: Vec<MediaAsset>,
    pub adaptations: BTreeMap<String, ChannelContent>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishState {
    Queued,
    Sending,
    Succeeded,
    Failed,
    Unknown,
    Refused,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PublishAttempt {
    pub id: PublishAttemptId,
    pub slot_id: SlotId,
    pub piece: Piece,
    pub executed_version_id: StrategyVersionId,
    pub control_revision: u64,
    pub state: PublishState,
}
#[derive(Clone, Debug)]
pub enum PublishOutcome {
    Succeeded(PublishReceipt),
    Failed(AppError),
    Unknown(AppError),
    Refused(AppError),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    pub id: MeasurementId,
    pub chain: Chain,
    pub evidence_key: String,
    pub measured_at: OffsetDateTime,
    pub raw_metrics: BTreeMap<String, Option<i64>>,
    pub metric_scope: String,
    pub currency: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LearningUpdate {
    pub chain: Chain,
    pub evidence_key: String,
    pub alpha_delta: f64,
    pub beta_delta: f64,
    pub weight_delta: f64,
    pub derived_confidence: f32,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReserveSpend {
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub budget_item_ids: Vec<BudgetItemId>,
    pub lane: LaneKind,
    pub executed_version_id: StrategyVersionId,
    pub amount_minor: i64,
    pub currency: String,
    pub evidence_key: String,
    pub at: OffsetDateTime,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SpendReservation {
    pub id: ReservationId,
    pub request: ReserveSpend,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpendOutcome {
    Settled {
        actual_minor: i64,
        evidence_key: String,
    },
    Refused,
    Unknown,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaneControl {
    pub brake_engaged: bool,
    pub requires_human_approval: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioControl {
    pub workspace_id: WorkspaceId,
    pub brake_engaged: bool,
    pub revision: u64,
    pub lanes: BTreeMap<LaneKind, LaneControl>,
}

/// Pending T2: refuse explicitly rather than pretend persistence or spend authorization succeeded.
fn unavailable() -> AppError {
    AppError::internal("Studio persistence is not configured")
}
#[async_trait]
pub trait StudioRepo: Send + Sync {
    async fn insert_arm(&mut self, _arm: Arm) -> Result<Arm, AppError> {
        Err(unavailable())
    }
    async fn get_slot(&mut self, _id: SlotId) -> Result<Option<Slot>, AppError> {
        Err(unavailable())
    }
    async fn insert_slots(
        &mut self,
        _run_key: &str,
        _slots: Vec<Slot>,
    ) -> Result<Vec<Slot>, AppError> {
        Err(unavailable())
    }
    async fn save_piece(
        &mut self,
        _slot: SlotId,
        _expected_revision: u64,
        _piece: Piece,
        _key: &str,
    ) -> Result<Slot, AppError> {
        Err(unavailable())
    }
    async fn claim_publication(
        &mut self,
        _now: OffsetDateTime,
    ) -> Result<Option<PublishAttempt>, AppError> {
        Err(unavailable())
    }
    async fn finish_publication(
        &mut self,
        _attempt: PublishAttemptId,
        _outcome: PublishOutcome,
    ) -> Result<(), AppError> {
        Err(unavailable())
    }
    async fn record_measurement(&mut self, _measurement: Measurement) -> Result<bool, AppError> {
        Err(unavailable())
    }
    async fn apply_learning(&mut self, _update: LearningUpdate) -> Result<bool, AppError> {
        Err(unavailable())
    }
}
#[async_trait]
pub trait StudioBudgetRepo: Send + Sync {
    async fn reserve(&mut self, _request: ReserveSpend) -> Result<SpendReservation, AppError> {
        Err(unavailable())
    }
    async fn settle(&mut self, _id: ReservationId, _outcome: SpendOutcome) -> Result<(), AppError> {
        Err(unavailable())
    }
}
#[async_trait]
pub trait StudioControlRepo: Send + Sync {
    async fn lock_control(&mut self) -> Result<StudioControl, AppError> {
        Err(unavailable())
    }
    async fn set_brake(
        &mut self,
        _expected_revision: u64,
        _lane: Option<LaneKind>,
        _engaged: bool,
    ) -> Result<StudioControl, AppError> {
        Err(unavailable())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrategyChange {
    pub previous: Option<StrategyVersionId>,
    pub current: Option<StrategyVersionId>,
    pub kept: Vec<HypothesisId>,
    pub retired: Vec<HypothesisId>,
    pub added: Vec<HypothesisId>,
    pub at: OffsetDateTime,
}
/// Runs inside the transition transaction. Must not call external providers.
#[async_trait]
pub trait StrategyTransitionHook: Send + Sync {
    async fn apply(
        &self,
        repos: &mut dyn TenantRepos,
        change: &StrategyChange,
    ) -> Result<(), AppError>;
}
/// Baseline has no Studio queue; T3 wires its transactional cancellation hook.
pub struct NoStrategyTransition;
#[async_trait]
impl StrategyTransitionHook for NoStrategyTransition {
    async fn apply(
        &self,
        _repos: &mut dyn TenantRepos,
        _change: &StrategyChange,
    ) -> Result<(), AppError> {
        Ok(())
    }
}
