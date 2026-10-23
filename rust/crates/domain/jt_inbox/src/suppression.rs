//! Reasons to suppress commercial contact, independent of consent history.

use serde::{Deserialize, Serialize};

use crate::{Channel, PersonId};

/// Why commercial contact must stop on this channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionReason {
    /// The recipient unsubscribed.
    Unsubscribe,
    /// Delivery bounced.
    Bounce,
    /// The recipient complained.
    Complaint,
    /// A workspace manager suppressed contact.
    Manual,
}

/// An active suppression; persistence keys it by person, channel and reason within a tenant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suppression {
    /// Suppressed person.
    pub person_id: PersonId,
    /// Suppressed contact channel.
    pub channel: Channel,
    /// Independent cause of suppression.
    pub reason: SuppressionReason,
}
