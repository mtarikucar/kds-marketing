//! Pure inbox domain: identities, acquisition, conversations and messages. No I/O.
//!
//! Stored records ignore unknown fields and default missing non-identity fields. Required
//! identity and relationship fields are never invented on read. Deserialisation is for storage,
//! not input validation: application code normalises identities before writing or matching.

mod conversation;
mod identity;
mod ids;
mod message;
mod person;

pub use conversation::{ConvState, Conversation, Executor};
pub use identity::{
    Channel, Identity, IdentityChannel, IdentityError, channel_for_kind, normalise, scope_opaque,
};
pub use ids::{
    ConversationId, IdentityId, JourneyEventId, JourneyId, MergeId, MessageId, NoteId, PersonId,
    TaskId,
};
pub use message::{Author, Direction, Message, MsgStatus};
pub use person::{EventSource, FirstTouch, Person, Source};

fn epoch() -> time::OffsetDateTime {
    time::OffsetDateTime::UNIX_EPOCH
}

#[cfg(test)]
mod tests;
