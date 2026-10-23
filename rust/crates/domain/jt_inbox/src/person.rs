//! People, acquisition attribution and event actors.

use jt_capability::CapabilityId;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

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
