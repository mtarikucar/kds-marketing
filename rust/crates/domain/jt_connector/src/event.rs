//! Inbound events: what webhooks and polls bring in, deduplicated per provider.

use jt_capability::CapabilityId;
use jt_tenancy::{WorkspaceId, define_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::provider::Provider;

define_id!(
    /// An inbound event.
    InboundEventId
);

/// What an inbound event is about. A kind this binary does not know is kept as its original key
/// (`Unknown`), so an event stored by a newer binary still reads and writes back unchanged.
///
/// Serialised as its key. A missing kind reads as `Unknown("")`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum EventKind {
    /// A message from a person (an SMS, a DM, a WhatsApp message).
    Message,
    /// A delivery or read status of a message sent earlier.
    Status,
    /// A lead-gen form submission.
    LeadGen,
    /// A call event (incoming, answered, hung up, a call record).
    CallEvent,
    /// A consent change (İYS).
    Consent,
    /// Any other kind, by its original key.
    Unknown(String),
}

impl EventKind {
    /// The stable key, e.g. `"lead_gen"`; for `Unknown`, the original key.
    pub fn key(&self) -> &str {
        match self {
            EventKind::Message => "message",
            EventKind::Status => "status",
            EventKind::LeadGen => "lead_gen",
            EventKind::CallEvent => "call_event",
            EventKind::Consent => "consent",
            EventKind::Unknown(key) => key,
        }
    }

    /// The kind with this key (exact, case-sensitive); any other key is `Unknown(key)`, so
    /// `Unknown` never holds a known key when built here.
    pub fn parse(key: &str) -> EventKind {
        match key {
            "message" => EventKind::Message,
            "status" => EventKind::Status,
            "lead_gen" => EventKind::LeadGen,
            "call_event" => EventKind::CallEvent,
            "consent" => EventKind::Consent,
            other => EventKind::Unknown(other.to_owned()),
        }
    }
}

impl Default for EventKind {
    fn default() -> Self {
        EventKind::Unknown(String::new())
    }
}

impl From<String> for EventKind {
    fn from(key: String) -> Self {
        EventKind::parse(&key)
    }
}

impl From<EventKind> for String {
    fn from(kind: EventKind) -> Self {
        kind.key().to_owned()
    }
}

/// One event a provider sent or a poll found, routed to a workspace and deduplicated by
/// `(workspace_id, provider, external_id)` ([`dedupe_key`]). Ledger-free: events are records of
/// the outside world, not actions of the workspace.
///
/// Stored, so reading is tolerant: an unknown field is ignored and every missing field but the
/// identity (`id`, `workspace_id`, `provider`, `external_id`) reads as the default named on it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InboundEvent {
    pub id: InboundEventId,
    pub workspace_id: WorkspaceId,
    pub provider: Provider,
    /// The capability it arrived through, when known. Missing reads as `None`.
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
    /// The provider's id of the event (a `mid`, a `wamid`, a NetGSM `gorevid`, ...), unique per
    /// provider within a workspace.
    pub external_id: String,
    /// Missing reads as `Unknown("")`.
    #[serde(default)]
    pub kind: EventKind,
    /// The parsed body, as the provider sent it. Missing reads as `null`.
    #[serde(default)]
    pub payload: Value,
    /// Missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub received_at: OffsetDateTime,
    /// When it was handed on; `None` while pending. Missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub processed_at: Option<OffsetDateTime>,
}

fn epoch() -> OffsetDateTime {
    OffsetDateTime::UNIX_EPOCH
}

/// The deduplication key of an event within a workspace: `"<provider key>:<external_id>"`, e.g.
/// `"meta:wamid.HBg..."`.
pub fn dedupe_key(provider: Provider, external_id: &str) -> String {
    format!("{}:{external_id}", provider.key())
}
