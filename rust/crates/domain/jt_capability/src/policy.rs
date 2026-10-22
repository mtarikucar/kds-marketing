//! A capability's policies: working hours, caps, the human-approval flag and how long a
//! verification lasts (spec §6.1 "politikalar").

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{Gap, Gaps};

/// How many days a verification lasts unless the policy says otherwise.
pub const DEFAULT_VERIFY_MAX_AGE_DAYS: u16 = 30;

/// The longest time zone name accepted, in characters (the longest IANA name is about half).
pub const MAX_TZ_CHARS: usize = 64;

/// What a capability may do and when.
///
/// Stored, so reading is tolerant: a missing field reads as its [`Default`] value (no hours, no
/// caps, no human approval, verification lasting [`DEFAULT_VERIFY_MAX_AGE_DAYS`] days) and an
/// unknown field is ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    /// When the capability may act; `None` means at any time.
    pub active_hours: Option<Hours>,
    /// The most operations per day; `None` means no cap, `Some(0)` none at all.
    pub daily_ops_cap: Option<u32>,
    /// The most it may spend, in minor units of the linked budget item's currency; not negative.
    pub spend_cap_minor: Option<i64>,
    /// Whether every action through it waits for a human's approval. Off by default (K8).
    pub requires_human_approval: bool,
    /// How many days a verification lasts before the capability reads as
    /// [`crate::EffectiveStatus::Stale`]; 0 means it never goes stale.
    pub verify_max_age_days: u16,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            active_hours: None,
            daily_ops_cap: None,
            spend_cap_minor: None,
            requires_human_approval: false,
            verify_max_age_days: DEFAULT_VERIFY_MAX_AGE_DAYS,
        }
    }
}

/// A weekly window of working hours in a time zone: active from `from`:00 until `to`:00 (local
/// time, `to` excluded) on each of `days`.
///
/// Stored, so reading is tolerant: a missing field reads as its [`Default`] value, and the
/// default window (`UTC`, 0 to 0, no days) is never open, so a damaged window allows nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hours {
    /// `"UTC"` or an IANA zone name such as `Europe/Istanbul`.
    pub tz: String,
    /// The first hour, `0..=23`.
    pub from: u8,
    /// The hour the window closes, `0..=23`, after `from`.
    pub to: u8,
    /// ISO weekdays, 1 (Monday) to 7 (Sunday), each at most once.
    pub days: Vec<u8>,
}

impl Default for Hours {
    fn default() -> Self {
        Hours {
            tz: "UTC".to_owned(),
            from: 0,
            to: 0,
            days: Vec::new(),
        }
    }
}

/// Whether `tz` looks like an IANA time zone: `UTC`, or two or more `/`-separated non-empty
/// segments of ASCII letters, `_` and `-` (`Europe/Istanbul`, `America/Port-au-Prince`), at most
/// [`MAX_TZ_CHARS`] long. Whether the zone exists is not checked.
fn looks_like_iana_zone(tz: &str) -> bool {
    if tz == "UTC" {
        return true;
    }
    tz.len() <= MAX_TZ_CHARS
        && tz.contains('/')
        && tz.split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphabetic() || b == b'_' || b == b'-')
        })
}

/// Every gap in a policy, under `policy.`: the hours' time zone looks like an IANA zone; `from`
/// and `to` are `0..=23` with `from < to`; at least one day, each `1..=7` and listed once; the
/// spend cap is not negative. Any ops cap and any verification age (0 = never stale) is valid.
pub fn validate_policy(p: &Policy) -> Vec<Gap> {
    // Destructured in full so a new field cannot be added without deciding its rules here.
    let Policy {
        active_hours,
        daily_ops_cap: _,
        spend_cap_minor,
        requires_human_approval: _,
        verify_max_age_days: _,
    } = p;
    let mut gaps = Gaps::default();

    if let Some(Hours { tz, from, to, days }) = active_hours {
        if !looks_like_iana_zone(tz) {
            gaps.add(
                "policy.active_hours.tz",
                format!(
                    "{tz:?} is not a time zone: use UTC or an IANA name such as Europe/Istanbul"
                ),
            );
        }
        let from_ok = *from <= 23;
        let to_ok = *to <= 23;
        if !from_ok {
            gaps.add(
                "policy.active_hours.from",
                format!("the hour must be 0 to 23, got {from}"),
            );
        }
        if !to_ok {
            gaps.add(
                "policy.active_hours.to",
                format!("the hour must be 0 to 23, got {to}"),
            );
        }
        if from_ok && to_ok && from >= to {
            gaps.add(
                "policy.active_hours.to",
                format!("the window must close after it opens ({from} to {to})"),
            );
        }
        if days.is_empty() {
            gaps.add("policy.active_hours.days", "at least one day is required");
        }
        let mut seen = BTreeSet::new();
        for (i, day) in days.iter().enumerate() {
            let field = format!("policy.active_hours.days[{i}]");
            if !(1..=7).contains(day) {
                gaps.add(
                    field,
                    format!("a day is 1 (Monday) to 7 (Sunday), got {day}"),
                );
            } else if !seen.insert(*day) {
                gaps.add(field, format!("day {day} is listed more than once"));
            }
        }
    }

    if let Some(cap) = spend_cap_minor
        && *cap < 0
    {
        gaps.add(
            "policy.spend_cap_minor",
            "the spend cap must not be negative",
        );
    }

    gaps.0
}
