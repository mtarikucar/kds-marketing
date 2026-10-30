//! Research tasks' briefs (spec §3.7): what to look for, where, and what disqualifies.

use jt_strategy::Area;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{ProspectError, Recorder, bounded, chars, invalid, language_ok};

/// What a research task asks agents to find. An ICP entry's brief names its segment; an ad-hoc
/// one may not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Brief {
    pub segment_key: Option<String>,
    /// `1..=10`, each `1..=80` characters.
    pub sectors: Vec<String>,
    /// `1..=20`.
    pub areas: Vec<Area>,
    /// `0..=10`, each `1..=200`: what to look for.
    pub signals: Vec<String>,
    /// `0..=10`, each `1..=200`: what disqualifies.
    pub exclusions: Vec<String>,
    /// At most 200 characters.
    pub size_hint: String,
    pub language: Option<String>,
    /// At most 1000 characters.
    pub note: String,
}

fn count(field: &'static str, n: usize, min: usize, max: usize) -> Result<(), ProspectError> {
    if (min..=max).contains(&n) {
        Ok(())
    } else {
        Err(invalid(field, "count"))
    }
}

/// Checks a brief's bounds (the same as an ICP entry's, the segment optional).
pub fn validate_brief(b: &Brief) -> Result<(), ProspectError> {
    if let Some(s) = &b.segment_key
        && jt_strategy::validate_segment_key(s).is_err()
    {
        return Err(invalid("segment_key", "invalid"));
    }
    count("sectors", b.sectors.len(), 1, 10)?;
    b.sectors
        .iter()
        .try_for_each(|s| bounded("sectors", s, 1, 80))?;
    count("areas", b.areas.len(), 1, 20)?;
    for a in &b.areas {
        if !(1..=80).contains(&chars(a.city.trim())) {
            return Err(invalid("areas", "city_length"));
        }
        if a.district
            .as_deref()
            .is_some_and(|d| !(1..=80).contains(&chars(d.trim())))
        {
            return Err(invalid("areas", "district_length"));
        }
    }
    count("signals", b.signals.len(), 0, 10)?;
    b.signals
        .iter()
        .try_for_each(|s| bounded("signals", s, 1, 200))?;
    count("exclusions", b.exclusions.len(), 0, 10)?;
    b.exclusions
        .iter()
        .try_for_each(|s| bounded("exclusions", s, 1, 200))?;
    if chars(&b.size_hint) > 200 {
        return Err(invalid("size_hint", "too_long"));
    }
    if b.language.as_deref().is_some_and(|l| !language_ok(l)) {
        return Err(invalid("language", "invalid"));
    }
    if chars(&b.note) > 1_000 {
        return Err(invalid("note", "too_long"));
    }
    Ok(())
}

/// Where a research task comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskKind {
    /// One per ICP entry of the approved strategy version, kept open by the planning job.
    Standing { icp_key: String },
    /// Asked for by a person or an agent: done when `target_count` (`1..=500`) are found.
    AdHoc { target_count: u16 },
}

/// A research task's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    Done,
    Canceled,
    /// A newer approved strategy version replaced its ICP entry.
    Superseded,
}

impl TaskStatus {
    /// Every status.
    pub const ALL: &[TaskStatus] = &[
        TaskStatus::Open,
        TaskStatus::Done,
        TaskStatus::Canceled,
        TaskStatus::Superseded,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::Done => "done",
            TaskStatus::Canceled => "canceled",
            TaskStatus::Superseded => "superseded",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<TaskStatus> {
        TaskStatus::ALL.iter().copied().find(|s| s.key() == key)
    }
}

/// An advisory lease on a task: who works on it, until when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    pub by: Recorder,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
}
