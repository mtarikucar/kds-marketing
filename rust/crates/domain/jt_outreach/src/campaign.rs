//! Campaigns (spec §3.10, §3.13, D13, D19): the definition and its bounds, the audience
//! filters, and the state machine whose approval is bound to a revision (any edit voids it).
//! Who may launch, approve or cancel is the application's (a human with `outreach.manage`
//! approves; see the plan's L4-T4).

use jt_capability::{Hours, Policy, validate_policy};
use jt_inbox::{JourneyStatus, PersonId, RecipientKind, SourceKind};
use jt_prospects::ResearchTaskId;
use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{Lang, TemplateId, line};

/// The most steps of a campaign (a one-off is one step).
pub const MAX_STEPS: usize = 6;
/// The longest wait before a later step, in days (the first step waits 0).
pub const MAX_DELAY_DAYS: u16 = 30;
/// The most sends of a campaign in an hour.
pub const MAX_PER_HOUR: u16 = 60;
/// The most sends of a campaign in a day.
pub const MAX_PER_DAY: u16 = 500;
/// The longest sender display name, in characters.
pub const MAX_SENDER_NAME_CHARS: usize = 80;
/// The longest campaign name, in characters.
pub const MAX_CAMPAIGN_NAME_CHARS: usize = 120;
/// The most enrollments of one campaign.
pub const MAX_ENROLLMENTS: u32 = 5_000;
/// The most people an audience names one by one.
pub const MAX_EXPLICIT: usize = 500;
/// The most values one audience filter list holds.
pub const MAX_FILTER_VALUES: usize = 50;
/// The longest audience filter value, in characters.
pub const MAX_FILTER_VALUE_CHARS: usize = 80;
/// The longest segment key, in characters.
const MAX_SEGMENT_KEY_CHARS: usize = 64;

/// A step's template as it was at launch: later template edits never reach a running campaign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepSnapshot {
    pub template_revision: u32,
    pub subject: String,
    pub body: String,
    /// The body's links, by index (a click link names its index).
    #[serde(default)]
    pub links: Vec<String>,
    pub language: Lang,
}

/// One email of a sequence. No attachments (D12).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub template_id: TemplateId,
    /// Days after the previous step: 0 for the first, then `1..=MAX_DELAY_DAYS`.
    pub delay_days: u16,
    /// Reply in the previous step's thread (never on the first step).
    #[serde(default)]
    pub same_thread: bool,
    /// Set at launch.
    #[serde(default)]
    pub snapshot: Option<StepSnapshot>,
}

/// When a campaign sends: from `start_at` (at once when absent), inside `window`, which the
/// dispatcher also intersects with the mailbox's own `active_hours`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub start_at: Option<OffsetDateTime>,
    pub window: Hours,
}

/// A campaign's own pace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Throttle {
    /// `1..=MAX_PER_HOUR`.
    pub per_hour: u16,
    /// `1..=MAX_PER_DAY`.
    pub per_day: u16,
}

/// Whom a campaign enrolls at launch (frozen then; refreshed daily for an evergreen one).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Audience {
    #[serde(default)]
    pub people: Option<PeopleFilter>,
    /// Qualified prospects, promoted first at enrollment.
    #[serde(default)]
    pub prospects: Option<ProspectFilter>,
    /// People named one by one (at most [`MAX_EXPLICIT`]).
    #[serde(default)]
    pub explicit: Vec<PersonId>,
}

/// Inbox people by their open journey. An empty list matches any value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PeopleFilter {
    /// Open stages only.
    pub journey_statuses: Vec<JourneyStatus>,
    pub owner: Option<OwnerFilter>,
    pub source_kinds: Vec<SourceKind>,
    pub recipient_kind: Option<RecipientKind>,
    pub segments: Vec<String>,
    pub cities: Vec<String>,
    /// Through the linked prospect.
    pub sectors: Vec<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub opened_after: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub opened_before: Option<OffsetDateTime>,
}

/// Whose journeys a people filter takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OwnerFilter {
    User {
        user_id: UserId,
    },
    /// Journeys without an owner.
    Unowned,
}

/// Qualified prospects of the pool. An empty list matches any value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProspectFilter {
    pub segment_keys: Vec<String>,
    pub research_task_ids: Vec<ResearchTaskId>,
    pub cities: Vec<String>,
    pub sectors: Vec<String>,
    pub min_score: Option<u8>,
}

