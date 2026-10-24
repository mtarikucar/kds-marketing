use crate::{
    Chain, Piece, PieceId, PublicationId, PublishAttemptId, Slot, SlotId, SlotState, StudioError,
    require_id,
};
use jt_capability::CapabilityId;
use jt_ledger::Actor;
use jt_strategy::StrategyVersionId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishReceipt {
    pub external_id: String,
    pub url: Option<Url>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Publication {
    pub id: PublicationId,
    pub chain: Chain,
    pub slot_id: SlotId,
    pub piece_id: PieceId,
    pub capability_id: CapabilityId,
    /// Account frozen at dispatch, used to reject later credential rebinding.
    #[serde(default)]
    pub account_id: Option<String>,
    pub executed_version_id: StrategyVersionId,
    pub external_id: String,
    pub url: Option<Url>,
    pub published_at: OffsetDateTime,
    pub actor: Actor,
    pub attempt_id: PublishAttemptId,
}
impl Publication {
    pub fn validate_for_slot(&self, slot: &Slot) -> Result<(), StudioError> {
        slot.validate()?;
        self.chain.require_same(&slot.chain)?;
        for (id, key) in [
            (self.id.0, "publication_id"),
            (self.piece_id.0, "piece_id"),
            (self.executed_version_id.0, "executed_version_id"),
            (self.attempt_id.0, "attempt_id"),
        ] {
            require_id(id, key)?;
        }
        if self.slot_id != slot.id || self.capability_id != slot.capability_id {
            return Err(StudioError::ChainMismatch("publication slot/capability"));
        }
        validate_receipt(&PublishReceipt {
            external_id: self.external_id.clone(),
            url: self.url.clone(),
        })
    }
}
fn validate_receipt(receipt: &PublishReceipt) -> Result<(), StudioError> {
    if receipt.external_id.trim().is_empty() {
        return Err(StudioError::InvalidEvidence("external_id"));
    }
    if let Some(url) = &receipt.url {
        crate::piece::validate_public_url(url)?;
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishState {
    Queued,
    Sending,
    Succeeded,
    Failed,
    Unknown,
    Refused,
}

/// Closed, redacted evidence codes: no provider message, credentials, raw payload or URL tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactedPublishError {
    Auth,
    Permission,
    Permanent,
    Throttle,
    Transient,
    Policy,
    Internal,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "evidence", rename_all = "snake_case")]
pub enum PublishOutcome {
    Succeeded(PublishReceipt),
    Failed(RedactedPublishError),
    Unknown(RedactedPublishError),
    Refused(RedactedPublishError),
}

/// Frozen dispatch snapshot. Only shared references escape; later piece edits cannot change it.
/// Deserialization is for trusted storage, followed by `validate()` before use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishAttempt {
    id: PublishAttemptId,
    slot_id: SlotId,
    piece: Piece,
    capability_id: CapabilityId,
    #[serde(default)]
    account_id: Option<String>,
    slot_revision: u64,
    executed_version_id: StrategyVersionId,
    control_revision: u64,
    actor: Actor,
    claimed_at: OffsetDateTime,
    state: PublishState,
    outcome: Option<PublishOutcome>,
}
impl PublishAttempt {
    pub fn claim(
        id: PublishAttemptId,
        slot: &Slot,
        piece: &Piece,
        executed_version_id: StrategyVersionId,
        control_revision: u64,
        actor: Actor,
        claimed_at: OffsetDateTime,
    ) -> Result<Self, StudioError> {
        slot.validate()?;
        if slot.state != SlotState::Ready {
            return Err(StudioError::InvalidTransition);
        }
        slot.chain.require_same(&piece.chain)?;
        let attempt = Self {
            id,
            slot_id: slot.id,
            piece: piece.clone(),
            capability_id: slot.capability_id,
            account_id: None,
            slot_revision: slot.revision,
            executed_version_id,
            control_revision,
            actor,
            claimed_at,
            state: PublishState::Sending,
            outcome: None,
        };
        attempt.validate()?;
        Ok(attempt)
    }
    /// Freeze the connector account before persisting this new Sending attempt.
    pub fn with_account(mut self, account_id: Option<String>) -> Self {
        self.account_id = account_id;
        self
    }
    pub fn validate(&self) -> Result<(), StudioError> {
        self.piece.validate_persisted()?;
        for (id, key) in [
            (self.id.0, "attempt_id"),
            (self.slot_id.0, "slot_id"),
            (self.capability_id.0, "capability_id"),
            (self.executed_version_id.0, "executed_version_id"),
        ] {
            require_id(id, key)?;
        }
        if self.piece.revision != self.slot_revision {
            return Err(StudioError::RevisionConflict);
        }
        match (&self.state, &self.outcome) {
            (PublishState::Queued | PublishState::Sending, None) => Ok(()),
            (PublishState::Succeeded, Some(PublishOutcome::Succeeded(receipt))) => {
                validate_receipt(receipt)
            }
            (PublishState::Failed, Some(PublishOutcome::Failed(_)))
            | (PublishState::Unknown, Some(PublishOutcome::Unknown(_)))
            | (PublishState::Refused, Some(PublishOutcome::Refused(_))) => Ok(()),
            _ => Err(StudioError::InvalidEvidence("attempt outcome")),
        }
    }
    pub fn id(&self) -> PublishAttemptId {
        self.id
    }
    pub fn slot_id(&self) -> SlotId {
        self.slot_id
    }
    pub fn piece(&self) -> &Piece {
        &self.piece
    }
    pub fn capability_id(&self) -> CapabilityId {
        self.capability_id
    }
    pub fn slot_revision(&self) -> u64 {
        self.slot_revision
    }
    pub fn executed_version_id(&self) -> StrategyVersionId {
        self.executed_version_id
    }
    pub fn control_revision(&self) -> u64 {
        self.control_revision
    }
    pub fn actor(&self) -> &Actor {
        &self.actor
    }
    pub fn claimed_at(&self) -> OffsetDateTime {
        self.claimed_at
    }
    pub fn state(&self) -> PublishState {
        self.state
    }
    pub fn outcome(&self) -> Option<&PublishOutcome> {
        self.outcome.as_ref()
    }

