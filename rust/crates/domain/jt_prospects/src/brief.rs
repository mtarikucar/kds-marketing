//! Research tasks' briefs (spec §3.7): what to look for, where, and what disqualifies; the
//! claim lease and what a task may still record today.

use jt_strategy::{Area, IcpEntry, StrategyVersionId};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::{
    MAX_DAILY_PROSPECTS, ProspectError, Recorder, ResearchTaskId, bounded, chars, invalid,
    language_ok,
};

/// How long a claim on a task lasts (spec §3.7): two hours.
pub const CLAIM_LEASE: Duration = Duration::hours(2);
/// The most prospects an ad-hoc task asks for.
pub const MAX_TASK_TARGET: u16 = 500;
/// The most prospects a task records per local day (`research_tasks.daily_cap`).
pub const MAX_TASK_DAILY_CAP: u16 = 500;

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

fn trimmed_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Brief {
    /// The brief as stored: every text trimmed, empty list entries and an empty district
    /// dropped, the language lower-cased.
    pub fn normalised(self) -> Brief {
        Brief {
            segment_key: self.segment_key.map(|s| s.trim().to_owned()),
            sectors: trimmed_list(self.sectors),
            areas: self
                .areas
                .into_iter()
                .map(|a| Area {
                    city: a.city.trim().to_owned(),
                    district: a
                        .district
                        .map(|d| d.trim().to_owned())
                        .filter(|d| !d.is_empty()),
                })
                .collect(),
            signals: trimmed_list(self.signals),
            exclusions: trimmed_list(self.exclusions),
            size_hint: self.size_hint.trim().to_owned(),
            language: self.language.map(|l| l.trim().to_ascii_lowercase()),
            note: self.note.trim().to_owned(),
        }
    }
}

/// The brief of an ICP entry's standing task: its segment, sectors, areas, signals,
/// exclusions, size hint and language, normalised; no note.
pub fn standing_brief(e: &IcpEntry) -> Brief {
    Brief {
        segment_key: Some(e.segment_key.clone()),
        sectors: e.sectors.clone(),
        areas: e.areas.clone(),
        signals: e.signals.clone(),
        exclusions: e.exclusions.clone(),
        size_hint: e.size_hint.clone(),
        language: e.language.clone(),
        note: String::new(),
    }
    .normalised()
}

/// An ad-hoc task's numbers: a target of `1..=MAX_TASK_TARGET` prospects, a daily cap of
/// `1..=MAX_TASK_DAILY_CAP`.
pub fn validate_ad_hoc(target_count: u16, daily_cap: u16) -> Result<(), ProspectError> {
    if !(1..=MAX_TASK_TARGET).contains(&target_count) {
        return Err(invalid("target_count", "range"));
    }
    if !(1..=MAX_TASK_DAILY_CAP).contains(&daily_cap) {
        return Err(invalid("daily_cap", "range"));
    }
    Ok(())
}

/// What an open task may still record today (spec §3.7), with the counts of today, in the
/// workspace's local day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacity {
    /// The task's daily cap.
    pub daily_cap: u16,
    /// Prospects the task recorded today.
    pub recorded_today: u32,
    /// Prospects the workspace recorded today (its ceiling is [`MAX_DAILY_PROSPECTS`]).
    pub workspace_today: u32,
    /// For an ad-hoc task, how many it still has to find.
    pub target_left: Option<u32>,
    /// For a standing task, its segment's backlog (unpromoted `new` and `qualified` prospects)
    /// and the ICP entry's `backlog_target`.
    pub backlog: Option<(u32, u16)>,
}

/// How many prospects an open task may still record today: its daily cap less what it recorded
/// today, never more than the workspace's ceiling leaves nor (ad hoc) than it still has to find;
/// zero for a standing task while its segment's backlog is at its target. A `backlog_target` of
/// 0 sets no limit (spec D37).
pub fn remaining_today(c: &Capacity) -> u32 {
    if let Some((backlog, target)) = c.backlog
        && target > 0
        && backlog >= u32::from(target)
    {
        return 0;
    }
    let task = u32::from(c.daily_cap).saturating_sub(c.recorded_today);
    let workspace = MAX_DAILY_PROSPECTS.saturating_sub(c.workspace_today);
    let mut left = task.min(workspace);
    if let Some(target) = c.target_left {
        left = left.min(target);
    }
    left
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

/// A research task (spec §3.7): a brief agents fill the pool from, with its caps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchTask {
    pub id: ResearchTaskId,
    pub workspace_id: WorkspaceId,
    pub kind: TaskKind,
    /// The approved strategy version it was made under.
    pub strategy_version_id: StrategyVersionId,
    pub brief: Brief,
    /// The digest of that version's rubric.
    pub rubric_digest: String,
    /// Prospects created per local day for this task, `1..=500`.
    pub daily_cap: u16,
    pub status: TaskStatus,
    #[serde(default)]
    pub claim: Option<Claim>,
    pub created_by: Recorder,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub close_note: String,
}
