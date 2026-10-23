//! Pure inbox domain: people, conversations, journey reduction, send fences and merges. No I/O.
//!
//! Stored records ignore unknown fields and default missing non-identity fields. Required
//! identity and relationship fields are never invented on read. Deserialisation is for storage,
//! not input validation: application code normalises identities before writing or matching.

mod conversation;
mod fence;
mod identity;
mod ids;
mod journey;
mod merge;
mod message;
mod note;
mod person;
mod task;

pub use conversation::{ConvState, Conversation, Executor};
pub use fence::{FenceCtx, FenceRefusal, may_send};
pub use identity::{
    Channel, Identity, IdentityChannel, IdentityError, channel_for_kind, normalise, scope_opaque,
};
pub use ids::{
    ConversationId, IdentityId, JourneyEventId, JourneyId, MergeId, MessageId, NoteId, PersonId,
    TaskId,
};
pub use journey::{
    InitialJourney, Journey, JourneyEffect, JourneyEvent, JourneyEventKind, JourneyPatch,
    JourneyStatus, LostReason, ReduceError, ReduceInput, ReducePolicy, Transition, begin_journey,
    reduce,
};
pub use merge::{MergeConflict, MergeDecision, PersonView, decide_merge};
pub use message::{Author, Direction, Message, MsgStatus};
pub use note::Note;
pub use person::{EventSource, FirstTouch, Person, Source};
pub use task::{Task, TaskStatus};

fn epoch() -> time::OffsetDateTime {
    time::OffsetDateTime::UNIX_EPOCH
}

#[cfg(test)]
mod tests;