/// What a campaign sends, to whom, when and how fast: the editable part of a campaign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    /// The From display name, `1..=MAX_SENDER_NAME_CHARS` characters on one line.
    pub sender_name: String,
    pub steps: Vec<Step>,
    pub audience: Audience,
    pub schedule: Schedule,
    pub throttle: Throttle,
    /// Off by default (D20).
    #[serde(default)]
    pub click_tracking: bool,
    #[serde(default)]
    pub evergreen: bool,
    #[serde(default)]
    pub segment_key: Option<String>,
}

/// Where a campaign stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStatus {
    Draft,
    AwaitingApproval,
    Scheduled,
    Running,
    Paused,
    Completed,
    Canceled,
}

impl CampaignStatus {
    /// Every status.
    pub const ALL: &[CampaignStatus] = &[
        CampaignStatus::Draft,
        CampaignStatus::AwaitingApproval,
        CampaignStatus::Scheduled,
        CampaignStatus::Running,
        CampaignStatus::Paused,
        CampaignStatus::Completed,
        CampaignStatus::Canceled,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            CampaignStatus::Draft => "draft",
            CampaignStatus::AwaitingApproval => "awaiting_approval",
            CampaignStatus::Scheduled => "scheduled",
            CampaignStatus::Running => "running",
            CampaignStatus::Paused => "paused",
            CampaignStatus::Completed => "completed",
            CampaignStatus::Canceled => "canceled",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<CampaignStatus> {
        CampaignStatus::ALL.iter().copied().find(|s| s.key() == key)
    }

    /// Completed and canceled campaigns never move again.
    pub fn is_final(self) -> bool {
        matches!(self, CampaignStatus::Completed | CampaignStatus::Canceled)
    }
}

/// Why a campaign is paused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    Manual,
    /// More than 5 % hard bounces among the last 50 sends (D15).
    BounceRate,
    /// Two complaints among the last 200 sends (D15).
    Complaints,
    MailboxDown,
    StrategyChanged,
}

impl PauseReason {
    /// Every reason.
    pub const ALL: &[PauseReason] = &[
        PauseReason::Manual,
        PauseReason::BounceRate,
        PauseReason::Complaints,
        PauseReason::MailboxDown,
        PauseReason::StrategyChanged,
    ];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            PauseReason::Manual => "manual",
            PauseReason::BounceRate => "bounce_rate",
            PauseReason::Complaints => "complaints",
            PauseReason::MailboxDown => "mailbox_down",
            PauseReason::StrategyChanged => "strategy_changed",
        }
    }

    /// The reason with this key, if any.
    pub fn parse(key: &str) -> Option<PauseReason> {
        PauseReason::ALL.iter().copied().find(|r| r.key() == key)
    }
}

/// A human's approval of one revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub revision: u32,
    pub by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// What happens to a campaign. `now` decides between `Scheduled` and `Running` against the
/// schedule's `start_at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CampaignEvent {
    /// From `Draft`; `approval_required` is [`requires_approval`] of the policy and mailbox.
    Launch {
        approval_required: bool,
        now: OffsetDateTime,
    },
    /// A human approves `revision` (it must be the campaign's current one).
    Approve {
        revision: u32,
        now: OffsetDateTime,
    },
    /// A scheduled campaign's start time came.
    Start {
        now: OffsetDateTime,
    },
    Pause {
        reason: PauseReason,
    },
    /// Re-checks the approval at the current revision.
    Resume {
        approval_required: bool,
        now: OffsetDateTime,
    },
    /// No active enrollment is left (and the campaign is not evergreen): the application's call.
    Complete,
    Cancel,
    /// A save; the application bumps the revision.
    Edit,
}

impl CampaignEvent {
    /// The event as a past participle, for refusals.
    pub fn key(&self) -> &'static str {
        match self {
            CampaignEvent::Launch { .. } => "launched",
            CampaignEvent::Approve { .. } => "approved",
            CampaignEvent::Start { .. } => "started",
            CampaignEvent::Pause { .. } => "paused",
            CampaignEvent::Resume { .. } => "resumed",
            CampaignEvent::Complete => "completed",
            CampaignEvent::Cancel => "canceled",
            CampaignEvent::Edit => "edited",
        }
    }
}

/// What a move does to the stored approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalChange {
    Keep,
    /// Remove it (an edit).
    Void,
    /// Record the approval of the event's revision.
    Set,
}

