//! The content of a strategy: identity, audience, channels, goals, budget frame, prohibitions,
//! cadence and whether paid channels are used (spec §5 "İçerik").
//!
//! Every struct refuses unknown fields, so a misspelt field is an error rather than silently
//! dropped; the sections themselves, and every part that has an empty form, read missing fields
//! as empty (a fresh draft is stored as `{}`). Whether the content is complete is a rule
//! ([`crate::validate_sections`]), not a parse error.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The whole content of one strategy version.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sections {
    pub identity: Identity,
    /// The segments of the audience.
    pub audience: Vec<Segment>,
    /// The channels the strategy uses, each with its rationale.
    pub channels: Vec<ChannelChoice>,
    pub goals: Goals,
    pub budget_frame: BudgetFrame,
    /// Things never to say and subjects never to enter.
    pub prohibitions: Vec<String>,
    pub cadence: Cadence,
    /// Whether the strategy uses paid channels at all.
    pub paid_enabled: bool,
}

impl Sections {
    /// The key of each section, as serialised; one section is written at a time under its key.
    pub const KEYS: [&'static str; 8] = [
        "identity",
        "audience",
        "channels",
        "goals",
        "budget_frame",
        "prohibitions",
        "cadence",
        "paid_enabled",
    ];
}

/// What is sold, and how the brand speaks and stands apart.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Identity {
    pub product: String,
    pub voice: String,
    pub positioning: String,
    /// What sets it apart.
    pub usp: String,
}

/// One audience segment. Hypotheses name it by `key`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    /// `[a-z0-9_]{2,32}`, unique within the strategy.
    pub key: String,
    pub name: String,
    pub description: String,
}

/// A channel the strategy uses and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelChoice {
    /// A capability kind key (e.g. `instagram`, `mailbox`), or `any`.
    pub channel: String,
    pub rationale: String,
    /// A capability group the channel is drawn from ("Brand A accounts"), if narrowed to one.
    pub group_id: Option<Uuid>,
}

/// The objective and how progress towards it is measured.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Goals {
    pub objective: String,
    pub kpis: Vec<Kpi>,
}

/// One measure of progress and its target, both in the owner's words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kpi {
    pub name: String,
    pub target: String,
}

/// The spending caps, one lane per [`LaneKind`] (spec §9).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BudgetFrame {
    pub lanes: Vec<Lane>,
}

/// The cap on one lane's spending per period.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lane {
    pub lane: LaneKind,
    pub period: Period,
    /// The cap in minor units of `currency` (kuruş for `TRY`); not negative.
    pub cap_minor: i64,
    /// ISO 4217 code: three uppercase ASCII letters.
    pub currency: String,
}

/// A spending lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneKind {
    /// Work that costs no media spend.
    Organic,
    /// Paid media.
    Paid,
}

impl LaneKind {
    /// The stable key, e.g. `"paid"`.
    pub fn key(&self) -> &'static str {
        match self {
            LaneKind::Organic => "organic",
            LaneKind::Paid => "paid",
        }
    }

    /// The lane with this key, if any.
    pub fn parse(key: &str) -> Option<LaneKind> {
        match key {
            "organic" => Some(LaneKind::Organic),
            "paid" => Some(LaneKind::Paid),
            _ => None,
        }
    }
}

/// The period a cap applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Weekly,
    Monthly,
}

impl Period {
    /// The stable key, e.g. `"weekly"`.
    pub fn key(&self) -> &'static str {
        match self {
            Period::Weekly => "weekly",
            Period::Monthly => "monthly",
        }
    }

    /// The period with this key, if any.
    pub fn parse(key: &str) -> Option<Period> {
        match key {
            "weekly" => Some(Period::Weekly),
            "monthly" => Some(Period::Monthly),
            _ => None,
        }
    }
}

/// How often to publish, and how that is split across channels.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Cadence {
    /// Posts per week, `0..=70`.
    pub per_week: u16,
    /// Share of `per_week` per channel; when not empty, the shares sum to 100.
    pub channel_mix: Vec<Mix>,
}

/// One channel's share of the cadence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mix {
    /// One of the strategy's [`ChannelChoice::channel`]s.
    pub channel: String,
    pub share_pct: u8,
}
