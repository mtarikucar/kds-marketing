//! Journey notes; note bodies must not be copied into mutation-ledger payloads.

use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{EventSource, JourneyId, NoteId};

/// A tenant-scoped note with its original author and timestamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    /// Note identity.
    pub id: NoteId,
    /// Owning tenant.
    pub workspace_id: WorkspaceId,
    /// Journey containing the note.
    pub journey_id: JourneyId,
    /// Actor derived from the principal adding the note.
    pub author: EventSource,
    /// Private note text.
    pub text: String,
    /// Supplied creation time; the domain never reads a clock.
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}
