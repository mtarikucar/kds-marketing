//! Lead distribution's persistence (spec 2026-10-30-leads-pool-outreach-design.md §3.9, §4.2,
//! §6.1): each member's distribution settings, the workspace's ordered rules, and the log of every
//! decision about a journey's owner (`0021_distribution`). The decision itself is
//! `jt_inbox::choose`'s; the journey's `owner_id` stays the truth for ownership.
//!
//! Contracts every adapter keeps beyond the module's:
//! - A journey has at most one live decision (no `superseded_at`): inserting a second one is
//!   `CONFLICT` (the use case supersedes first, in the same bundle).
//! - A decision row is append-only except `acted_at` and `superseded_at`, each written once; a
//!   row goes only with its journey.
//! - A rule's, the default rule's and an SLA reassignment's decision name a member; nobody
//!   eligible and a departed owner name none; a manager's and an import's may name either. A
//!   due time needs a member. A write that breaks this is `INTERNAL`.
//! - The repositories never read a clock: every time comes from the caller.

use async_trait::async_trait;
use jt_inbox::{AssignmentId, Cause, JourneyId, RepProfile, Rule, RuleId};
use jt_ledger::Actor;
use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::AppError;

/// The most rules a workspace holds (`distribution_rules.position` is `0..=99`).
pub const MAX_RULES: usize = 100;

/// The most rows one [`AssignmentRepo::list`] or [`AssignmentRepo::ownerless_open`] returns.
pub const MAX_ASSIGNMENT_PAGE: u32 = 200;

/// One decision about a journey's owner (`journey_assignments`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignmentRow {
    pub id: AssignmentId,
    pub journey_id: JourneyId,
    /// The member named; none when nobody was eligible, the owner left, or a manager or an
    /// import left the journey without one.
    pub user_id: Option<UserId>,
    pub cause: Cause,
    /// The rule that chose; none for the default rule and every other cause.
    pub rule_id: Option<RuleId>,
    #[serde(with = "time::serde::rfc3339")]
    pub assigned_at: OffsetDateTime,
    /// When an unacted assignment moves on (inside the owner's working hours).
    #[serde(with = "time::serde::rfc3339::option")]
    pub sla_due_at: Option<OffsetDateTime>,
    /// When the owner first acted after the assignment.
    #[serde(with = "time::serde::rfc3339::option")]
    pub acted_at: Option<OffsetDateTime>,
    /// When a later decision replaced this one.
    #[serde(with = "time::serde::rfc3339::option")]
    pub superseded_at: Option<OffsetDateTime>,
    /// Who decided: a manager, or the system for rules, imports and departures.
    pub by: Actor,
}

/// Where a page of [`AssignmentRepo::list`] continues: the last row's time and id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignmentCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub assigned_at: OffsetDateTime,
    pub id: AssignmentId,
}

/// Which decisions [`AssignmentRepo::list`] reads, newest first (`(assigned_at, id)` desc):
/// every filter given must hold; `before` continues from a page's `next`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssignmentQuery {
    pub journey_id: Option<JourneyId>,
    pub user_id: Option<UserId>,
    pub limit: u32,
    pub before: Option<AssignmentCursor>,
}

/// A page of decisions; `next` names where the following page starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssignmentPage {
    pub items: Vec<AssignmentRow>,
    pub next: Option<AssignmentCursor>,
}

/// Which ownerless open journeys [`AssignmentRepo::ownerless_open`] answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerlessScope {
    /// Those no decision has settled yet: no live decision, or a live `member_left` one (a
    /// departure asks for a new owner). The one-minute job's work.
    Undecided,
    /// Every one, whatever its live decision (an import's, nobody eligible, a manager's
    /// unassignment): a manager's backfill.
    All,
}

/// The open journeys without an owner, whatever the cause (the `ownerless_journeys` work item).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ownerless {
    pub count: u32,
    /// The longest-open one.
    pub oldest_journey_id: Option<JourneyId>,
}

