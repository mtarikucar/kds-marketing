//! Contact-channel consent history and commercial-send eligibility. No provider I/O.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Channel, ConsentId, PersonId, Suppression};

/// The customer's decision, independent of synchronization with a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentKind {
    /// Express permission for commercial contact.
    Explicit,
    /// Permission implied by the customer contract.
    ImpliedByContract,
    /// Permission was withdrawn; wins ties at the same instant.
    Withdrawn,
}

/// Where a consent decision originated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentSource {
    /// A submitted form.
    Form,
    /// Recorded by an agent.
    Agent,
    /// Imported history.
    Import,
    /// Received from İYS.
    IysSync,
    /// Directly supplied by the customer.
    Customer,
}

/// Delivery state of the consent decision to İYS.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Not yet sent.
    #[default]
    Pending,
    /// Provider acknowledged it.
    Sent,
    /// A retryable attempt failed.
    Failed,
    /// Retry budget exhausted; requires human attention.
    FailedFinal,
}

/// One immutable decision in a person's contact-channel consent history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consent {
    /// Decision identity.
    pub id: ConsentId,
    /// Person whose permission changed.
    pub person_id: PersonId,
    /// Contact channel; SMS and telephone consent remain distinct.
    pub channel: Channel,
    /// Grant or withdrawal.
    pub kind: ConsentKind,
    /// Origin of the decision.
    pub source: ConsentSource,
    /// Effective time, not insertion time.
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Provider synchronization never overrides the local decision.
    #[serde(default)]
    pub sync_state: SyncState,
    /// Number of attempted synchronizations.
    #[serde(default)]
    pub attempts: u32,
}

/// Commercial contact is forbidden without effective permission or with suppression.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("IZIN_YOK")]
pub struct IzinYok;

/// Latest decision for exactly one person and contact channel, independent of insertion order.
/// Withdrawals win equal-time ties; remaining ties use the id for deterministic selection.
pub fn effective_consent(
    consents: &[Consent],
    person_id: PersonId,
    channel: Channel,
) -> Option<&Consent> {
    consents
        .iter()
        .filter(|c| c.person_id == person_id && c.channel == channel)
        .max_by_key(|c| (c.at, c.kind == ConsentKind::Withdrawn, c.id))
}

/// Check one person's consent/suppression snapshot for a commercial contact.
///
/// Callers supply tenant- and person-scoped rows. Missing permission and mixed-person input
/// fail closed; consent is checked by contact channel, never by shared identity namespace.
pub fn commercial_allowed(
    consents: &[Consent],
    suppressions: &[Suppression],
    channel: Channel,
) -> Result<(), IzinYok> {
    let person_id = consents.first().ok_or(IzinYok)?.person_id;
    if consents.iter().any(|c| c.person_id != person_id)
        || suppressions
            .iter()
            .any(|s| s.person_id != person_id || s.channel == channel)
    {
        return Err(IzinYok);
    }
    match effective_consent(consents, person_id, channel).map(|c| c.kind) {
        Some(ConsentKind::Explicit | ConsentKind::ImpliedByContract) => Ok(()),
        Some(ConsentKind::Withdrawn) | None => Err(IzinYok),
    }
}
