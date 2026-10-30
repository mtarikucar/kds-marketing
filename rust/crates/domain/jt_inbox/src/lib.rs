//! Pure inbox domain: people, conversations, journeys, compliance and commercial records. No I/O.
//!
//! Stored records ignore unknown fields and default missing non-identity fields. Required
//! identity and relationship fields are never invented on read. Deserialisation is for storage,
//! not input validation: application code normalises identities before writing or matching.
//!
//! Consent/suppression govern commercial fences; quotes validate assigned ISO 4217 codes,
//! appointments export escaped/folded UTC ICS, commissions use integer half-even rounding,
//! and scoped identity hashes prevent erased identities from reappearing. `sms_segments`
//! counts GSM-7 septets or UTF-16 units; send boundaries must validate body size first.
//!
//! Public surfaces ([`public`]): comments and marketplace questions are items of a public
//! conversation, each with its own reply rules, fence and lifecycle; [`relay`] recognises
//! marketplace buyer messages relayed through the seller's mailbox.

mod appointment;
mod commission;
mod consent;
mod conversation;
mod erasure;
mod fence;
mod identity;
mod ids;
mod journey;
mod merge;
mod message;
mod note;
mod person;
pub mod public;
mod quote;
pub mod relay;
mod sms;
mod suppression;
mod task;

pub use appointment::{Appointment, AppointmentError, AppointmentState, ics};
pub use commission::{Commission, CommissionState, commission_for};
pub use consent::{
    Consent, ConsentKind, ConsentSource, IzinYok, SyncState, commercial_allowed, effective_consent,
};
pub use conversation::{ConvState, Conversation, Executor};
pub use erasure::identity_hash;
pub use fence::{FenceCtx, FenceRefusal, SendIntent, may_send};
pub use identity::{
    Channel, Identity, IdentityChannel, IdentityError, channel_for_kind, conversation_channel,
    normalise, public_channel_for_kind, scope_opaque,
};
pub use ids::{
    ConsentId, ConversationId, IdentityId, JourneyEventId, JourneyId, MergeId, MessageId, NoteId,
    PersonId, PublicItemId, PublicSubjectId, TaskId,
};
pub use journey::{
    ImportedJourney, InitialJourney, Journey, JourneyEffect, JourneyEvent, JourneyEventKind,
    JourneyPatch, JourneyStatus, LostReason, ReduceError, ReduceInput, ReducePolicy, Transition,
    begin_journey, import_journey, reduce, v1_journey_status,
};
pub use merge::{MergeConflict, MergeDecision, PersonView, decide_merge};
pub use message::{Author, Direction, Message, MsgStatus};
pub use note::Note;
pub use person::{EventSource, FirstTouch, Person, Source};
pub use public::{
    AnswerState, AnsweredBy, HandledReason, ItemEvent, ItemTransitionError, Moderation,
    PrivateRule, PublicItem, PublicKind, PublicRefusal, PublicRules, PublicSubject, SubjectKind,
    TextBounds, Visibility,
};
pub use quote::{Quote, QuoteError, QuoteState};
pub use relay::{Relay, RelayRefusal};
pub use sms::sms_segments;
pub use suppression::{Suppression, SuppressionReason};
pub use task::{Task, TaskStatus};

fn epoch() -> time::OffsetDateTime {
    time::OffsetDateTime::UNIX_EPOCH
}

#[cfg(test)]
mod tests;
