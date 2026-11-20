//! The knowledge base's one row per workspace: its revisions, its rules and goals, the caps and
//! the post approval the system enforces, and what the frame was last derived from.

use jt_strategy::{HypothesisId, Period};
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Invalid;
use crate::limits::{
    MAX_CAP_MINOR, MAX_GOAL_CHARS, MAX_GOALS, MAX_PROHIBITION_CHARS, MAX_PROHIBITIONS,
};
use crate::text::validate_lines;

/// Where a workspace's knowledge base came from when it was seeded (design §4.3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedSource {
    /// The strategy version in force: the cards carry its texts, the rules its caps.
    Approved,
    /// A draft that was never approved: blank cards, and its texts wait as proposals.
    Draft,
    /// Nothing (or only an archived version, whose texts wait as proposals): blank cards.
    Empty,
}

impl SeedSource {
    /// The stable key, e.g. `"approved"`.
    pub fn key(&self) -> &'static str {
        match self {
            SeedSource::Approved => "approved",
            SeedSource::Draft => "draft",
            SeedSource::Empty => "empty",
        }
    }

    /// The source with this key, if any.
    pub fn parse(key: &str) -> Option<SeedSource> {
        match key {
            "approved" => Some(SeedSource::Approved),
            "draft" => Some(SeedSource::Draft),
            "empty" => Some(SeedSource::Empty),
            _ => None,
        }
    }
}

/// A spending ceiling of the rules: at most `amount_minor` (in minor units of `currency`, kuruş
/// for `TRY`) per `period`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cap {
    pub amount_minor: i64,
    #[serde(default)]
    pub period: Period,
    #[serde(default = "default_currency")]
    pub currency: String,
}

/// The currency a cap without one reads as.
fn default_currency() -> String {
    "TRY".to_owned()
}

/// A ceiling as a person writes it: the amount, and the period (none: the one in force, else
/// monthly). The currency is not written: it is the budget's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapInput {
    pub amount_minor: i64,
    #[serde(default)]
    pub period: Option<Period>,
}

/// `Ok` when `input`'s amount is `0..=`[`MAX_CAP_MINOR`]; else `out_of_range` naming
/// `{field}.amount_minor`.
pub fn validate_cap(field: &str, input: &CapInput) -> Result<(), Invalid> {
    if !(0..=MAX_CAP_MINOR).contains(&input.amount_minor) {
        return Err(Invalid::new(
            format!("{field}.amount_minor"),
            "out_of_range",
            format!("an amount is 0 to {MAX_CAP_MINOR} minor units"),
        ));
    }
    Ok(())
}

/// The prohibitions as written ([`validate_lines`] over `prohibitions`): at most
/// [`MAX_PROHIBITIONS`] of at most [`MAX_PROHIBITION_CHARS`] characters.
pub fn validate_prohibitions(field: &str, raw: &[String]) -> Result<Vec<String>, Invalid> {
    validate_lines(field, raw, MAX_PROHIBITIONS, MAX_PROHIBITION_CHARS)
}

/// The goals as written ([`validate_lines`]): at most [`MAX_GOALS`] of at most
/// [`MAX_GOAL_CHARS`] characters.
pub fn validate_goals(field: &str, raw: &[String]) -> Result<Vec<String>, Invalid> {
    validate_lines(field, raw, MAX_GOALS, MAX_GOAL_CHARS)
}

/// Appends to `lines` each of `new` it does not hold yet (compared as written, trimmed), in
/// order, and answers those appended; `too_many` naming `field` when the result would hold more
/// than `max`, and then `lines` is left as it was.
pub fn append_lines(
    field: &str,
    lines: &mut Vec<String>,
    new: &[String],
    max: usize,
) -> Result<Vec<String>, Invalid> {
    let mut added: Vec<String> = Vec::new();
    for line in new {
        let line = line.trim();
        if line.is_empty() || lines.iter().any(|l| l == line) || added.iter().any(|l| l == line) {
            continue;
        }
        added.push(line.to_owned());
    }
    if lines.len() + added.len() > max {
        return Err(Invalid::new(
            field,
            "too_many",
            format!("at most {max} lines, got {}", lines.len() + added.len()),
        ));
    }
    lines.extend(added.iter().cloned());
    Ok(added)
}

