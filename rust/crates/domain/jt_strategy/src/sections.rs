//! The content of a strategy: identity, audience, channels, goals, budget frame, prohibitions,
//! cadence and whether paid channels are used (spec §5 "İçerik").
//!
//! These types are stored (an approved version's sections are kept as they were approved), so
//! reading them is tolerant: a missing field reads as its default and an unknown field is
//! ignored, and a row written by a newer or an older binary still reads. Strictness belongs to the
//! write boundary: [`crate::parse_section_strict`] refuses unknown keys at any depth, using each
//! struct's `KEYS`. Whether the content is complete is a rule ([`crate::validate_sections`]), not
//! a parse error.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The whole content of one strategy version.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
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
    /// Whom agents research for the prospect pool, and how prospects are scored. Empty `icp`
    /// means prospecting is off.
    pub prospecting: Prospecting,
}

impl Sections {
    /// The key of each section, as serialised; one section is written at a time under its key.
    pub const KEYS: &'static [&'static str] = &[
        "identity",
        "audience",
        "channels",
        "goals",
        "budget_frame",
        "prohibitions",
        "cadence",
        "paid_enabled",
        "prospecting",
    ];
}

/// What is sold, and how the brand speaks and stands apart.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Identity {
    pub product: String,
    pub voice: String,
    pub positioning: String,
    /// What sets it apart.
    pub usp: String,
}

impl Identity {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["product", "voice", "positioning", "usp"];
}

/// One audience segment. Hypotheses name it by `key`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Segment {
    /// `[a-z0-9_]{2,32}`, unique within the strategy.
    pub key: String,
    pub name: String,
    pub description: String,
}

impl Segment {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["key", "name", "description"];
}

/// A channel the strategy uses and why.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelChoice {
    /// A capability kind key (e.g. `instagram`, `mailbox`), or `any`.
    pub channel: String,
    pub rationale: String,
    /// A capability group the channel is drawn from ("Brand A accounts"), if narrowed to one.
    pub group_id: Option<Uuid>,
}

impl ChannelChoice {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["channel", "rationale", "group_id"];
}

/// The objective and how progress towards it is measured.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Goals {
    pub objective: String,
    pub kpis: Vec<Kpi>,
}

impl Goals {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["objective", "kpis"];
}

/// One measure of progress and its target, both in the owner's words.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Kpi {
    pub name: String,
    pub target: String,
}

impl Kpi {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["name", "target"];
}

/// The spending caps, one lane per [`LaneKind`] (spec §9).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BudgetFrame {
    pub lanes: Vec<Lane>,
}

impl BudgetFrame {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["lanes"];
}

/// The cap on one lane's spending per period.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Lane {
    pub lane: LaneKind,
    pub period: Period,
    /// The cap in minor units of `currency` (kuruş for `TRY`); not negative.
    pub cap_minor: i64,
    /// ISO 4217 code: three uppercase ASCII letters.
    pub currency: String,
}

impl Lane {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["lane", "period", "cap_minor", "currency"];
}

/// A spending lane. A missing lane reads as `Organic`, the one that opens no paid spend.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum LaneKind {
    /// Work that costs no media spend.
    #[default]
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

/// The period a cap applies to. A missing period reads as `Monthly`: the same cap spread over
/// the longer period allows less spending.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Weekly,
    #[default]
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
#[serde(default)]
pub struct Cadence {
    /// Posts per week, `0..=70`.
    pub per_week: u16,
    /// Share of `per_week` per channel; when not empty, the shares sum to 100.
    pub channel_mix: Vec<Mix>,
}

impl Cadence {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["per_week", "channel_mix"];
}

/// One channel's share of the cadence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Mix {
    /// One of the strategy's [`ChannelChoice::channel`]s.
    pub channel: String,
    pub share_pct: u8,
}

impl Mix {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["channel", "share_pct"];
}

/// The prospect pool's part of the strategy (spec 2026-10-30-leads-pool-outreach-design.md §3.7):
/// the ideal customer profile's entries agents research, and the rubric scores follow.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prospecting {
    /// `0..=10`; none means prospecting is off.
    pub icp: Vec<IcpEntry>,
    pub rubric: Rubric,
}

impl Prospecting {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["icp", "rubric"];
}

/// One entry of the ideal customer profile: whom to look for, where, and how many a day. The
/// research planning keeps one standing task open per entry of the approved version.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IcpEntry {
    /// `[a-z0-9_]{2,32}`, unique within the profile.
    pub key: String,
    /// An audience segment key of the same version.
    pub segment_key: String,
    /// `1..=10`.
    pub sectors: Vec<String>,
    /// `1..=20`.
    pub areas: Vec<Area>,
    /// `0..=10`: what to look for.
    pub signals: Vec<String>,
    /// `0..=10`: what disqualifies.
    pub exclusions: Vec<String>,
    /// At most 200 characters.
    pub size_hint: String,
    pub language: Option<String>,
    /// Prospects created per local day for this entry, `1..=200`.
    pub daily_cap: u16,
    /// `0..=2000`: no research is asked for while this many of the segment are unpromoted.
    pub backlog_target: u16,
}

impl IcpEntry {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &[
        "key",
        "segment_key",
        "sectors",
        "areas",
        "signals",
        "exclusions",
        "size_hint",
        "language",
        "daily_cap",
        "backlog_target",
    ];
}

/// A place prospects are researched in: a city, optionally narrowed to one district. Named by a
/// research brief (`jt_prospects::Brief`) and by an ICP entry of the `prospecting` section.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Area {
    pub city: String,
    pub district: Option<String>,
}

impl Area {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["city", "district"];
}

/// How a prospect is scored: criteria whose weights sum to 100, and the score at which a
/// prospect qualifies by itself (spec 2026-10-30-leads-pool-outreach-design.md §3.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rubric {
    /// `1..=12` criteria, keys unique.
    pub criteria: Vec<Criterion>,
    /// `1..=100`.
    pub qualify_at: u8,
}

impl Rubric {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["criteria", "qualify_at"];
}

/// One criterion of a [`Rubric`]: a score gives it at most `weight` points.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Criterion {
    /// `[a-z0-9_]{2,32}`, unique within the rubric.
    pub key: String,
    /// `1..=300` characters.
    pub description: String,
    pub weight: u8,
}

impl Criterion {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &["key", "description", "weight"];
}
