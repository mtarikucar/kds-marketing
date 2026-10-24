use crate::{
    Chain, Measurement, MeasurementStatus, Piece, Publication, SlotId, StudioError, StudioPolicy,
    require_id,
};
use jt_capability::CapabilityId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotState {
    Planned,
    Ready,
    Published,
    Measured,
    Retired,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot {
    pub id: SlotId,
    pub chain: Chain,
    pub capability_id: CapabilityId,
    pub scheduled_at: OffsetDateTime,
    pub state: SlotState,
    pub revision: u64,
}
impl Slot {
    pub fn validate(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "slot_id")?;
        require_id(self.capability_id.0, "capability_id")?;
        self.chain.validate()?;
        if matches!(
            self.state,
            SlotState::Ready | SlotState::Published | SlotState::Measured
        ) && self.revision == 0
        {
            return Err(StudioError::RevisionConflict);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetirementReason {
    Cancelled,
    HypothesisRetired,
    StrategyArchived,
    WeekEnded,
    MeasurementsComplete,
}
#[derive(Clone, Debug, PartialEq)]
pub enum SlotEvent {
    PieceSubmitted {
        piece: Piece,
    },
    Published {
        publication: Publication,
    },
    Measured {
        publication: Box<Publication>,
        measurement: Measurement,
    },
    Retire {
        reason: RetirementReason,
    },
}

/// Computes lifecycle changes without mutating evidence. Late in-flight receipts and historical
/// measurements are validated but leave retired work retired; callers append evidence separately.
pub fn transition_slot(
    slot: &Slot,
    event: &SlotEvent,
    policy: &StudioPolicy,
) -> Result<Slot, StudioError> {
    slot.validate()?;
    if slot.revision != policy.expected_revision {
        return Err(StudioError::RevisionConflict);
    }
    let target = match event {
        SlotEvent::PieceSubmitted { piece } => {
            if !matches!(slot.state, SlotState::Planned | SlotState::Ready) {
                return Err(StudioError::InvalidTransition);
            }
            piece.validate_persisted()?;
            slot.chain.require_same(&piece.chain)?;
            if piece.revision
                != slot
                    .revision
                    .checked_add(1)
                    .ok_or(StudioError::RevisionOverflow)?
            {
                return Err(StudioError::RevisionConflict);
            }
            SlotState::Ready
        }
        SlotEvent::Published { publication } => {
            publication.validate_for_slot(slot)?;
            if slot.state == SlotState::Retired {
                return Ok(slot.clone());
            }
            if slot.state != SlotState::Ready {
                return Err(StudioError::InvalidTransition);
            }
            policy.check_approval(slot.revision)?;
            SlotState::Published
        }
        SlotEvent::Measured {
            publication,
            measurement,
        } => {
            publication.validate_for_slot(slot)?;
            measurement.validate()?;
            slot.chain.require_same(&measurement.chain)?;
            if measurement.publication_id != Some(publication.id)
                || measurement.status != MeasurementStatus::Complete
            {
                return Err(StudioError::InvalidEvidence("publication measurement"));
            }
            if slot.state == SlotState::Retired {
                return Ok(slot.clone());
            }
            if !matches!(slot.state, SlotState::Published | SlotState::Measured) {
                return Err(StudioError::InvalidTransition);
            }
            SlotState::Measured
        }
        SlotEvent::Retire { reason } => {
            if slot.state == SlotState::Retired {
                return Ok(slot.clone());
            }
            let allowed = match reason {
                RetirementReason::Cancelled
                | RetirementReason::HypothesisRetired
                | RetirementReason::StrategyArchived => {
                    matches!(slot.state, SlotState::Planned | SlotState::Ready)
                }
                RetirementReason::WeekEnded => slot.state == SlotState::Planned,
                RetirementReason::MeasurementsComplete => slot.state == SlotState::Measured,
            };
            if !allowed {
                return Err(StudioError::InvalidTransition);
            }
            SlotState::Retired
        }
    };
    Ok(Slot {
        state: target,
        revision: slot
            .revision
            .checked_add(1)
            .ok_or(StudioError::RevisionOverflow)?,
        ..slot.clone()
    })
}
