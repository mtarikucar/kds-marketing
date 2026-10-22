//! Hypotheses: "this segment responds to this angle on this channel", each tied to a metric.

use jt_tenancy::define_id;
use serde::{Deserialize, Serialize};

define_id!(
    /// A hypothesis. Stable across strategy versions: a new version keeps, retires or adds
    /// hypotheses, never renumbers them.
    HypothesisId
);

/// What a version did with a hypothesis relative to the version it was drafted from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HypothesisState {
    /// Carried over; its arms and what was learnt continue.
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hypothesis {
    pub id: HypothesisId,
    pub title: String,
    /// The [`crate::Segment::key`] it is about.
    pub segment_key: String,
    /// The angle the segment is expected to respond to.
    pub angle: String,
    /// A capability kind key, or `any`.
    pub channel: String,
    /// The measure that decides it.
    pub metric: String,
    /// Prior confidence, `0.0..=1.0`.
    pub confidence: f32,
    pub state: HypothesisState,
}
