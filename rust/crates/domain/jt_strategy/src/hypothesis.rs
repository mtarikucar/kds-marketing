//! Hypotheses: "this segment responds to this angle on this channel", each tied to a metric.

use crate::LaneKind;
use jt_tenancy::define_id;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

define_id!(
    /// A hypothesis. Stable across strategy versions: a new version keeps, retires or adds
    /// hypotheses, never renumbers them.
    HypothesisId
);

/// What a version did with a hypothesis relative to the version it was drafted from. A missing
/// state reads as `Kept`, so reading never resets what was learnt.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum HypothesisState {
    /// Carried over; its arms and what was learnt continue.
    #[default]
    Kept,
    /// Dropped by this version; its planned slots are cancelled, published ones keep being
    /// measured.
    Retired,
    /// New in this version; starts with empty arms.
    Added,
}

impl HypothesisState {
    /// The stable key, e.g. `"kept"`.
    pub fn key(&self) -> &'static str {
        match self {
            HypothesisState::Kept => "kept",
            HypothesisState::Retired => "retired",
            HypothesisState::Added => "added",
        }
    }

    /// The state with this key, if any.
    pub fn parse(key: &str) -> Option<HypothesisState> {
        match key {
            "kept" => Some(HypothesisState::Kept),
            "retired" => Some(HypothesisState::Retired),
            "added" => Some(HypothesisState::Added),
            _ => None,
        }
    }

    /// Whether the hypothesis is in force in its version (not retired).
    pub fn is_live(&self) -> bool {
        !matches!(self, HypothesisState::Retired)
    }
}

/// One testable hypothesis of a strategy version.
///
/// Stored, so reading is tolerant: unknown fields are ignored and every missing field but `id`
/// reads as its default (a hypothesis without its identity cannot be read).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hypothesis {
    pub id: HypothesisId,
    #[serde(default)]
    pub title: String,
    /// The [`crate::Segment::key`] it is about.
    #[serde(default)]
    pub segment_key: String,
    /// The angle the segment is expected to respond to.
    #[serde(default)]
    pub angle: String,
    /// A capability kind key, or `any`.
    #[serde(default)]
    pub channel: String,
    /// The measure that decides it.
    #[serde(default)]
    pub metric: String,
    /// Prior confidence, `0.0..=1.0`.
    #[serde(default, alias = "confidence")]
    pub prior_confidence: f32,
    #[serde(default)]
    pub derived_confidence: Option<f32>,
    #[serde(default)]
    pub cadence: BTreeMap<LaneKind, HypothesisCadence>,
    #[serde(default)]
    pub state: HypothesisState,
}

/// A hypothesis as the owner or the agent writes it: no state (the use case derives it), and no
/// id when it is new. Parsed strictly by [`crate::parse_hypotheses_strict`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HypothesisInput {
    /// The id of a hypothesis being kept or edited; `None` adds a new one.
    pub id: Option<HypothesisId>,
    pub title: String,
    pub segment_key: String,
    pub angle: String,
    pub channel: String,
    pub metric: String,
    pub prior_confidence: f32,
    pub cadence: BTreeMap<LaneKind, HypothesisCadence>,
}

impl HypothesisInput {
    /// The serialised field names, for the strict write-time check.
    pub const KEYS: &'static [&'static str] = &[
        "id",
        "title",
        "segment_key",
        "angle",
        "channel",
        "metric",
        "prior_confidence",
        "cadence",
    ];
}

/// Per-hypothesis cadence; an absent lane produces no slots. Weeks use Europe/Istanbul.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HypothesisCadence {
    pub slots_per_week: u16,
    #[serde(default)]
    pub exploration_bps: u16,
    pub content_types: Vec<ContentTypeShare>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentTypeShare {
    pub key: String,
    pub min_bps: u16,
    pub max_bps: u16,
}

impl HypothesisCadence {
    /// Validate fractional shares; integer quota feasibility belongs to the planner.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.exploration_bps > 10_000 {
            return Err("exploration_bps must be at most 10000");
        }
        let mut keys = BTreeSet::new();
        let (mut min, mut max) = (0_u64, 0_u64);
        for share in &self.content_types {
            if share.key.trim().is_empty() || !keys.insert(&share.key) {
                return Err("content type keys must be nonempty and unique");
            }
            if share.min_bps > share.max_bps || share.max_bps > 10_000 {
                return Err("shares require 0 <= min_bps <= max_bps <= 10000");
            }
            min += u64::from(share.min_bps);
            max += u64::from(share.max_bps);
        }
        if self.slots_per_week > 0 && (min > 10_000 || max < 10_000) {
            return Err("enabled lane shares must cover 10000 basis points");
        }
        Ok(())
    }
}

impl Hypothesis {
    /// Learning is authoritative when present; the editable prior is only a fallback display.
    pub fn confidence(&self) -> f32 {
        self.derived_confidence.unwrap_or(self.prior_confidence)
    }
}