/// A campaign rule refused a move or a definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CampaignError {
    /// `field` is a dotted path (`steps.delay_days`, `audience.people.cities`), `reason` a
    /// stable key; neither carries a value.
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
    #[error("a {from} campaign cannot be {event}")]
    Transition {
        from: &'static str,
        event: &'static str,
    },
    /// An approval named a revision that is not the campaign's current one.
    #[error("stale_revision")]
    StaleRevision,
    /// A scheduled campaign's start time has not come.
    #[error("not_yet")]
    NotYet,
}

fn invalid(field: &'static str, reason: &'static str) -> CampaignError {
    CampaignError::Invalid { field, reason }
}

/// Whether launching (or resuming) needs a human's approval of the revision: the workspace's
/// outreach policy says so, or the sending mailbox's policy requires human approval.
pub fn requires_approval(policy_requires_approval: bool, mailbox_requires_human: bool) -> bool {
    policy_requires_approval || mailbox_requires_human
}

/// The campaign state machine (spec §3.10):
///
/// | from | event | to |
/// |---|---|---|
/// | draft | launch | awaiting_approval when approval is required and this revision is not approved; else scheduled (start ahead) or running |
/// | awaiting_approval | approve (current revision) | scheduled or running; the approval is set |
/// | scheduled | start (start time reached) | running |
/// | scheduled, running | pause | paused |
/// | paused | resume | as launch |
/// | paused | approve (current revision) | paused; the approval is set |
/// | running | complete | completed |
/// | any but completed, canceled | cancel | canceled |
/// | draft, paused | edit | the same; the approval is voided |
///
/// Every other pair is [`CampaignError::Transition`]; an approval of another revision is
/// [`CampaignError::StaleRevision`].
pub fn campaign_next(
    status: CampaignStatus,
    approval: Option<&Approval>,
    revision: u32,
    start_at: Option<OffsetDateTime>,
    event: &CampaignEvent,
) -> Result<(CampaignStatus, ApprovalChange), CampaignError> {
    use ApprovalChange::{Keep, Set, Void};
    use CampaignStatus as S;
    let approved = approval.is_some_and(|a| a.revision == revision);
    let go = |now: OffsetDateTime| {
        if start_at.is_some_and(|at| at > now) {
            S::Scheduled
        } else {
            S::Running
        }
    };
    match (status, event) {
        (
            S::Draft,
            CampaignEvent::Launch {
                approval_required,
                now,
            },
        )
        | (
            S::Paused,
            CampaignEvent::Resume {
                approval_required,
                now,
            },
        ) => {
            if *approval_required && !approved {
                Ok((S::AwaitingApproval, Keep))
            } else {
                Ok((go(*now), Keep))
            }
        }
        (S::AwaitingApproval | S::Paused, CampaignEvent::Approve { revision: r, now }) => {
            if *r != revision {
                return Err(CampaignError::StaleRevision);
            }
            let to = if status == S::Paused {
                S::Paused
            } else {
                go(*now)
            };
            Ok((to, Set))
        }
        (S::Scheduled, CampaignEvent::Start { now }) => {
            if start_at.is_some_and(|at| at > *now) {
                Err(CampaignError::NotYet)
            } else {
                Ok((S::Running, Keep))
            }
        }
        (S::Scheduled | S::Running, CampaignEvent::Pause { .. }) => Ok((S::Paused, Keep)),
        (S::Running, CampaignEvent::Complete) => Ok((S::Completed, Keep)),
        (s, CampaignEvent::Cancel) if !s.is_final() => Ok((S::Canceled, Keep)),
        (S::Draft | S::Paused, CampaignEvent::Edit) => Ok((status, Void)),
        _ => Err(CampaignError::Transition {
            from: status.key(),
            event: event.key(),
        }),
    }
}

/// A campaign's name: 1 to [`MAX_CAMPAIGN_NAME_CHARS`] characters on one line.
pub fn validate_campaign_name(name: &str) -> Result<(), CampaignError> {
    line(name, 1, MAX_CAMPAIGN_NAME_CHARS).map_err(|reason| invalid("name", reason))
}

