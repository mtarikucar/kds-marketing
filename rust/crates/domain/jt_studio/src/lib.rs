//! Growth studio identity, lifecycle and evidence. Pure rules; no provider or database I/O.
//! Stored records are validated before writes. Execution authorization must additionally read
//! the current workspace, capability, policy, brake and spend gates in the application layer.
mod chain;
mod control;
mod ids;
mod learning;
mod measurement;
mod paid;
mod piece;
mod planning;
mod publication;
mod slot;
pub mod time_compat;
mod trend;

pub use chain::*;
pub use control::*;
pub use ids::*;
pub use learning::*;
pub use measurement::*;
pub use paid::*;
pub use piece::*;
pub use planning::*;
pub use publication::*;
pub use slot::*;
pub use trend::*;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StudioError {
    #[error("incomplete studio identity: {0}")]
    InvalidIdentity(&'static str),
    #[error("studio chain mismatch: {0}")]
    ChainMismatch(&'static str),
    #[error("a current approved strategy is required")]
    StrategyRequired,
    #[error("hypothesis is not live in the strategy")]
    HypothesisInactive,
    #[error("target channel, group or lane is not selected and supported")]
    TargetNotSelected,
    #[error("invalid planning: {0}")]
    InvalidPlanning(&'static str),
    #[error("invalid learning parameters")]
    InvalidLearning,
    #[error("stale studio revision")]
    RevisionConflict,
    #[error("studio revision exhausted")]
    RevisionOverflow,
    #[error("human approval is required for this revision")]
    ApprovalRequired,
    #[error("invalid slot transition")]
    InvalidTransition,
    #[error("invalid studio evidence: {0}")]
    InvalidEvidence(&'static str),
    #[error("raw media must be normalized to a stored file before persistence")]
    UnstoredMedia,
}

pub(crate) fn require_id(id: uuid::Uuid, field: &'static str) -> Result<(), StudioError> {
    if id.is_nil() {
        Err(StudioError::InvalidIdentity(field))
    } else {
        Ok(())
    }
}
