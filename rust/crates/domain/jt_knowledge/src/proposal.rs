//! Proposals ("Ajanın önerileri"): a change an agent learned while working, or a text the seeding
//! found never applied, waiting for the owner to add it or skip it. Nothing changes until the
//! owner adds it.

use jt_tenancy::{AgentConnectionId, UserId, define_id};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::Invalid;
use crate::card::{KnowledgeCardId, validate_title};
use crate::limits::{
    MAX_CARD_BODY_CHARS, MAX_GOAL_CHARS, MAX_PROHIBITION_CHARS, MAX_PROPOSAL_REASON_CHARS,
};
use crate::text::validate_text;

define_id!(
    /// A proposal to a workspace's knowledge base.
    KnowledgeProposalId
);

/// The component the seeding proposes as.
pub const BACKFILL_COMPONENT: &str = "knowledge_backfill";
/// The component a strategy version approved through the old tools proposes as.
pub const RESYNC_COMPONENT: &str = "strategy_resync";

/// What a proposal would do once added.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    /// A new card (`title` and `body`).
    CardNew,
    /// A card's whole new text (`body`, and optionally a new `title`).
    CardEdit,
    /// A prohibition appended to the rules.
    RuleAdd,
    /// A goal appended to the goals.
    GoalAdd,
}

impl ProposalKind {
    /// The stable key, e.g. `"card_edit"`.
    pub fn key(&self) -> &'static str {
        match self {
            ProposalKind::CardNew => "card_new",
            ProposalKind::CardEdit => "card_edit",
            ProposalKind::RuleAdd => "rule_add",
            ProposalKind::GoalAdd => "goal_add",
        }
    }

    /// The kind with this key, if any.
    pub fn parse(key: &str) -> Option<ProposalKind> {
        match key {
            "card_new" => Some(ProposalKind::CardNew),
            "card_edit" => Some(ProposalKind::CardEdit),
            "rule_add" => Some(ProposalKind::RuleAdd),
            "goal_add" => Some(ProposalKind::GoalAdd),
            _ => None,
        }
    }
}

/// Where a proposal stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Skipped,
    /// It waited past `expires_at`.
    Expired,
    /// The card it edits changed since it was written.
    Superseded,
}

impl ProposalStatus {
    /// The stable key, e.g. `"pending"`.
    pub fn key(&self) -> &'static str {
        match self {
            ProposalStatus::Pending => "pending",
            ProposalStatus::Accepted => "accepted",
            ProposalStatus::Skipped => "skipped",
            ProposalStatus::Expired => "expired",
            ProposalStatus::Superseded => "superseded",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<ProposalStatus> {
        match key {
            "pending" => Some(ProposalStatus::Pending),
            "accepted" => Some(ProposalStatus::Accepted),
            "skipped" => Some(ProposalStatus::Skipped),
            "expired" => Some(ProposalStatus::Expired),
            "superseded" => Some(ProposalStatus::Superseded),
            _ => None,
        }
    }
}

/// Who proposed: an agent through its connection, or the system ([`BACKFILL_COMPONENT`],
/// [`RESYNC_COMPONENT`]). The system's proposals count toward no limit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Proposer {
    Agent { connection_id: AgentConnectionId },
    System { component: String },
}

/// One proposal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: KnowledgeProposalId,
    pub kind: ProposalKind,
    /// The card a `card_edit` rewrites.
    #[serde(default)]
    pub card_id: Option<KnowledgeCardId>,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    /// One line in Turkish: why the owner might add it.
    pub reason: String,
    pub status: ProposalStatus,
    /// For a `card_edit`, the card's revision it was written against.
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(with = "time::serde::rfc3339")]
    pub proposed_at: OffsetDateTime,
    pub proposed_by: Proposer,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub decided_at: Option<OffsetDateTime>,
    /// The person who added or skipped it; none when it expired or was superseded.
    #[serde(default)]
    pub decided_by: Option<UserId>,
    /// The knowledge base's revision its acceptance wrote.
    #[serde(default)]
    pub applied_revision: Option<u64>,
}

impl Proposal {
    /// Whether the system made it (it counts toward no limit).
    pub fn is_system(&self) -> bool {
        matches!(self.proposed_by, Proposer::System { .. })
    }

    /// Still waiting for the owner.
    pub fn is_pending(&self) -> bool {
        self.status == ProposalStatus::Pending
    }
}

/// A proposal's text, checked for its kind ([`validate_proposal`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalDraft {
    pub kind: ProposalKind,
    pub card_id: Option<KnowledgeCardId>,
    pub title: Option<String>,
    pub body: String,
    pub reason: String,
}

/// A proposal as written, checked for its kind: `card_new` needs a `title` and a `body` and names
/// no card; `card_edit` names its card (`card_id`) and the card's whole new `body`, with an
/// optional `title`; `rule_add` (a prohibition, at most [`MAX_PROHIBITION_CHARS`]) and `goal_add`
/// (at most [`MAX_GOAL_CHARS`]) have a `body` only. A card's body is at most
/// [`MAX_CARD_BODY_CHARS`]; a `reason` 1 to [`MAX_PROPOSAL_REASON_CHARS`] characters, always.
/// Texts are trimmed.
pub fn validate_proposal(
    kind: ProposalKind,
    card_id: Option<KnowledgeCardId>,
    title: Option<&str>,
    body: &str,
    reason: &str,
) -> Result<ProposalDraft, Invalid> {
    let not_allowed = |field: &str| {
        Invalid::new(
            field,
            "not_allowed",
            format!("a {} proposal has no {field}", kind.key()),
        )
    };
    let (card_id, title) = match kind {
        ProposalKind::CardNew => {
            if card_id.is_some() {
                return Err(not_allowed("card_id"));
            }
            let title = title
                .ok_or_else(|| Invalid::new("title", "required", "a new card needs its title"))?;
            (None, Some(validate_title(title)?))
        }
        ProposalKind::CardEdit => {
            let card_id = card_id
                .ok_or_else(|| Invalid::new("card_id", "required", "a card edit names its card"))?;
            let title = title.map(validate_title).transpose()?;
            (Some(card_id), title)
        }
        ProposalKind::RuleAdd | ProposalKind::GoalAdd => {
            if card_id.is_some() {
                return Err(not_allowed("card_id"));
            }
            if title.is_some() {
                return Err(not_allowed("title"));
            }
            (None, None)
        }
    };
    let max = match kind {
        ProposalKind::CardNew | ProposalKind::CardEdit => MAX_CARD_BODY_CHARS,
        ProposalKind::RuleAdd => MAX_PROHIBITION_CHARS,
        ProposalKind::GoalAdd => MAX_GOAL_CHARS,
    };
    Ok(ProposalDraft {
        kind,
        card_id,
        title,
        body: validate_text("body", body, 1, max)?,
        reason: validate_text("reason", reason, 1, MAX_PROPOSAL_REASON_CHARS)?,
    })
}
