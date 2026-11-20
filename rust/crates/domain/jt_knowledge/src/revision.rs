//! The knowledge base's history: every change of a card, of the rules and of the goals, as it
//! was. Append-only (`knowledge_revisions_append_only`).

use jt_ledger::Actor;
use jt_tenancy::define_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::card::KnowledgeCardId;

define_id!(
    /// One revision row of a workspace's knowledge base.
    KnowledgeRevisionId
);

/// What a revision is of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Subject {
    Card,
    Rules,
    Goals,
}

impl Subject {
    /// The stable key, e.g. `"rules"`.
    pub fn key(&self) -> &'static str {
        match self {
            Subject::Card => "card",
            Subject::Rules => "rules",
            Subject::Goals => "goals",
        }
    }

    /// The subject with this key, if any.
    pub fn parse(key: &str) -> Option<Subject> {
        match key {
            "card" => Some(Subject::Card),
            "rules" => Some(Subject::Rules),
            "goals" => Some(Subject::Goals),
            _ => None,
        }
    }
}

/// Why a revision was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// A blank seed card, or the rules and goals of a workspace seeded without a strategy.
    Seed,
    /// Seeded from the strategy version in force.
    Backfill,
    /// Rewritten from a strategy version approved through the old tools.
    Resync,
    /// The owner's own edit.
    Owner,
    /// An accepted proposal.
    Proposal,
    /// An agent filed a person's note.
    Note,
    /// The system.
    System,
}

impl Cause {
    /// The stable key, e.g. `"backfill"`.
    pub fn key(&self) -> &'static str {
        match self {
            Cause::Seed => "seed",
            Cause::Backfill => "backfill",
            Cause::Resync => "resync",
            Cause::Owner => "owner",
            Cause::Proposal => "proposal",
            Cause::Note => "note",
            Cause::System => "system",
        }
    }

    /// The cause with this key, if any.
    pub fn parse(key: &str) -> Option<Cause> {
        match key {
            "seed" => Some(Cause::Seed),
            "backfill" => Some(Cause::Backfill),
            "resync" => Some(Cause::Resync),
            "owner" => Some(Cause::Owner),
            "proposal" => Some(Cause::Proposal),
            "note" => Some(Cause::Note),
            "system" => Some(Cause::System),
            _ => None,
        }
    }
}

/// One change, as it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    pub id: KnowledgeRevisionId,
    pub subject: Subject,
    /// The card, for a card's revision only.
    #[serde(default)]
    pub card_id: Option<KnowledgeCardId>,
    /// The subject's revision after the change (a card's, `rules_revision`, `goals_revision`).
    pub revision: u64,
    /// The knowledge base's revision after the change.
    pub kb_revision: u64,
    /// The subject as it was after the change ([`crate::Card::content`],
    /// [`crate::KnowledgeSettings::rules_content`], [`crate::KnowledgeSettings::goals_content`]).
    pub content: Value,
    pub cause: Cause,
    /// The proposal or the note it came from.
    #[serde(default)]
    pub source_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub by: Actor,
}
