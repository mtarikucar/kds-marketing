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
    Observed(PublishReceipt),
    Succeeded(PublishReceipt),
    Failed(AppError),
    Unknown(AppError),
    Refused(AppError),
}

impl PublishOutcome {
    /// Retain only closed categories and public receipt fields, never diagnostic text.
    pub fn into_redacted(self) -> jt_studio::PublishOutcome {
        use jt_studio::PublishOutcome as O;
        match self {
            Self::Observed(mut r) => {
                if let Some(u) = &mut r.url {
                    u.set_query(None);
                    u.set_fragment(None);
                }
                O::Observed(r)
            }
            Self::Succeeded(r) => {
                let mut url = r.url;
                if let Some(u) = &mut url {
                    u.set_query(None);
                    u.set_fragment(None);
                }
                O::Succeeded(jt_studio::PublishReceipt {
                    external_id: r.external_id,
                    url,
                })
            }
            Self::Failed(e) => O::Failed(publish_error_category(&e)),
            Self::Unknown(e) => O::Unknown(publish_error_category(&e)),
            Self::Refused(e) => O::Refused(publish_error_category(&e)),
        }
    }
}
fn publish_error_category(e: &AppError) -> jt_studio::RedactedPublishError {
    use crate::error::ErrorCode as C;
    use jt_studio::RedactedPublishError as E;
    match e.details["provider_error"].as_str() {
        Some("auth") => return E::Auth,
        Some("permission") => return E::Permission,
        Some("throttle") => return E::Throttle,
        Some("transient") => return E::Transient,
        Some("permanent") => return E::Permanent,
        Some("unknown") => return E::Unknown,
        _ => {}
    }
    match e.code {
        C::Unauthenticated => E::Auth,
        C::Forbidden => E::Permission,
        C::UpstreamUnavailable if e.details["retryable"] == false => E::Unknown,
        C::UpstreamUnavailable
            if e.details["retry_after_s"].is_number() || e.details["reason"] == "rate limited" =>
        {
            E::Throttle
        }
        C::UpstreamUnavailable => E::Transient,
        C::Internal => E::Unknown,
        C::Validation | C::NotFound => E::Permanent,
        _ => E::Policy,
    }
}

