//! Durable Studio repositories; pure records live in jt_studio.
//! Repo calls run inside the caller's tenant transaction; no provider I/O under its locks.
use super::{TenantRepos, connectors::PublishReceipt, files::StoredFile};
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

/// Half-open schedule window; optional filters compose with AND.
#[derive(Clone, Debug)]
pub struct SlotQuery {
    pub from: OffsetDateTime,
    pub until: OffsetDateTime,
    pub hypothesis_id: Option<HypothesisId>,
    pub lane: Option<LaneKind>,
}
#[async_trait]
pub trait StudioRepo: Send + Sync {
    async fn list_slots(&mut self, query: SlotQuery) -> Result<Vec<Slot>, AppError>;
    async fn retire_slot(
        &mut self,
        id: SlotId,
        expected_revision: u64,
        reason: &str,
    ) -> Result<Slot, AppError>;
    async fn save_file(&mut self, file: StoredFile) -> Result<(), AppError>;
    async fn get_file(&mut self, id: FileId) -> Result<Option<StoredFile>, AppError>;
    async fn save_trend(&mut self, signal: TrendSignal, key: &str)
    -> Result<TrendSignal, AppError>;
    async fn bind_adset(
        &mut self,
        binding: AdSetBinding,
        key: &str,
    ) -> Result<AdSetBinding, AppError>;
    async fn save_budget_move(
        &mut self,
        move_: BudgetMove,
        key: &str,
    ) -> Result<BudgetMove, AppError>;
    async fn insert_arm(&mut self, arm: Arm) -> Result<Arm, AppError>;
    async fn get_slot(&mut self, id: SlotId) -> Result<Option<Slot>, AppError>;
    async fn insert_slots(
        &mut self,
        run_key: &str,
        slots: Vec<Slot>,
    ) -> Result<Vec<Slot>, AppError>;
    async fn save_piece(
        &mut self,
        slot: SlotId,
        expected_revision: u64,
        piece: Piece,
        key: &str,
    ) -> Result<Slot, AppError>;
    async fn claim_publication(
        &mut self,
        now: OffsetDateTime,
    ) -> Result<Option<PublishAttempt>, AppError>;
    async fn finish_publication(
        &mut self,
        attempt: PublishAttemptId,
        outcome: PublishOutcome,
    ) -> Result<(), AppError>;
    async fn record_measurement(&mut self, measurement: Measurement) -> Result<bool, AppError>;
    async fn apply_learning(&mut self, update: LearningUpdate) -> Result<bool, AppError>;
}
#[async_trait]
pub trait StudioBudgetRepo: Send + Sync {
    async fn reserve(&mut self, request: ReserveSpend) -> Result<SpendReservation, AppError>;
    async fn settle(&mut self, id: ReservationId, outcome: SpendOutcome) -> Result<(), AppError>;
}
#[async_trait]
pub trait StudioControlRepo: Send + Sync {
    async fn lock_control(&mut self) -> Result<StudioControl, AppError>;
    async fn set_brake(
        &mut self,
        expected_revision: u64,
        lane: Option<LaneKind>,
        engaged: bool,
    ) -> Result<StudioControl, AppError>;
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