/// A definition's bounds (spec §3.10): the sender name on one line; 1 to [`MAX_STEPS`] steps,
/// the first without a delay or a thread, the others `1..=MAX_DELAY_DAYS` days apart; the
/// throttle within `1..=MAX_PER_HOUR` and `1..=MAX_PER_DAY`; a valid sending window (a
/// capability's working-hours rules); a non-empty, bounded audience. Whether the templates exist
/// and the mailbox is one is the application's.
pub fn validate_definition(d: &Definition) -> Result<(), CampaignError> {
    // Destructured in full so a new field cannot be added without deciding its rules here.
    let Definition {
        sender_name,
        steps,
        audience,
        schedule,
        throttle,
        click_tracking: _,
        evergreen: _,
        segment_key,
    } = d;
    line(sender_name, 1, MAX_SENDER_NAME_CHARS).map_err(|r| invalid("sender_name", r))?;
    if !(1..=MAX_STEPS).contains(&steps.len()) {
        return Err(invalid("steps", "count"));
    }
    for (i, s) in steps.iter().enumerate() {
        if i == 0 {
            if s.delay_days != 0 {
                return Err(invalid("steps.delay_days", "first_step"));
            }
            if s.same_thread {
                return Err(invalid("steps.same_thread", "first_step"));
            }
        } else if !(1..=MAX_DELAY_DAYS).contains(&s.delay_days) {
            return Err(invalid("steps.delay_days", "range"));
        }
    }
    if !(1..=MAX_PER_HOUR).contains(&throttle.per_hour) {
        return Err(invalid("throttle.per_hour", "range"));
    }
    if !(1..=MAX_PER_DAY).contains(&throttle.per_day) {
        return Err(invalid("throttle.per_day", "range"));
    }
    let window = Policy {
        active_hours: Some(schedule.window.clone()),
        ..Policy::default()
    };
    if !validate_policy(&window).is_empty() {
        return Err(invalid("schedule.window", "invalid"));
    }
    validate_audience(audience)?;
    if let Some(key) = segment_key {
        line(key, 1, MAX_SEGMENT_KEY_CHARS).map_err(|_| invalid("segment_key", "length"))?;
    }
    Ok(())
}

/// An audience's bounds (spec §3.10): not empty, at most [`MAX_EXPLICIT`] people named one by
/// one, open stages only, bounded filter lists and an ordered opening window.
pub fn validate_audience(a: &Audience) -> Result<(), CampaignError> {
    if a.people.is_none() && a.prospects.is_none() && a.explicit.is_empty() {
        return Err(invalid("audience", "empty"));
    }
    if a.explicit.len() > MAX_EXPLICIT {
        return Err(invalid("audience.explicit", "too_many"));
    }
    if let Some(p) = &a.people {
        if p.journey_statuses
            .iter()
            .any(|s| matches!(s, JourneyStatus::Won | JourneyStatus::Lost))
        {
            return Err(invalid("audience.people.journey_statuses", "closed_stage"));
        }
        if p.journey_statuses.len() > MAX_FILTER_VALUES || p.source_kinds.len() > MAX_FILTER_VALUES
        {
            return Err(invalid("audience.people", "bounds"));
        }
        values("audience.people.segments", &p.segments)?;
        values("audience.people.cities", &p.cities)?;
        values("audience.people.sectors", &p.sectors)?;
        if let (Some(after), Some(before)) = (p.opened_after, p.opened_before)
            && after >= before
        {
            return Err(invalid("audience.people.opened_before", "range"));
        }
    }
    if let Some(p) = &a.prospects {
        values("audience.prospects.segment_keys", &p.segment_keys)?;
        values("audience.prospects.cities", &p.cities)?;
        values("audience.prospects.sectors", &p.sectors)?;
        if p.research_task_ids.len() > MAX_FILTER_VALUES {
            return Err(invalid("audience.prospects.research_task_ids", "bounds"));
        }
        if p.min_score.is_some_and(|s| s > 100) {
            return Err(invalid("audience.prospects.min_score", "range"));
        }
    }
    Ok(())
}

/// At most [`MAX_FILTER_VALUES`] values, each one line of 1 to [`MAX_FILTER_VALUE_CHARS`]
/// characters.
fn values(field: &'static str, list: &[String]) -> Result<(), CampaignError> {
    if list.len() > MAX_FILTER_VALUES
        || list
            .iter()
            .any(|v| line(v, 1, MAX_FILTER_VALUE_CHARS).is_err())
    {
        return Err(invalid(field, "bounds"));
    }
    Ok(())
}
