//! The knowledge base (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4): what the owner
//! tells the agents in their own words, and the rules no agent crosses. Pure, no I/O.
//!
//! - [`Card`]: a free card the agents read (a title, a body, attachments); the seed cards carry a
//!   fixed [`Card::key`]. Which cards the internal frame is derived from: [`feeds_posting`] and
//!   [`feeds_prospecting`]; whether the knowledge base says anything yet: [`is_empty`].
//! - [`KnowledgeSettings`]: one per workspace: the knowledge base's revisions, its rules (the
//!   prohibitions, the ad cap, the paid-message limit, post approval), its goals, and what the
//!   frame was last derived from.
//! - [`Revision`]: every change of a card, of the rules and of the goals, as it was. Append-only.
//! - [`Note`]: what a person told the agents ("Ajanlara bir şey anlat"), until an agent files it.
//! - [`Proposal`]: what an agent (or the seeding) proposes and the owner adds or skips ("Ajanın
//!   önerileri").
//! - [`seed`]: the cards, rules, goals and proposals a workspace's strategy versions give it once.
//! - [`frame`]: the internal frame the system applies from the knowledge base (the merge, the
//!   system fields, the structural diff).
//!
//! The stored types read tolerantly (a missing field reads as its default, an unknown one is
//! ignored), so a row a newer or an older binary wrote still reads. What a person or an agent
//! writes is checked at the write boundary: the inputs refuse unknown fields, and the `validate_*`
//! functions refuse every value over its limit, naming the field and a stable reason
//! ([`Invalid`]). The limits are the database's own (`0046_knowledge_base`).

mod card;
pub mod frame;
mod limits;
mod note;
mod proposal;
mod revision;
pub mod seed;
mod settings;
mod text;

pub use card::{
    Attachment, AttachmentInput, Card, KnowledgeCardId, PAST_CONVERSATIONS, SEED_CARDS,
    feeds_posting, feeds_prospecting, is_empty, is_knowledge_mime, valid_key, validate_body,
    validate_link, validate_position, validate_title,
};
pub use limits::*;
pub use note::{
    FiledCard, FiledPost, KnowledgeNoteId, Note, NoteClaim, NoteOutcome, NoteStatus,
    validate_links, validate_note_text,
};
pub use proposal::{
    BACKFILL_COMPONENT, KnowledgeProposalId, Proposal, ProposalDraft, ProposalKind, ProposalStatus,
    Proposer, RESYNC_COMPONENT, validate_proposal,
};
pub use revision::{Cause, KnowledgeRevisionId, Revision, Subject};
pub use settings::{
    Cap, CapInput, KnowledgeSettings, SeedSource, append_lines, validate_cap, validate_goals,
    validate_prohibitions,
};
pub use text::{cut, validate_lines, validate_text};

/// A value a person or an agent wrote that the knowledge base does not take.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{field}: {message}")]
pub struct Invalid {
    /// The input's path, e.g. `title`, `prohibitions[3]`, `attachments[0].url`.
    pub field: String,
    /// A stable code: `empty`, `too_long`, `too_many`, `not_https`, `required`, `not_allowed`,
    /// `out_of_range`, `duplicate`.
    pub reason: &'static str,
    /// What is wrong, in English.
    pub message: String,
}

impl Invalid {
    pub(crate) fn new(
        field: impl Into<String>,
        reason: &'static str,
        message: impl Into<String>,
    ) -> Invalid {
        Invalid {
            field: field.into(),
            reason,
            message: message.into(),
        }
    }
}
