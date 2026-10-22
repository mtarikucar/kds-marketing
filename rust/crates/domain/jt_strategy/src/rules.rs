//! The strategy's rules: completeness, approval, the next draft, differences and caps. Pure.
//!
//! Validation never stops at the first problem: it returns every [`Gap`] at once, in the order of
//! the fields, so the owner and the agent see the whole list in one pass.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::StrategyError;
use crate::hypothesis::{Hypothesis, HypothesisState};
use crate::sections::{BudgetFrame, Cadence, Goals, Identity, LaneKind, Period, Sections};
use crate::version::StrategyVersion;

/// The channel name that stands for any channel; accepted wherever a channel is named.
pub const ANY_CHANNEL: &str = "any";

/// The longest list of prohibitions.
pub const MAX_PROHIBITIONS: usize = 100;

/// The most posts per week a cadence may ask for.
pub const MAX_PER_WEEK: u16 = 70;

/// One thing missing or inconsistent in a strategy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gap {
    /// Dotted path of the field, e.g. `"cadence.channel_mix[1].channel"`.
    pub field: String,
    /// What is wrong, in English.
    pub message: String,
}

/// Collects gaps in the order they are found.
#[derive(Default)]
struct Gaps(Vec<Gap>);

impl Gaps {
    fn add(&mut self, field: impl Into<String>, message: impl Into<String>) {
        self.0.push(Gap {
            field: field.into(),
            message: message.into(),
        });
    }
}

/// `Ok` when `key` is 2 to 32 characters of `a-z`, `0-9` and `_`; else `InvalidSegmentKey`.
pub fn validate_segment_key(key: &str) -> Result<(), StrategyError> {
    let well_formed = (2..=32).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if well_formed {
        Ok(())
    } else {
        Err(StrategyError::InvalidSegmentKey(key.to_owned()))
    }
}

/// `Ok` when `code` looks like an ISO 4217 code (three uppercase ASCII letters, e.g. `TRY`);
/// else `InvalidCurrency`. Whether the code is assigned is not checked.
pub fn validate_currency(code: &str) -> Result<(), StrategyError> {
    if code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(StrategyError::InvalidCurrency(code.to_owned()))
    }
}

/// Every gap in the sections: the product is named; at least one segment, each with a
/// well-formed key used once; at least one channel; per budget lane, one lane per kind, a cap
/// that is not negative and a valid currency; a paid lane when paid channels are enabled; at
/// most [`MAX_PROHIBITIONS`] prohibitions; at most [`MAX_PER_WEEK`] posts a week; each mix
/// channel one of the chosen channels, listed once, and the shares summing to 100 unless the mix
/// is empty.
///
/// Gaps do not stop a section from being written; they stop the draft from being approved.
pub fn validate_sections(s: &Sections) -> Vec<Gap> {
    // Destructured in full so a new section cannot be added without deciding its rules here.
    let Sections {
        identity,
        audience,
        channels,
        goals: _,
        budget_frame,
        prohibitions,
        cadence,
        paid_enabled,
    } = s;
    let mut gaps = Gaps::default();

    if identity.product.trim().is_empty() {
        gaps.add("identity.product", "the product is required");
    }

    if audience.is_empty() {
        gaps.add("audience", "at least one segment is required");
    }
    let mut segment_keys = BTreeSet::new();
    for (i, segment) in audience.iter().enumerate() {
        let field = format!("audience[{i}].key");
        if let Err(e) = validate_segment_key(&segment.key) {
            gaps.add(field, e.to_string());
        } else if !segment_keys.insert(segment.key.as_str()) {
            gaps.add(
                field,
                format!("segment key {:?} is used more than once", segment.key),
            );
        }
    }

    if channels.is_empty() {
        gaps.add("channels", "at least one channel is required");
    }

    let mut lane_kinds = BTreeSet::new();
    for (i, lane) in budget_frame.lanes.iter().enumerate() {
        if !lane_kinds.insert(lane.lane) {
            gaps.add(
                format!("budget_frame.lanes[{i}].lane"),
                format!("there is already a {} lane", lane.lane.key()),
            );
        }
        if lane.cap_minor < 0 {
            gaps.add(
                format!("budget_frame.lanes[{i}].cap_minor"),
                "the cap must not be negative",
            );
        }
        if let Err(e) = validate_currency(&lane.currency) {
            gaps.add(format!("budget_frame.lanes[{i}].currency"), e.to_string());
        }
    }
    if *paid_enabled && !lane_kinds.contains(&LaneKind::Paid) {
        gaps.add(
            "budget_frame.lanes",
            "paid channels are enabled, so a paid lane is required",
        );
    }

    if prohibitions.len() > MAX_PROHIBITIONS {
        gaps.add(
            "prohibitions",
            format!(
                "at most {MAX_PROHIBITIONS} prohibitions, got {}",
                prohibitions.len()
            ),
        );
    }

    if cadence.per_week > MAX_PER_WEEK {
        gaps.add(
            "cadence.per_week",
            format!(
                "at most {MAX_PER_WEEK} posts a week, got {}",
                cadence.per_week
            ),
        );
    }
    let chosen: BTreeSet<&str> = channels.iter().map(|c| c.channel.as_str()).collect();
    let mut mixed = BTreeSet::new();
    for (i, mix) in cadence.channel_mix.iter().enumerate() {
        let field = format!("cadence.channel_mix[{i}].channel");
        if !chosen.contains(mix.channel.as_str()) {
            gaps.add(
                field,
                format!("{:?} is not one of the strategy's channels", mix.channel),
            );
        } else if !mixed.insert(mix.channel.as_str()) {
            gaps.add(field, format!("{:?} is listed more than once", mix.channel));
        }
    }
    let total: u32 = cadence
        .channel_mix
        .iter()
        .map(|m| u32::from(m.share_pct))
        .sum();
    if !cadence.channel_mix.is_empty() && total != 100 {
        gaps.add(
            "cadence.channel_mix",
            format!("the shares must sum to 100, got {total}"),
        );
    }

    gaps.0
}