/// Each member's distribution settings.
#[async_trait]
pub trait RepProfileRepo: Send + Sync {
    /// The member's profile, or [`RepProfile::default_for`] when they never set one.
    async fn get(&mut self, user: UserId) -> Result<RepProfile, AppError>;
    /// The stored profiles, by user id.
    async fn list(&mut self) -> Result<Vec<RepProfile>, AppError>;
    /// Stores the profile whole (inserting or replacing).
    async fn set(&mut self, profile: &RepProfile) -> Result<(), AppError>;
}

/// The workspace's ordered rules.
#[async_trait]
pub trait RuleRepo: Send + Sync {
    /// Every rule, in order.
    async fn list(&mut self) -> Result<Vec<Rule>, AppError>;
    /// Replaces every rule: `rules[i]` gets position `i`; at most [`MAX_RULES`] (more is
    /// `INTERNAL`: the use case validates first).
    async fn replace_all(&mut self, rules: &[Rule], at: OffsetDateTime) -> Result<(), AppError>;
    /// Records the member a rule assigned last; `false` when the rule is gone.
    async fn set_cursor(&mut self, id: RuleId, user: UserId) -> Result<bool, AppError>;
}

/// The log of decisions about journeys' owners.
#[async_trait]
pub trait AssignmentRepo: Send + Sync {
    /// The journey's live decision.
    async fn live(&mut self, journey: JourneyId) -> Result<Option<AssignmentRow>, AppError>;
    /// Appends a live decision (`superseded_at` none). A second live decision for the journey
    /// is `CONFLICT`; a journey of another workspace is `NOT_FOUND`.
    async fn insert(&mut self, row: &AssignmentRow) -> Result<(), AppError>;
    /// Marks the journey's live decision replaced at `at`; `false` when it has none.
    async fn supersede(&mut self, journey: JourneyId, at: OffsetDateTime)
    -> Result<bool, AppError>;
    /// Marks the live decision acted on at `at` when it names `user` and was not acted on yet;
    /// whether it did.
    async fn touch(
        &mut self,
        journey: JourneyId,
        user: UserId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Live, unacted decisions of open journeys due at or before `now`, oldest due first, whose
    /// journey was reassigned for its SLA fewer than `max_reassignments` times (the rest are
    /// stalled: never answered again, so they never crowd out the others).
    async fn due_sla(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
        limit: u32,
    ) -> Result<Vec<AssignmentRow>, AppError>;
    /// Live, unacted decisions of open journeys due at or before `now` whose journey was
    /// reassigned for its SLA `max_reassignments` times or more.
    async fn count_stalled(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
    ) -> Result<u32, AppError>;
    /// Open journeys without an owner, longest open first.
    async fn ownerless_open(
        &mut self,
        scope: OwnerlessScope,
        limit: u32,
    ) -> Result<Vec<JourneyId>, AppError>;
    /// Every open journey without an owner, whatever the cause.
    async fn count_ownerless(&mut self) -> Result<Ownerless, AppError>;
    /// Every member a decision of the journey ever named, by user id.
    async fn previous_assignees(&mut self, journey: JourneyId) -> Result<Vec<UserId>, AppError>;
    /// How many times the journey was reassigned for its SLA.
    async fn reassignments(&mut self, journey: JourneyId) -> Result<u32, AppError>;
    /// The member the latest `default` decision named: where the default rule's round robin
    /// continues.
    async fn default_cursor(&mut self) -> Result<Option<UserId>, AppError>;
    /// How many open journeys each owner holds (owners with none are absent).
    async fn open_owned(&mut self) -> Result<Vec<(UserId, u32)>, AppError>;
    /// Decisions, newest first.
    async fn list(&mut self, q: &AssignmentQuery) -> Result<AssignmentPage, AppError>;
}

/// Whether a decision of `cause` may name `user` (the `journey_assignments_user_check`), and a
/// due time only with a member.
pub fn assignment_row_valid(row: &AssignmentRow) -> bool {
    let named = row.user_id.is_some();
    let user_ok = match row.cause {
        Cause::Rule | Cause::Default | Cause::SlaReassign => named,
        Cause::NoEligible | Cause::MemberLeft => !named,
        Cause::Manual | Cause::Import => true,
    };
    user_ok && (row.sla_due_at.is_none() || named)
}
