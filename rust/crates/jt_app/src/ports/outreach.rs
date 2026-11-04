//! Outreach's persistence (spec 2026-10-30-leads-pool-outreach-design.md §3.10–§3.14, §4.3,
//! §6.1): templates, campaigns, enrollments and one row per outreach email (`0026_outreach`).
//! The records' rules are `jt_outreach`'s; nothing here sends (the platform switch and the
//! fences are the use cases').
//!
//! Contracts every adapter keeps beyond the module's:
//! - A revision-checked write ([`TemplateRepo::update`], [`CampaignRepo::update`]) writes only
//!   when the stored revision is the expected one, and answers whether it wrote.
//! - A person has at most one `active` enrollment in a workspace, and one enrollment per
//!   campaign: [`EnrollmentRepo::insert_many`] never breaks either (it reports instead). A
//!   stopped or skipped enrollment holds its reason; an active one its next send time; any other
//!   write that breaks [`enrollment_row_valid`] is `INTERNAL`.
//! - A send's outcome moves only as [`SendOutcome::can_become`] allows; a reply, an unsubscribe
//!   and the first counted click are written once.
//! - Counts are computed from the rows. A `refused` send never left the mailbox and counts for no
//!   budget; every other one does (a `failed` send was attempted).
//! - The repositories never read a clock: every time comes from the caller.
//! - Templates and personalization hold the workspace's copy and recipients' values: log ids and
//!   counts, never a row.

use std::collections::BTreeMap;

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::{CommercialBasis, JourneyId, MessageId, PersonId};
use jt_ledger::Actor;
use jt_outreach::{
    Approval, CampaignId, CampaignStatus, Definition, EnrollmentId, EnrollmentStatus, PauseReason,
    SendId, SendOutcome, SkipReason, StopReason, Template, TemplateId,
};
use jt_prospects::ProspectId;
use jt_strategy::StrategyVersionId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// The most rows one list returns.
pub const MAX_OUTREACH_PAGE: u32 = 200;

/// The most enrollments one [`EnrollmentRepo::insert_many`] writes (an enrollment run's batch).
pub const MAX_ENROLLMENT_BATCH: usize = 500;

/// A stored template (`outreach_templates`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateRow {
    pub template: Template,
    pub created_by: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Where a page of templates continues: the last row's edit time and id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub id: TemplateId,
}

/// Which templates [`TemplateRepo::list`] reads, most recently edited first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TemplateQuery {
    pub include_archived: bool,
    pub limit: u32,
    pub before: Option<TemplateCursor>,
}

/// A page of templates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplatePage {
    pub items: Vec<TemplateRow>,
    pub next: Option<TemplateCursor>,
}

/// A stored campaign (`outreach_campaigns`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignRow {
    pub id: CampaignId,
    pub name: String,
    /// A `mailbox` capability of the workspace: the sender.
    pub mailbox_id: CapabilityId,
    pub status: CampaignStatus,
    pub definition: Definition,
    /// Starts at 1; each save is the next revision (and voids the approval).
    pub revision: u32,
    pub approval: Option<Approval>,
    /// Exactly when paused.
    pub pause_reason: Option<PauseReason>,
    /// The approved strategy version the campaign was made under.
    pub strategy_version_id: StrategyVersionId,
    pub created_by: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// Never set on a draft.
    #[serde(with = "time::serde::rfc3339::option")]
    pub launched_at: Option<OffsetDateTime>,
    /// Exactly when completed.
    #[serde(with = "time::serde::rfc3339::option")]
    pub completed_at: Option<OffsetDateTime>,
}

/// Whether a campaign row keeps `0026_outreach`'s checks: a pause reason exactly when paused, a
/// completion time exactly when completed, no launch time on a draft, a revision of at least 1.
pub fn campaign_row_valid(c: &CampaignRow) -> bool {
    let name = c.name.chars().count();
    (1..=jt_outreach::MAX_CAMPAIGN_NAME_CHARS).contains(&name)
        && c.revision >= 1
        && (c.status == CampaignStatus::Paused) == c.pause_reason.is_some()
        && (c.status == CampaignStatus::Completed) == c.completed_at.is_some()
        && (c.status != CampaignStatus::Draft || c.launched_at.is_none())
}