/// Every gap that stops a draft from being approved (Review Focus 1): all of
/// [`validate_sections`]; every chosen channel is one the workspace has (`known_channels`, the
/// kinds of its capabilities) or [`ANY_CHANNEL`]; at least one hypothesis that is not retired;
/// no hypothesis listed twice; and for every live hypothesis a title, an angle and a metric, a
/// segment of the audience and a known channel. Retired hypotheses are neither counted nor
/// checked for segment and channel. Every hypothesis's confidence is in `0.0..=1.0`.
pub fn validate_for_approval(
    s: &Sections,
    hyps: &[Hypothesis],
    known_channels: &BTreeSet<String>,
) -> Vec<Gap> {
    let mut gaps = Gaps(validate_sections(s));
    let is_known = |channel: &str| channel == ANY_CHANNEL || known_channels.contains(channel);

    for (i, choice) in s.channels.iter().enumerate() {
        if !is_known(&choice.channel) {
            gaps.add(
                format!("channels[{i}].channel"),
                format!(
                    "the workspace has no capability of kind {:?}",
                    choice.channel
                ),
            );
        }
    }

    if !hyps.iter().any(|h| h.state.is_live()) {
        gaps.add(
            "hypotheses",
            "at least one hypothesis that is not retired is required",
        );
    }
    let segment_keys: BTreeSet<&str> = s.audience.iter().map(|g| g.key.as_str()).collect();
    let mut ids = BTreeSet::new();
    for (i, h) in hyps.iter().enumerate() {
        let field = |name: &str| format!("hypotheses[{i}].{name}");
        if !ids.insert(h.id) {
            gaps.add(field("id"), "the hypothesis is listed more than once");
        }
        if h.state.is_live() {
            if h.title.trim().is_empty() {
                gaps.add(field("title"), "a title is required");
            }
            if !segment_keys.contains(h.segment_key.as_str()) {
                gaps.add(
                    field("segment_key"),
                    format!("{:?} is not one of the audience's segments", h.segment_key),
                );
            }
            if h.angle.trim().is_empty() {
                gaps.add(field("angle"), "an angle is required");
            }
            if !is_known(&h.channel) {
                gaps.add(
                    field("channel"),
                    format!("the workspace has no capability of kind {:?}", h.channel),
                );
            }
            if h.metric.trim().is_empty() {
                gaps.add(field("metric"), "a metric is required");
            }
        }
        if !(0.0..=1.0).contains(&h.confidence) {
            gaps.add(
                field("confidence"),
                "the confidence must be between 0 and 1",
            );
        }
    }

    gaps.0
}

/// The starting point of a new draft: a copy of the approved version's sections, and its
/// hypotheses with the same ids, all `Kept`. A hypothesis already retired in the approved
/// version is not carried over (it stays retired).
pub fn next_draft_from(
    approved: &StrategyVersion,
    hyps: &[Hypothesis],
) -> (Sections, Vec<Hypothesis>) {
    let kept = hyps
        .iter()
        .filter(|h| h.state.is_live())
        .map(|h| Hypothesis {
            state: HypothesisState::Kept,
            ..h.clone()
        })
        .collect();
    (approved.sections.clone(), kept)
}

/// The dotted paths of the fields that differ between `a` and `b`, sorted. A list (segments,
/// channels, KPIs, lanes, prohibitions, the channel mix) is named as a whole when any of its
/// items differs or its length does.
pub fn diff(a: &Sections, b: &Sections) -> Vec<String> {
    // Destructured in full so a new field cannot be added without being compared here.
    let Sections {
        identity:
            Identity {
                product,
                voice,
                positioning,
                usp,
            },
        audience,
        channels,
        goals: Goals { objective, kpis },
        budget_frame: BudgetFrame { lanes },
        prohibitions,
        cadence: Cadence {
            per_week,
            channel_mix,
        },
        paid_enabled,
    } = a;
    let checks = [
        ("identity.product", *product != b.identity.product),
        ("identity.voice", *voice != b.identity.voice),
        (
            "identity.positioning",
            *positioning != b.identity.positioning,
        ),
        ("identity.usp", *usp != b.identity.usp),
        ("audience", *audience != b.audience),
        ("channels", *channels != b.channels),
        ("goals.objective", *objective != b.goals.objective),
        ("goals.kpis", *kpis != b.goals.kpis),
        ("budget_frame.lanes", *lanes != b.budget_frame.lanes),
        ("prohibitions", *prohibitions != b.prohibitions),
        ("cadence.per_week", *per_week != b.cadence.per_week),
        ("cadence.channel_mix", *channel_mix != b.cadence.channel_mix),
        ("paid_enabled", *paid_enabled != b.paid_enabled),
    ];
    let mut paths: Vec<String> = checks
        .into_iter()
        .filter(|(_, differs)| *differs)
        .map(|(path, _)| path.to_owned())
        .collect();
    paths.sort();
    paths
}

/// The cap of the `lane` lane: `(cap in minor units, period, currency)`, or `None` when the
/// budget frame has no such lane. One lane per kind is a rule of [`validate_sections`]; should a
/// frame break it, the first lane of the kind counts.
pub fn budget_cap_for(s: &Sections, lane: LaneKind) -> Option<(i64, Period, String)> {
    s.budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == lane)
        .map(|l| (l.cap_minor, l.period, l.currency.clone()))
}