    /// No transition ever returns to Queued/Sending. Unknown may be resolved by read-back
    /// evidence, never by retrying publication. Replaying the same outcome is a no-op.
    pub fn finish(&self, outcome: &PublishOutcome) -> Result<Self, StudioError> {
        self.validate()?;
        if self.outcome.as_ref() == Some(outcome) {
            return Ok(self.clone());
        }
        if !matches!(self.state, PublishState::Sending | PublishState::Unknown) {
            return Err(StudioError::InvalidTransition);
        }
        let mut next = self.clone();
        next.state = match outcome {
            PublishOutcome::Succeeded(receipt) => {
                validate_receipt(receipt)?;
                PublishState::Succeeded
            }
            PublishOutcome::Failed(_) => PublishState::Failed,
            PublishOutcome::Unknown(_) => PublishState::Unknown,
            PublishOutcome::Refused(_) => PublishState::Refused,
        };
        next.outcome = Some(outcome.clone());
        Ok(next)
    }
    pub fn publication(
        &self,
        id: PublicationId,
        published_at: OffsetDateTime,
    ) -> Result<Publication, StudioError> {
        self.validate()?;
        require_id(id.0, "publication_id")?;
        let Some(PublishOutcome::Succeeded(receipt)) = &self.outcome else {
            return Err(StudioError::InvalidEvidence("no accepted receipt"));
        };
        Ok(Publication {
            id,
            chain: self.piece.chain.clone(),
            slot_id: self.slot_id,
            piece_id: self.piece.id,
            capability_id: self.capability_id,
            account_id: self.account_id.clone(),
            executed_version_id: self.executed_version_id,
            external_id: receipt.external_id.clone(),
            url: receipt.url.clone(),
            published_at,
            actor: self.actor.clone(),
            attempt_id: self.id,
        })
    }
}