/// Where a page of campaigns continues: the last row's creation time and id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub id: CampaignId,
}

/// Which campaigns [`CampaignRepo::list`] reads, newest first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CampaignQuery {
    pub status: Option<CampaignStatus>,
    pub limit: u32,
    pub before: Option<CampaignCursor>,
}

/// A page of campaigns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CampaignPage {
    pub items: Vec<CampaignRow>,
    pub next: Option<CampaignCursor>,
}

/// One person in one campaign (`outreach_enrollments`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollmentRow {
    pub id: EnrollmentId,
    pub campaign_id: CampaignId,
    pub person_id: PersonId,
    pub journey_id: Option<JourneyId>,
    /// The prospect enrollment promoted the person from.
    pub prospect_id: Option<ProspectId>,
    pub status: EnrollmentStatus,
    /// Exactly when stopped.
    pub stop: Option<StopReason>,
    /// Exactly when skipped.
    pub skip: Option<SkipReason>,
    /// The step sent next, `1..=7` (7: past the sixth).
    pub next_step: u8,
    /// Set while active.
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_send_at: Option<OffsetDateTime>,
    /// `custom.*` keys (without the prefix) and their values.
    pub personalization: BTreeMap<String, String>,
    /// What the sends rest on; none for a skipped enrollment.
    pub basis: Option<CommercialBasis>,
    #[serde(with = "time::serde::rfc3339")]
    pub enrolled_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub stopped_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_sent_at: Option<OffsetDateTime>,
}

/// Whether an enrollment row keeps `0026_outreach`'s checks: a stop reason exactly when stopped,
/// a skip reason exactly when skipped, a next send time while active, `next_step` in `1..=7`.
pub fn enrollment_row_valid(e: &EnrollmentRow) -> bool {
    (e.status == EnrollmentStatus::Stopped) == e.stop.is_some()
        && (e.status == EnrollmentStatus::Skipped) == e.skip.is_some()
        && (e.status != EnrollmentStatus::Active || e.next_send_at.is_some())
        && (1..=7).contains(&e.next_step)
        && e.stop
            .as_ref()
            .is_none_or(|r| r.key().chars().count() <= 100)
}

/// The stored `reason` of an enrollment: its stop or skip reason's key.
pub fn enrollment_reason(e: &EnrollmentRow) -> Option<String> {
    e.stop
        .as_ref()
        .map(StopReason::key)
        .or_else(|| e.skip.map(|s| s.key().to_owned()))
}

/// What [`EnrollmentRepo::insert_many`] did with each row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InsertReport {
    /// Written as given.
    pub inserted: Vec<EnrollmentId>,
    /// Given active while the person is active in another campaign (or earlier in the batch):
    /// written as skipped (`active_elsewhere`), without a basis or a next send.
    pub active_elsewhere: Vec<EnrollmentId>,
    /// The person is in this campaign already: not written.
    pub already_enrolled: Vec<PersonId>,
}

/// Where a page of enrollments continues: the last row's id.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EnrollmentQuery {
    pub status: Option<EnrollmentStatus>,
    pub limit: u32,
    /// Ids after this one (`id` ascending).
    pub after: Option<EnrollmentId>,
}

/// A page of enrollments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnrollmentPage {
    pub items: Vec<EnrollmentRow>,
    pub next: Option<EnrollmentId>,
}

/// One outreach email (`outreach_sends`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendRow {
    pub id: SendId,
    pub enrollment_id: EnrollmentId,
    pub campaign_id: CampaignId,
    pub mailbox_id: CapabilityId,
    /// `1..=6`.
    pub step: u8,
    pub outbox_id: Uuid,
    pub message_id: MessageId,
    /// The recipient address's domain, lowercased (domain pacing).
    pub recipient_domain: String,
    pub outcome: SendOutcome,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub sent_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub replied_at: Option<OffsetDateTime>,
    /// Whether the reply named this send's Message-ID; set with `replied_at`.
    pub replied_threaded: Option<bool>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub first_clicked_at: Option<OffsetDateTime>,
    pub clicks: u32,
    pub automated_clicks: u32,
    #[serde(with = "time::serde::rfc3339::option")]
    pub unsubscribed_at: Option<OffsetDateTime>,
}

