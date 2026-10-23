use crate::{
    AdSetBindingId, ApprovalReceipt, BudgetMoveId, Chain, ReservationId, StudioError, StudioPolicy,
    require_id,
};
use jt_capability::{BudgetItemId, CapabilityId};
use jt_strategy::{LaneKind, StrategyVersionId};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// References an externally created set; there is deliberately no creation payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdSetBinding {
    pub id: AdSetBindingId,
    pub chain: Chain,
    pub capability_id: CapabilityId,
    pub account_id: String,
    pub adset_id: String,
    pub campaign_id: Option<String>,
}
impl AdSetBinding {
    pub fn validate(&self) -> Result<(), StudioError> {
        self.chain.validate()?;
        require_id(self.id.0, "binding_id")?;
        require_id(self.capability_id.0, "capability_id")?;
        if self.account_id.trim().is_empty()
            || self.adset_id.trim().is_empty()
            || self
                .campaign_id
                .as_ref()
                .is_some_and(|id| id.trim().is_empty())
        {
            return Err(StudioError::InvalidEvidence("external ad set identity"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMoveState {
    Queued,
    Sending,
    Succeeded,
    Failed,
    Unknown,
    Refused,
    Cancelled,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetMove {
    pub id: BudgetMoveId,
    pub chain: Chain,
    pub binding_id: AdSetBindingId,
    pub revision: u64,
    pub daily_budget_minor: i64,
    pub currency: String,
    pub state: BudgetMoveState,
    pub approval: Option<ApprovalReceipt>,
    pub reservation_id: Option<ReservationId>,
    pub executed_version_id: Option<StrategyVersionId>,
}
impl BudgetMove {
    pub fn validate_for_binding(&self, binding: &AdSetBinding) -> Result<(), StudioError> {
        binding.validate()?;
        self.chain.require_same(&binding.chain)?;
        require_id(self.id.0, "budget_move_id")?;
        if self.binding_id != binding.id {
            return Err(StudioError::ChainMismatch("budget binding"));
        }
        if self.revision == 0 {
            return Err(StudioError::RevisionConflict);
        }
        if self.daily_budget_minor < 0 || jt_strategy::validate_currency(&self.currency).is_err() {
            return Err(StudioError::InvalidEvidence("daily budget/currency"));
        }
        if let Some(id) = self.reservation_id {
            require_id(id.0, "reservation_id")?;
        }
        if let Some(id) = self.executed_version_id {
            require_id(id.0, "executed_version_id")?;
        }
        if matches!(
            self.state,
            BudgetMoveState::Sending | BudgetMoveState::Succeeded | BudgetMoveState::Unknown
        ) && (self.reservation_id.is_none() || self.executed_version_id.is_none())
        {
            return Err(StudioError::InvalidEvidence("budget execution fence"));
        }
        Ok(())
    }
    pub fn check_approval(&self, policy: &StudioPolicy) -> Result<(), StudioError> {
        if self.revision != policy.expected_revision {
            return Err(StudioError::RevisionConflict);
        }
        StudioPolicy {
            approval: self.approval.clone(),
            ..policy.clone()
        }
        .check_approval(self.revision)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendReservation {
    pub id: ReservationId,
    pub request: ReserveSpend,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SpendOutcome {
    Settled {
        actual_minor: i64,
        evidence_key: String,
    },
    Refused,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdStatus {
    Paused,
    Active,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BindingStatusOutcome {
    Applied { observed: AdStatus },
    Unknown,
    Failed,
}
/// A pending/unknown pause never implies the provider is stopped. T8 persists each outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingControl {
    pub binding_id: AdSetBindingId,
    pub chain: Chain,
    pub desired: AdStatus,
    pub observed: Option<AdStatus>,
    pub paused_by_brake: bool,
    pub outcome: Option<BindingStatusOutcome>,
    pub at: OffsetDateTime,
}
impl BindingControl {
    pub fn record(&self, outcome: BindingStatusOutcome, at: OffsetDateTime) -> Self {
        let observed = match outcome {
            BindingStatusOutcome::Applied { observed } => Some(observed),
            _ => None,
        };
        Self {
            observed,
            outcome: Some(outcome),
            at,
            ..self.clone()
        }
    }
    pub fn confirmed_paused(&self) -> bool {
        self.observed == Some(AdStatus::Paused)
            && matches!(
                self.outcome,
                Some(BindingStatusOutcome::Applied {
                    observed: AdStatus::Paused
                })
            )
    }
}
