//! Notes: what a person told the agents ("Ajanlara bir şey anlat"), until an agent files it
//! into the knowledge base or dismisses it. An open note binds at once: the agents read it before
//! it is filed.

use jt_studio::FileId;
use jt_tenancy::{AgentConnectionId, UserId, define_id};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Invalid;
use crate::card::{KnowledgeCardId, validate_link};
use crate::limits::{MAX_NOTE_LINKS, MAX_NOTE_TEXT_CHARS};
use crate::proposal::KnowledgeProposalId;
use crate::text::validate_text;

define_id!(
    /// A note a person wrote to the agents.
    KnowledgeNoteId
);

/// Where a note stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteStatus {
    /// Waiting for an agent ("Bekliyor").
    Open,
    /// An agent filed it with what it asked.
    Filed,
    /// An agent found nothing to act on, and said why.
    Dismissed,
    /// The person took it back ("Geri al").
    Withdrawn,
}

impl NoteStatus {
    /// The stable key, e.g. `"open"`.
    pub fn key(&self) -> &'static str {
        match self {
            NoteStatus::Open => "open",
            NoteStatus::Filed => "filed",
            NoteStatus::Dismissed => "dismissed",
            NoteStatus::Withdrawn => "withdrawn",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<NoteStatus> {
        match key {
            "open" => Some(NoteStatus::Open),
            "filed" => Some(NoteStatus::Filed),
            "dismissed" => Some(NoteStatus::Dismissed),
            "withdrawn" => Some(NoteStatus::Withdrawn),
            _ => None,
        }
    }
}

/// An agent's claim of an open note: the connection holding it, the hash of the token it was
/// given (never the token), and until when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteClaim {
    pub connection_id: AgentConnectionId,
    pub token_hash: String,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
}

/// A card a filing wrote, at the revision it left it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiledCard {
    pub card_id: KnowledgeCardId,
    pub revision: u64,
}

/// The content a filing opened for a post the note asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiledPost {
    pub area_id: Uuid,
}

/// What became of a closed note: for a filed one, every outcome and the agent's one-line
/// summary; for a dismissed one, why. Stored, so every field reads as empty when missing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteOutcome {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<FiledCard>,
    /// Prohibitions the filing appended.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
    /// Goals the filing appended.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goals: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_request: Option<FiledPost>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposals: Vec<KnowledgeProposalId>,
    /// One line in Turkish the owner reads under the note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Why a dismissed note was not acted on, in Turkish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<String>,
}

/// One note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: KnowledgeNoteId,
    pub text: String,
    /// `https://` links, at most [`MAX_NOTE_LINKS`].
    #[serde(default)]
    pub links: Vec<String>,
    /// Studio files (images, MP4s, PDFs): knowledge, never library materials.
    #[serde(default)]
    pub file_ids: Vec<FileId>,
    pub status: NoteStatus,
    #[serde(default)]
    pub claim: Option<NoteClaim>,
    /// 1 when added, +1 at every change.
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// The person who wrote it: its outcomes are recorded as theirs.
    pub created_by: UserId,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    /// The person who withdrew it.
    #[serde(default)]
    pub closed_by_user: Option<UserId>,
    /// The agent that filed or dismissed it.
    #[serde(default)]
    pub closed_by_connection: Option<AgentConnectionId>,
    #[serde(default)]
    pub outcome: Option<NoteOutcome>,
}

impl Note {
    /// The claim still holding at `now`, if any (a lapsed claim needs no write: it is read as
    /// none).
    pub fn live_claim(&self, now: OffsetDateTime) -> Option<&NoteClaim> {
        self.claim.as_ref().filter(|c| c.until > now)
    }

    /// Still waiting for an agent.
    pub fn is_open(&self) -> bool {
        self.status == NoteStatus::Open
    }
}

/// A note's text as written: trimmed, 1 to [`MAX_NOTE_TEXT_CHARS`] characters, naming `text`.
pub fn validate_note_text(raw: &str) -> Result<String, Invalid> {
    validate_text("text", raw, 1, MAX_NOTE_TEXT_CHARS)
}

/// A note's links as written: at most [`MAX_NOTE_LINKS`], each [`validate_link`] (naming
/// `{field}[i]`), duplicates once.
pub fn validate_links(field: &str, raw: &[String]) -> Result<Vec<String>, Invalid> {
    if raw.len() > MAX_NOTE_LINKS {
        return Err(Invalid::new(
            field,
            "too_many",
            format!("at most {MAX_NOTE_LINKS} links"),
        ));
    }
    let mut links: Vec<String> = Vec::new();
    for (i, link) in raw.iter().enumerate() {
        let link = validate_link(&format!("{field}[{i}]"), link)?;
        if !links.contains(&link) {
            links.push(link);
        }
    }
    Ok(links)
}
