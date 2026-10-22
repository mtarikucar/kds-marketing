//! The consultation log: the append-only record of how a version was worked out.

use jt_ledger::Actor;
use jt_tenancy::define_id;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::StrategyError;
use crate::version::StrategyVersionId;

define_id!(
    /// An entry in a strategy version's consultation log.
    ConsultationEntryId
);

/// The longest consultation text, in characters.
pub const MAX_CONSULTATION_TEXT_CHARS: usize = 20_000;

/// What a consultation entry records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsultationKind {
    /// A question put to the owner.
    Question,
    /// The owner's answer.
    Answer,
    /// Something the agent assumed without an answer; listed explicitly at approval.
    Assumption,
    /// A section was drafted.
    SectionDraft,
    /// A note, including a small correction kept within the same version.
    Note,
    /// The draft was submitted for approval.
    Submitted,
    /// The version was approved.
    Approved,
    /// The version was archived.
    Archived,
}

const ALL_KINDS: &[ConsultationKind] = &[
    ConsultationKind::Question,
    ConsultationKind::Answer,
    ConsultationKind::Assumption,
    ConsultationKind::SectionDraft,
    ConsultationKind::Note,
    ConsultationKind::Submitted,
    ConsultationKind::Approved,
    ConsultationKind::Archived,
];

impl ConsultationKind {
    /// The stable key, e.g. `"section_draft"`.
    pub fn key(&self) -> &'static str {
        match self {
            ConsultationKind::Question => "question",
            ConsultationKind::Answer => "answer",
            ConsultationKind::Assumption => "assumption",
            ConsultationKind::SectionDraft => "section_draft",
            ConsultationKind::Note => "note",
            ConsultationKind::Submitted => "submitted",
            ConsultationKind::Approved => "approved",
            ConsultationKind::Archived => "archived",
        }
    }

    /// The kind with this key, if any.
    pub fn parse(key: &str) -> Option<ConsultationKind> {
        ALL_KINDS.iter().copied().find(|k| k.key() == key)
    }

    /// Every kind.
    pub fn all() -> &'static [ConsultationKind] {
        ALL_KINDS
    }
}

/// One entry of a version's consultation log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsultationEntry {
    pub id: ConsultationEntryId,
    pub version_id: StrategyVersionId,
    pub kind: ConsultationKind,
    /// The section the entry is about (one of [`crate::Sections::KEYS`]), if any.
    pub section_key: Option<String>,
    /// At most [`MAX_CONSULTATION_TEXT_CHARS`] characters.
    pub text: String,
    pub actor: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

impl ConsultationEntry {
    /// A new entry with a fresh id; `TextTooLong` when `text` has more than
    /// [`MAX_CONSULTATION_TEXT_CHARS`] characters (characters, not bytes).
    pub fn new(
        version_id: StrategyVersionId,
        kind: ConsultationKind,
        section_key: Option<String>,
        text: String,
        actor: Actor,
        at: OffsetDateTime,
    ) -> Result<ConsultationEntry, StrategyError> {
        let len = text.chars().count();
        if len > MAX_CONSULTATION_TEXT_CHARS {
            return Err(StrategyError::TextTooLong { len });
        }
        Ok(ConsultationEntry {
            id: ConsultationEntryId::new_v7(),
            version_id,
            kind,
            section_key,
            text,
            actor,
            at,
        })
    }
}