/// One campaign step's sends in a time range, as [`OutreachSendRepo::report`] counts them; the
/// reports group these further (by campaign or template).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct StepCounts {
    pub campaign_id: CampaignId,
    pub step: u8,
    /// Every send row, refused ones included.
    pub sends: u32,
    pub sent: u32,
    pub failed: u32,
    pub unknown: u32,
    pub refused: u32,
    pub bounced: u32,
    pub complained: u32,
    pub replied: u32,
    pub replied_threaded: u32,
    pub unsubscribed: u32,
    /// Sends with at least one counted click.
    pub clicked: u32,
    pub clicks: u32,
    pub automated_clicks: u32,
}

/// Which sends [`OutreachSendRepo::report`] counts: created in `[from, to)`, of one campaign or
/// all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReportQuery {
    pub campaign_id: Option<CampaignId>,
    pub from: OffsetDateTime,
    pub to: OffsetDateTime,
}

/// The workspace's templates.
#[async_trait]
pub trait TemplateRepo: Send + Sync {
    /// Writes a new template; an id already taken is `CONFLICT`.
    async fn insert(&mut self, row: &TemplateRow) -> Result<(), AppError>;
    async fn get(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError>;
    /// Reads the template and holds it until the bundle ends.
    async fn lock(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError>;
    /// Writes the template whole (its revision included, `created_by` kept) when the stored
    /// revision is `expected_revision`; whether it wrote.
    async fn update(&mut self, row: &TemplateRow, expected_revision: u32)
    -> Result<bool, AppError>;
    async fn list(&mut self, q: &TemplateQuery) -> Result<TemplatePage, AppError>;
}

/// The workspace's campaigns.
#[async_trait]
pub trait CampaignRepo: Send + Sync {
    /// Writes a new campaign; an id already taken is `CONFLICT`, a mailbox or strategy version
    /// of no capability or version of the workspace `NOT_FOUND`.
    async fn insert(&mut self, row: &CampaignRow) -> Result<(), AppError>;
    async fn get(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError>;
    /// Reads the campaign and holds it until the bundle ends.
    async fn lock(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError>;
    /// Writes the campaign whole (`created_*` kept) when the stored revision is
    /// `expected_revision`; whether it wrote. A save gives `row.revision` the next revision; a
    /// state change keeps it.
    async fn update(&mut self, row: &CampaignRow, expected_revision: u32)
    -> Result<bool, AppError>;
    async fn list(&mut self, q: &CampaignQuery) -> Result<CampaignPage, AppError>;
    /// The campaigns in `status`, oldest launch first (then oldest created), at most `limit`.
    async fn by_status(
        &mut self,
        status: CampaignStatus,
        limit: u32,
    ) -> Result<Vec<CampaignRow>, AppError>;
}

/// The enrollments.
#[async_trait]
pub trait EnrollmentRepo: Send + Sync {
    /// Writes the rows (at most [`MAX_ENROLLMENT_BATCH`]) as [`InsertReport`] says, in order: an
    /// active row whose person is active elsewhere is written skipped (`active_elsewhere`), a
    /// row whose person is in the campaign already is not written.
    async fn insert_many(&mut self, rows: &[EnrollmentRow]) -> Result<InsertReport, AppError>;
    async fn get(&mut self, id: EnrollmentId) -> Result<Option<EnrollmentRow>, AppError>;
    /// The campaign's active enrollments due at `now` or before, by `(next_send_at, id)`, at
    /// most `limit`, held until the bundle ends; rows another bundle holds are skipped (`for
    /// update skip locked`), so two dispatchers never pick one row.
    async fn due(
        &mut self,
        campaign: CampaignId,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<EnrollmentRow>, AppError>;
    /// After a send at `sent_at`: the next step and its time, or (`next_send_at` none) the
    /// enrollment completed. Only an active enrollment moves; whether it did.
    async fn advance(
        &mut self,
        id: EnrollmentId,
        next_step: u8,
        next_send_at: Option<OffsetDateTime>,
        sent_at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Moves an active enrollment's next send to `until`; whether it did.
    async fn postpone(&mut self, id: EnrollmentId, until: OffsetDateTime)
    -> Result<bool, AppError>;
    /// Stops an active enrollment; whether it did.
    async fn stop(
        &mut self,
        id: EnrollmentId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Stops every active enrollment of the person; how many.
    async fn stop_all_for(
        &mut self,
        person: PersonId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// Stops every active enrollment of the campaign; how many.
    async fn stop_campaign(
        &mut self,
        campaign: CampaignId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// The person's active enrollment.
    async fn active_for(&mut self, person: PersonId) -> Result<Option<EnrollmentRow>, AppError>;
    /// Every enrollment of the person, in any campaign and state, by id.
    async fn for_person(&mut self, person: PersonId) -> Result<Vec<EnrollmentRow>, AppError>;
    /// Replaces the enrollment's personalization; whether the enrollment exists.
    async fn personalize(
        &mut self,
        id: EnrollmentId,
        values: &BTreeMap<String, String>,
    ) -> Result<bool, AppError>;
    async fn list(
        &mut self,
        campaign: CampaignId,
        q: &EnrollmentQuery,
    ) -> Result<EnrollmentPage, AppError>;
    async fn count_active(&mut self, campaign: CampaignId) -> Result<u32, AppError>;
}

/// The outreach emails.
#[async_trait]
pub trait OutreachSendRepo: Send + Sync {
    /// Writes a new send; an id or outbox entry already taken is `CONFLICT`, an enrollment,
    /// campaign or message of no row of the workspace `NOT_FOUND`.
    async fn insert(&mut self, row: &SendRow) -> Result<(), AppError>;
    async fn get(&mut self, id: SendId) -> Result<Option<SendRow>, AppError>;
    async fn by_outbox(&mut self, outbox: Uuid) -> Result<Option<SendRow>, AppError>;
    /// Moves the outcome when [`SendOutcome::can_become`] allows (a `sent` one records `at` as
    /// its send time); whether it moved.
    async fn set_outcome(
        &mut self,
        id: SendId,
        outcome: SendOutcome,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Records the person's reply once; whether it did.
    async fn mark_replied(
        &mut self,
        id: SendId,
        threaded: bool,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// The person's newest send (not refused) created at `since` or later.
    async fn latest_for_person(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Option<SendRow>, AppError>;
    /// Counts a click (an automated one apart); the first counted one records its time.
    async fn click(
        &mut self,
        id: SendId,
        automated: bool,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Records the unsubscribe once; whether it did.
    async fn unsubscribed(&mut self, id: SendId, at: OffsetDateTime) -> Result<bool, AppError>;
    /// The mailbox's sends (not refused) created at `since` or later.
    async fn count_mailbox_since(
        &mut self,
        mailbox: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// The campaign's sends (not refused) created at `since` or later.
    async fn count_campaign_since(
        &mut self,
        campaign: CampaignId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// The mailbox's sends (not refused) to `domain` created at `since` or later.
    async fn count_domain_since(
        &mut self,
        mailbox: CapabilityId,
        domain: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError>;
    /// When the person's sends (not refused, any campaign) created at `since` or later were
    /// made, oldest first.
    async fn person_send_times(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Vec<OffsetDateTime>, AppError>;
    /// The local days (in time zone `tz`, an IANA name) on which the mailbox's sends (not
    /// refused) created at `since` or later were made, each once, oldest first: the warm-up's
    /// sending days.
    async fn mailbox_send_days(
        &mut self,
        mailbox: CapabilityId,
        tz: &str,
        since: OffsetDateTime,
    ) -> Result<Vec<time::Date>, AppError>;
    /// The campaign's newest `n` outcomes, newest first.
    async fn recent_outcomes(
        &mut self,
        campaign: CampaignId,
        n: u32,
    ) -> Result<Vec<SendOutcome>, AppError>;
    /// The sends of `q`, counted per campaign and step, by campaign id then step.
    async fn report(&mut self, q: &ReportQuery) -> Result<Vec<StepCounts>, AppError>;
}
