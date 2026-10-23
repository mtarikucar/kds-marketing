//! Controller contracts. T1 owns pure domain behavior; T2 supplies durable repositories.
//! Repo calls run inside the caller's tenant transaction; no provider I/O under its locks.
use super::{TenantRepos, connectors::PublishReceipt};
use crate::error::AppError;
use async_trait::async_trait;
use jt_strategy::{HypothesisId, LaneKind, StrategyVersionId};
use time::OffsetDateTime;

// Keep T0 import paths and repo signatures while T1 owns the shared pure records.
pub use jt_studio::{
    AdSetBinding, AdSetBindingId, ApprovalReceipt, Arm, ArmId, ArmKey, BindingControl, BudgetMove,
    BudgetMoveId, Chain, ChannelContent, FileId, LaneControl, LearningUpdate, Measurement,
    MeasurementId, MeasurementStatus, MeasurementWindow, MediaAsset, Piece, PieceId, Publication,
    PublicationId, PublishAttempt, PublishAttemptId, PublishState, ReservationId, ReserveSpend,
    Slot, SlotId, SlotState, SpendOutcome, SpendReservation, StudioControl, TrendSignal,
    TrendSignalId,
};

/// Application transport outcome retained from T0. Repositories must map errors to the closed
/// `jt_studio::RedactedPublishError` codes before persisting domain outcome evidence; an
/// AppError message/details may contain provider diagnostics and is not durable evidence.
#[derive(Clone, Debug)]
pub enum PublishOutcome {
    Succeeded(PublishReceipt),
    Failed(AppError),
    Unknown(AppError),
    Refused(AppError),
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