/// Half-open schedule window; optional filters compose with AND.
/// `Date::MIN.midnight().assume_utc()` is an unbounded lower endpoint: adapters must not
/// encode it as a timestamp when their database has a narrower calendar range.
#[derive(Clone, Debug)]
pub struct SlotQuery {
    pub from: OffsetDateTime,
    pub until: OffsetDateTime,
    pub hypothesis_id: Option<HypothesisId>,
    pub lane: Option<LaneKind>,
}
#[async_trait]
pub trait StudioRepo: Send + Sync {
    async fn request_replay(
        &mut self,
        action: &str,
        key: &str,
        payload: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, AppError>;
    async fn request_receipt(
        &mut self,
        action: &str,
        key: &str,
        payload: &serde_json::Value,
        response: &serde_json::Value,
    ) -> Result<(), AppError>;
    async fn file_usage(&mut self) -> Result<super::files::FileUsage, AppError>;

    /// Tenant-scoped planning and work projections; never a second queue.
    /// Historical evidence reads and weekly posterior persistence, within the tenant transaction.
    async fn list_publications(&mut self) -> Result<Vec<Publication>, AppError>;
    async fn list_measurements(&mut self) -> Result<Vec<Measurement>, AppError>;
    async fn list_trends(&mut self) -> Result<Vec<TrendSignal>, AppError>;
    async fn save_arm_weights(&mut self, arms: Vec<Arm>) -> Result<(), AppError>;
    async fn list_arms(&mut self) -> Result<Vec<Arm>, AppError>;
    async fn list_budget_moves(&mut self) -> Result<Vec<BudgetMove>, AppError>;
    async fn slot_evidence(
        &mut self,
        slot: SlotId,
    ) -> Result<(Vec<PublishAttempt>, Vec<Measurement>), AppError>;
    async fn get_trend(&mut self, id: TrendSignalId) -> Result<Option<TrendSignal>, AppError>;

    async fn get_approval(
        &mut self,
        target: ApprovalTarget,
        revision: u64,
    ) -> Result<Option<ApprovalReceipt>, AppError>;
    async fn get_arm(&mut self, id: ArmId) -> Result<Option<Arm>, AppError>;
    async fn get_piece(&mut self, slot: SlotId, revision: u64) -> Result<Option<Piece>, AppError>;
    async fn get_budget_move(&mut self, id: BudgetMoveId) -> Result<Option<BudgetMove>, AppError>;
    /// Most recently created move for this binding; older consent cannot authorize a newer move.
    async fn latest_budget_move(
        &mut self,
        binding: AdSetBindingId,
    ) -> Result<Option<BudgetMove>, AppError>;
    async fn get_publication(&mut self, id: PublicationId)
    -> Result<Option<Publication>, AppError>;
    async fn get_binding(&mut self, id: AdSetBindingId) -> Result<Option<AdSetBinding>, AppError>;
    async fn list_bindings(&mut self) -> Result<Vec<AdSetBinding>, AppError>;
    /// Consent changes metadata only, under the frame/control locks. Payload is immutable.
    async fn approve_target(
        &mut self,
        target: ApprovalTarget,
        receipt: ApprovalReceipt,
    ) -> Result<(), AppError>;
    /// Retire only queued work; never erase evidence, learning or in-flight outcomes.
    async fn apply_transition(&mut self, change: &StrategyChange) -> Result<(), AppError>;

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
    /// A fresh key with the same binding identity explicitly refreshes verification.
    /// Refresh cancels queued moves/consent and clears pending status intent; old receipts remain.
    async fn bind_adset(
        &mut self,
        binding: AdSetBinding,
        key: &str,
    ) -> Result<AdSetBinding, AppError>;
    /// Compare and swap durable dispatch state; payload and identity stay immutable.
    async fn transition_budget_move(
        &mut self,
        move_: BudgetMove,
        expected: jt_studio::BudgetMoveState,
    ) -> Result<(), AppError>;
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
    /// Claim only the candidate authorized by the dispatcher. Existing generic claim callers
    /// retain their contract; unsupported wrappers fail closed rather than claim another slot.
    async fn claim_publication_for(
        &mut self,
        slot: SlotId,
        now: OffsetDateTime,
    ) -> Result<Option<PublishAttempt>, AppError> {
        let _ = (slot, now);
        Err(AppError::internal("targeted publication claim unsupported"))
    }
    /// Record when completion was observed; replay keeps the first observation unchanged.
    async fn finish_publication(
        &mut self,
        attempt: PublishAttemptId,
        outcome: PublishOutcome,
        observed_at: OffsetDateTime,
    ) -> Result<(), AppError>;
    async fn record_measurement(&mut self, measurement: Measurement) -> Result<bool, AppError>;
    async fn apply_learning(&mut self, update: LearningUpdate) -> Result<bool, AppError>;
}
#[async_trait]
pub trait StudioBudgetRepo: Send + Sync {
    async fn list_reservations(
        &mut self,
    ) -> Result<Vec<(SpendReservation, Option<SpendOutcome>)>, AppError>;
    async fn find_reservation(
        &mut self,
        evidence_key: &str,
    ) -> Result<Option<SpendReservation>, AppError>;
    async fn reserve(&mut self, request: ReserveSpend) -> Result<SpendReservation, AppError>;
    async fn settle(&mut self, id: ReservationId, outcome: SpendOutcome) -> Result<(), AppError>;
}
#[async_trait]
pub trait StudioControlRepo: Send + Sync {
    async fn set_policy(
        &mut self,
        expected_revision: u64,
        lane: LaneKind,
        requires_human_approval: bool,
    ) -> Result<StudioControl, AppError>;
    async fn binding_control(
        &mut self,
        id: AdSetBindingId,
    ) -> Result<Option<BindingControl>, AppError>;
    async fn save_binding_control(&mut self, control: BindingControl) -> Result<(), AppError>;

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

/// Strict shared target shape on HTTP and MCP; a consent receipt names its immutable revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalTarget {
    Slot(SlotId),
    BudgetMove(BudgetMoveId),
}