/// One workspace's knowledge base settings (`knowledge_settings`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeSettings {
    pub workspace_id: WorkspaceId,
    /// +1 on every knowledge change (one per transaction).
    pub revision: u64,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub changed_at: Option<OffsetDateTime>,
    /// The person whose change it was (for an agent's filing, the note's person).
    #[serde(default)]
    pub changed_by: Option<UserId>,
    /// The revision of the last change of a card the posting part is derived from.
    #[serde(default)]
    pub posting_revision: u64,
    /// The revision of the last change of a card the prospecting part is derived from.
    #[serde(default)]
    pub prospecting_revision: u64,
    /// The revision the posting part of the frame was last derived from.
    #[serde(default)]
    pub posting_derived: u64,
    /// The revision the prospecting part of the frame was last derived from.
    #[serde(default)]
    pub prospecting_derived: u64,
    /// "Yasaklar": instructions every agent reads, never checked by the server.
    #[serde(default)]
    pub prohibitions: Vec<String>,
    /// "Hedefler", one line each.
    #[serde(default)]
    pub goals: Vec<String>,
    /// The ad budget's ceiling; none: no ads.
    #[serde(default)]
    pub ad_cap: Option<Cap>,
    /// The paid messages' limit (SMS, metered sends); none: no limit of its own.
    #[serde(default)]
    pub message_cap: Option<Cap>,
    /// "Her paylaşım onayıma gelsin": every post waits for the owner.
    #[serde(default)]
    pub post_approval: bool,
    /// The social accounts (capability ids) whose posts wait for the owner while the switch is
    /// off.
    #[serde(default)]
    pub post_approval_accounts: Vec<Uuid>,
    /// When the accounts' stored approval flags were copied into the list.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub post_gate_seeded_at: Option<OffsetDateTime>,
    /// Topics a derivation left out, kept for the posts that still name them.
    #[serde(default)]
    pub closing_topic_ids: Vec<HypothesisId>,
    /// 1 when seeded, +1 at every change of the rules.
    pub rules_revision: u64,
    /// 1 when seeded, +1 at every change of the goals.
    pub goals_revision: u64,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub frame_applied_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub seeded_at: OffsetDateTime,
    pub seed_source: SeedSource,
}

impl KnowledgeSettings {
    /// The settings a workspace is seeded with from `source` at `now`: nothing changed yet,
    /// nothing derived, no rules, no goals, no caps, no approval.
    pub fn new(ws: WorkspaceId, source: SeedSource, now: OffsetDateTime) -> KnowledgeSettings {
        KnowledgeSettings {
            workspace_id: ws,
            revision: 0,
            changed_at: None,
            changed_by: None,
            posting_revision: 0,
            prospecting_revision: 0,
            posting_derived: 0,
            prospecting_derived: 0,
            prohibitions: Vec::new(),
            goals: Vec::new(),
            ad_cap: None,
            message_cap: None,
            post_approval: false,
            post_approval_accounts: Vec::new(),
            post_gate_seeded_at: None,
            closing_topic_ids: Vec::new(),
            rules_revision: 1,
            goals_revision: 1,
            frame_applied_at: None,
            seeded_at: now,
            seed_source: source,
        }
    }

    /// What a `rules` revision row keeps: the whole rules box.
    pub fn rules_content(&self) -> Value {
        json!({
            "prohibitions": self.prohibitions,
            "ad_cap": self.ad_cap,
            "message_cap": self.message_cap,
            "post_approval": self.post_approval,
            "post_approval_accounts": self.post_approval_accounts,
        })
    }

    /// What a `goals` revision row keeps: the goals.
    pub fn goals_content(&self) -> Value {
        json!({ "items": self.goals })
    }

    /// Whether a card change made after the posting part was last derived waits for a
    /// derivation.
    pub fn posting_due(&self) -> bool {
        self.posting_revision > self.posting_derived
    }

    /// Whether a card change made after the prospecting part was last derived waits for one.
    pub fn prospecting_due(&self) -> bool {
        self.prospecting_revision > self.prospecting_derived
    }
}
