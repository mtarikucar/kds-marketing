//! People, acquisition attribution and event actors.

use jt_capability::CapabilityId;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{Channel, PersonId, epoch};

/// How a person was acquired, independently of the actor that records an event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// First contact through a messaging or telephone channel.
    Channel(Channel),
    /// Acquisition through a Meta advertisement.
    MetaAds,
    /// An imported contact.
    Import,
    /// A submitted form.
    Form,
    /// A returning customer starting a later journey.
    Repeat,
    /// Promoted from the workspace's prospect pool: the prospect and how it entered the pool
    /// (`research_task`, `manual`, `agent`, `v1_import`, `system`).
    Prospect {
        /// The promoted prospect.
        prospect_id: Uuid,
        /// The prospect's origin.
        origin: String,
    },
    /// Provenance preserved by the operator-only v1 lead import.
    #[serde(untagged)]
    V1Import {
        /// Fixed import discriminator.
        kind: String,
        /// Fixed legacy system discriminator.
        system: String,
        /// Legacy lead identifier.
        v1_lead_id: String,
        /// Legacy acquisition source.
        v1_source: String,
        /// Original legacy funnel stage.
        v1_status: String,
    },
}

/// A person's original acquisition attribution; merging preserves the keeper's first touch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstTouch {
    /// The original acquisition source; required on read.
    pub source: Source,
    /// The capability responsible, if any; missing reads as `None`.
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
    /// When the acquisition occurred; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// Whom a commercial message would reach: a business's own contact point or a private
/// individual. Unknown until promotion or a person sets it; the commercial basis of outreach
/// reads it (spec 2026-10-30-leads-pool-outreach-design.md §3.12).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipientKind {
    /// Not known.
    #[default]
    Unknown,
    /// A business (a promoted prospect, or set by a person).
    Business,
    /// A private individual; only a person sets it, and promotion never overrides it.
    Individual,
}

impl RecipientKind {
    /// Every kind, in declaration order.
    pub const ALL: &'static [RecipientKind] = &[
        RecipientKind::Unknown,
        RecipientKind::Business,
        RecipientKind::Individual,
    ];

    /// The kind's stored name.
    pub fn key(self) -> &'static str {
        match self {
            RecipientKind::Unknown => "unknown",
            RecipientKind::Business => "business",
            RecipientKind::Individual => "individual",
        }
    }

    /// The kind a stored name names.
    pub fn parse(s: &str) -> Option<RecipientKind> {
        RecipientKind::ALL.iter().copied().find(|k| k.key() == s)
    }
}

/// A tenant's person, with original attribution and optional merge/erasure markers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    /// The person's id.
    pub id: PersonId,
    /// The tenant that owns the person.
    pub workspace_id: WorkspaceId,
    /// The person's display name; missing reads as empty.
    #[serde(default)]
    pub display_name: String,
    /// The person's company; missing reads as empty.
    #[serde(default)]
    pub company: String,
    /// Whom a commercial message to this person reaches; missing reads as `Unknown`.
    #[serde(default)]
    pub recipient_kind: RecipientKind,
    /// Original acquisition attribution; required and never fabricated on read.
    pub first_touch: FirstTouch,
    /// The keeper when this person was merged; missing reads as `None`.
    #[serde(default)]
    pub merged_into: Option<PersonId>,
    /// When personal data was erased; missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub erased_at: Option<OffsetDateTime>,
    /// When the record was created; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// When the record was last changed; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// The actor responsible for an event, separate from acquisition [`Source`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    /// An automatic system action.
    System,
    /// An agent action.
    Agent,
    /// An action by the given user.
    Human(UserId),
}
