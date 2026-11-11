//! What is pending for the workspace, and the agent's check-in (spec B11): `work.pending`,
//! `work.checkin` and `work.set_checkin_interval`.
//!
//! **Pending work** is the agent's entry point: the strategy's state, the items to act on (most
//! urgent first) and whether the agent is overdue. It is exempt from the strategy gate, and from
//! the workspace-status check while the workspace awaits payment (not while it is suspended),
//! since an agent asks it before any strategy exists. The items:
//!
//! - `ConsultStrategy` (priority 1): no strategy at all, or a draft open (not submitted);
//! - `ApproveStrategy` (1): a submitted draft, for a caller who may approve it (the role owner or
//!   manager, and `team.manage`, as `strategy.approve` asks);
//! - `ReconnectConnector` (1): each capability reached through a connector that reads
//!   `unreachable` because its provider no longer accepts its login (a probe failed with `Auth`:
//!   `connector_public.reconnect_required`);
//! - `VerifyCapability` (2): each capability reached through an agent or a device that reads
//!   `declared` or `stale` (a lapsed verification is asked for again), but one of a kind verified
//!   by its heartbeat (a voice bridge, a phone);
//! - `VoiceBridgeOffline` (2): each voice bridge that reads `declared`, `stale` or `unreachable`:
//!   only its own registration verifies it, so no evidence is asked for;
//! - `PhoneOffline` (2): each phone that reads `declared`, `stale` or `unreachable`: only its
//!   device bridge's registration verifies it, so no evidence is asked for either. Each kind
//!   verified by its heartbeat has its own item ([`offline_item`]), so a phone is never reported
//!   as a voice bridge;
//! - `ConnectConnector` (2): each capability reached through a connector that reads `declared`
//!   (M1b sets connectors up);
//! - `InboundEvents` (2): inbound events (webhooks, polls) not yet acknowledged, with how many
//!   (counted up to [`INBOUND_EVENTS_COUNT_CAP`]: a count of the cap means at least that many),
//!   only for a caller who may acknowledge them ([`events::ACK_PERMISSION`]): anyone else would
//!   see an item they could never clear;
//! - `StudioShootRequest` (3): each open request of the çekim listesi, for a caller with
//!   `materials.work`, with or without an approved strategy (the materials library needs none);
//! - `StudioPostRequest` (2): each open package request (olay-driven publishing), for a
//!   caller with `social.work` while a strategy is approved;
//! - `StudioSlot` (1 when overdue, else 2): each Studio slot to prepare or send; a planned post
//!   only from its preparation start;
//! - `DeclareFirstCapability` (3): no capability that is not retired; with the items to verify
//!   and to connect a capability, only for a caller holding `capabilities.manage`;
//! - `ResearchDue` (3): each open research task that may still record prospects today, and
//!   `ProspectsToScore` (3): `new` prospects without a score under the current rubric, and
//!   `ProspectsToPromote` (3): qualified prospects not promoted yet, only for a
//!   caller holding `prospects.work` while the approved strategy has prospecting on (spec
//!   2026-10-30-leads-pool-outreach-design.md §3.17);
//! - `OwnerlessJourneys` (2): every open journey without an owner, whatever the cause (nobody
//!   eligible, the manual mode, a v1 import, a manager's unassignment), with the longest-open
//!   one, and `AssignmentStalled` (2): assignments past their SLA after the last reassignment,
//!   only for a caller holding `inbox.manage` (spec §3.9: no journey is silently ownerless);
//! - `PersonalizationDue` (2): a campaign's enrollments due within a day whose next step misses
//!   a `custom.*` value, `CampaignBlocked` (2): a campaign paused for its bounces, complaints,
//!   mailbox or strategy, `CampaignApproval` (2): a campaign waiting for approval (a person with
//!   `outreach.manage` only), and `PromotedNotContacted` (3): promoted prospects nobody wrote to
//!   in two days, for a caller holding `outreach.work` (leads spec §3.17, D69;
//!   `usecases::outreach::work`).
//!
//! Only the items the workspace's status lets be acted on are listed: each item is cleared by a
//! use case ([`WorkKind::cleared_by`]), and an item whose use case the workspace-status check
//! would refuse (`WORKSPACE_INACTIVE`) is left out. So while the workspace awaits payment only
//! the strategy's items are listed (`strategy.*` runs then; capabilities, connections and events
//! wait for the payment, though webhooks keep storing events meanwhile, which are listed once it
//! is active).
//!
//! Each item carries a hint in English, for the agent; the panel shows its own copy.
//!
//! **Check-in.** Waking the agent is the tenant's job, never the system's (spec §4.2 rule 3): the
//! agent calls `jeeta.work.checkin` on its own schedule, at least once per check-in interval
//! (`WorkspacePolicy::agent_checkin_interval_minutes`, a day unless set), and the system only
//! warns when it is late ([`agents::overdue`]). Every call an agent makes already moves its
//! connection's `last_seen_at` (the MCP gate counts it); the check-in itself is ledgered at most
//! once an hour per connection, so a tight loop does not flood the ledger. A check-in answers with
//! the caller seen at its own time, so an agent that was late is not told it is overdue by the
//! very call that ends its lateness.

use jt_capability::{Capability, CapabilityId, EffectiveStatus, Reach};
use jt_ledger::Actor;
use jt_strategy::{Gap, StrategyVersionId};
use jt_tenancy::{AgentConnectionId, Permission};
use serde::Serialize;
use serde_json::json;
use time::{Duration, OffsetDateTime};

use super::calls::bridge::VOICE_BRIDGE_KIND;
use super::capabilities::CapabilityOut;
use super::devices::PHONE_KIND;
use super::strategy::{self, StrategyOut};
use super::{Deps, agents, connector, events, invalid, ledger_entry};
use crate::catalog::status_exemption;
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{
    CHECKIN_ACTION, CapabilityFilter, MAX_AGENT_CHECKIN_INTERVAL_MINUTES,
    MIN_AGENT_CHECKIN_INTERVAL_MINUTES, TenantRepos, WorkspacePolicy,
};

/// How long after a connection's ledgered check-in the next one is answered without a ledger
/// entry.
pub const CHECKIN_LEDGER_RESOLUTION: Duration = Duration::hours(1);

/// The most unprocessed inbound events `InboundEvents` counts; past it the count reads as the cap
/// ("at least this many"), so asking what is pending never counts a whole backlog.
pub const INBOUND_EVENTS_COUNT_CAP: u32 = 1_000;

/// How soon an owed item's deadline makes it an `AnswerDeadline` item.
pub const ANSWER_DEADLINE_WINDOW: Duration = Duration::hours(24);

const CHECKIN: &str = CHECKIN_ACTION;

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

/// What is pending for the workspace, as the caller sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingOut {
    pub strategy: StrategyState,
    /// Most urgent first (priority 1 first), in a stable order within a priority.
    pub items: Vec<WorkItem>,
    pub agent: AgentState,
}

/// Where the workspace's strategy stands. An open or submitted draft is what is pending, so it
/// is shown even while an approved version is in force.
///
/// On the wire, a state without fields is its name (`"missing"`) and one with fields an object
/// under its name (`{"draft_open": {"gaps": [...]}}`,
/// `{"submitted": {"version_id": "…", "submitted_at": "…"}}`, `{"approved": {"number": 2}}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyState {
    /// No version approved and no draft.
    Missing,
    /// A draft is being worked out; `gaps` is everything that stops it from being approved today.
    DraftOpen { gaps: Vec<Gap> },
    /// A draft awaits approval: the draft and when it was submitted, which approving it sends
    /// back (`strategy.approve` refuses a draft that changed since).
    Submitted {
        version_id: StrategyVersionId,
        #[serde(with = "time::serde::rfc3339")]
        submitted_at: OffsetDateTime,
    },
    /// Version `number` is in force and no draft is open.
    Approved { number: i32 },
}

/// One thing to do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkItem {
    /// What to do; on the wire its name is `kind`, beside its fields.
    #[serde(flatten)]
    pub kind: WorkKind,
    /// 1 is the most urgent.
    pub priority: u8,
    /// What to do about it, in English, for the agent.
    pub hint: String,
}

/// The kinds of pending work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkKind {
    StudioSlot {
        slot_id: jt_studio::SlotId,
        overdue: bool,
    },
    StudioApproval {
        target: crate::ports::studio::ApprovalTarget,
    },
    StudioBudgetMove {
        budget_move_id: jt_studio::BudgetMoveId,
    },
    /// An open request of the çekim listesi: a material Studio needs and has not got (spec
    /// 2026-11-03 §4.6). Listed with or without an approved strategy, as the library is.
    StudioShootRequest {
        shoot_request_id: jt_studio::ShootRequestId,
    },
    /// An external agent may claim a pending material analysis, or reclaim its expired lease.
    /// Listed without an approved strategy; live leases and terminal results are not work.
    StudioMaterialAnalysis {
        material_id: jt_studio::MaterialId,
        expected_revision: u64,
    },
    /// A human-requested derivative for an external agent to produce with its own tools.
    /// A production project needs missing materials or canonical output planning.
    ContentArea {
        project_id: uuid::Uuid,
        expected_revision: u64,
        redo_note: Option<String>,
    },
    ContentMaterialRequest {
        project_id: uuid::Uuid,
        request_id: uuid::Uuid,
    },
    ContentAreaHeld {
        project_id: uuid::Uuid,
    },
    /// A platform version of a finished content package has no time yet (design 2026-11-10
    /// §7.2): the social module's agent gives it one.
    SocialSchedule {
        project_id: uuid::Uuid,
        version_id: uuid::Uuid,
    },
    /// An ad campaign waits for its plan, or the provider turned one of its ads down (design
    /// 2026-11-10 §8): the ads module's agent claims it.
    AdsCampaignPlan {
        campaign_id: uuid::Uuid,
        expected_revision: u64,
        /// What the provider said of the ad it turned down, for a rejected campaign.
        rejected: Option<String>,
    },
    /// A running ad campaign nobody looked at today: the agent reads it and makes a move.
    AdsCampaignReview {
        campaign_id: uuid::Uuid,
    },
    /// An agent proposed an ad campaign: a person approves or declines it.
    AdsCampaignProposal {
        campaign_id: uuid::Uuid,
    },
    /// An ad campaign waits for a person: its plan was refused three times, or the provider
    /// refused its build.
    AdsCampaignHeld {
        campaign_id: uuid::Uuid,
    },
    StudioMaterialProduction {
        production_id: uuid::Uuid,
        expected_revision: u64,
    },
    /// An open package request (spec 2026-11-03 D23): plan posts from its materials. Listed
    /// with an approved strategy only, as `studio.posts_propose` needs one.
    StudioPostRequest {
        post_request_id: jt_studio::PackageRequestId,
    },
    /// A visible conversation needs a reply.
    ReplyDue {
        conversation_id: jt_inbox::ConversationId,
    },
    /// A lost journey needs a human reopening decision.
    ReopenQuestion {
        conversation_id: jt_inbox::ConversationId,
    },
    /// A visible contact has a merge suggestion.
    MergeSuggested {
        merge_id: jt_inbox::MergeId,
    },
    /// An owed comment or question of a visible conversation is due within
    /// [`ANSWER_DEADLINE_WINDOW`] (spec §3.11): the soonest first.
    AnswerDeadline {
        conversation_id: jt_inbox::ConversationId,
        item_id: Option<jt_inbox::PublicItemId>,
        #[serde(with = "time::serde::rfc3339")]
        deadline: OffsetDateTime,
    },
    /// A held reply waits for a human's approval (human callers only).
    ApproveReply {
        outbox_id: uuid::Uuid,
        conversation_id: jt_inbox::ConversationId,
        #[serde(with = "time::serde::rfc3339::option")]
        deadline: Option<OffsetDateTime>,
    },
    /// The platform takes comments, but this Meta capability's grant lacks the comment
    /// permissions: reconnect it.
    EnableComments {
        capability_id: CapabilityId,
        name: String,
    },
    /// An open task has reached its due time.
    TaskDue {
        task_id: jt_inbox::TaskId,
    },
    /// Start the consultation, or continue the open draft's.
    ConsultStrategy,
    /// Approve the submitted draft.
    ApproveStrategy,
    /// Verify an agent or device capability, for the first time or again (`stale`).
    VerifyCapability {
        capability_id: CapabilityId,
        name: String,
        stale: bool,
    },
    /// Declare something the workspace can act through.
    DeclareFirstCapability,
    /// Connect a declared connector capability (M1b sets connectors up).
    ConnectConnector {
        capability_id: CapabilityId,
        name: String,
    },
    /// Reconnect a connector capability whose credentials its provider no longer accepts.
    ReconnectConnector {
        capability_id: CapabilityId,
        name: String,
    },
    /// Read and acknowledge the inbound events not yet processed: `count` of them, counted up to
    /// [`INBOUND_EVENTS_COUNT_CAP`].
    InboundEvents {
        count: u32,
    },
    /// A voice bridge has not registered within its heartbeat, or never has: agent calls through
    /// it are refused until it does. `last_seen_at` is its last heartbeat.
    VoiceBridgeOffline {
        capability_id: CapabilityId,
        name: String,
        #[serde(with = "time::serde::rfc3339::option")]
        last_seen_at: Option<OffsetDateTime>,
    },
    /// A phone its device bridge has not listed within its heartbeat, or never has: commands for
    /// it are refused (`device_offline`) until a bridge lists it again. `last_seen_at` is the last
    /// registration that listed it.
    PhoneOffline {
        capability_id: CapabilityId,
        name: String,
        #[serde(with = "time::serde::rfc3339::option")]
        last_seen_at: Option<OffsetDateTime>,
    },
    /// An open research task may still record `remaining_today` prospects today.
    ResearchDue {
        task_id: jt_prospects::ResearchTaskId,
        remaining_today: u32,
    },
    /// `count` new prospects have no score under the approved rubric.
    ProspectsToScore {
        count: u32,
    },
    /// `count` qualified prospects wait for promotion into the inbox.
    ProspectsToPromote {
        count: u32,
    },
    /// `count` open journeys have no owner; `oldest_journey_id` has waited longest.
    OwnerlessJourneys {
        count: u32,
        oldest_journey_id: Option<jt_inbox::JourneyId>,
    },
    /// `count` assignments passed their SLA after the last reassignment.
    AssignmentStalled {
        count: u32,
    },
    /// `count` active enrollments of a campaign are due within a day and miss a `custom.*` value
    /// their next step needs.
    PersonalizationDue {
        campaign_id: jt_outreach::CampaignId,
        count: u32,
    },
    /// A campaign was paused for `reason` (its bounces, its complaints, its mailbox, the
    /// strategy), not by hand.
    CampaignBlocked {
        campaign_id: jt_outreach::CampaignId,
        reason: jt_outreach::PauseReason,
    },
    /// A campaign's `revision` waits for a person's approval.
    CampaignApproval {
        campaign_id: jt_outreach::CampaignId,
        revision: u32,
    },
    /// `count` prospects promoted two to thirty days ago were not written to since.
    PromotedNotContacted {
        count: u32,
    },
}

impl WorkKind {
    /// The use case that clears the item (the first step of it, for a consultation or a
    /// connection): an item is listed only while the workspace's status lets it run.
    pub fn cleared_by(&self) -> &'static str {
        match self {
            WorkKind::StudioSlot { .. } => "studio.slot_get",
            WorkKind::StudioApproval { .. } => "studio.approve",
            WorkKind::StudioBudgetMove { .. } => "studio.pending",
            WorkKind::StudioShootRequest { .. } => "studio.shoot_list",
            WorkKind::StudioMaterialAnalysis { .. } => "studio.material_analysis_claim",
            WorkKind::ContentArea { .. } => "content.area_claim",
            WorkKind::ContentMaterialRequest { .. } => "studio.project_request_update",
            WorkKind::ContentAreaHeld { .. } => "content.area_redo",
            WorkKind::SocialSchedule { .. } => "social.version_schedule",
            WorkKind::AdsCampaignPlan { .. } => "ads.campaign_claim",
            WorkKind::AdsCampaignReview { .. } => "ads.campaign_move",
            WorkKind::AdsCampaignProposal { .. } => "ads.campaign_approve",
            WorkKind::AdsCampaignHeld { .. } => "ads.campaign_end",
            WorkKind::StudioMaterialProduction { .. } => "studio.material_production_claim",
            WorkKind::StudioPostRequest { .. } => "studio.posts_propose",
            WorkKind::ReplyDue { .. } => "inbox.reply",
            WorkKind::ReopenQuestion { .. } => "inbox.events.report",
            WorkKind::MergeSuggested { .. } => "inbox.merges.apply",
            WorkKind::AnswerDeadline { .. } => "inbox.reply",
            WorkKind::ApproveReply { .. } => "inbox.public.approve",
            WorkKind::EnableComments { .. } => "connector.reconnect",
            WorkKind::TaskDue { .. } => "inbox.tasks.complete",
            WorkKind::ConsultStrategy => "strategy.start_consultation",
            WorkKind::ApproveStrategy => "strategy.approve",
            WorkKind::VerifyCapability { .. } => "capability.verify",
            WorkKind::DeclareFirstCapability => "capability.declare",
            WorkKind::ConnectConnector { .. } => "connector.start_oauth",
            WorkKind::ReconnectConnector { .. } => "connector.reconnect",
            WorkKind::InboundEvents { .. } => "events.ack",
            WorkKind::VoiceBridgeOffline { .. } => "calls.bridge.register",
            WorkKind::PhoneOffline { .. } => "devices.bridge.register",
            WorkKind::ResearchDue { .. } => "prospects.create",
            WorkKind::ProspectsToScore { .. } => "prospects.score",
            WorkKind::ProspectsToPromote { .. } => "prospects.promote",
            WorkKind::OwnerlessJourneys { .. } | WorkKind::AssignmentStalled { .. } => {
                "inbox.journeys.assign_owner"
            }
            WorkKind::PersonalizationDue { .. } => "outreach.personalize",
            WorkKind::CampaignBlocked { .. } => "outreach.campaigns_control",
            WorkKind::CampaignApproval { .. } => "outreach.campaigns_approve",
            WorkKind::PromotedNotContacted { .. } => "outreach.enroll",
        }
    }
}

/// The workspace's agent check-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AgentState {
    /// The latest sight of any of the workspace's agent connections; `None` when none has ever
    /// connected.
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_seen_at: Option<OffsetDateTime>,
    /// How often an agent is expected to check in.
    pub interval_minutes: u32,
    /// No agent connected, or none within the interval (see [`agents::overdue`]).
    pub overdue: bool,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// What is pending for the workspace at `ctx.now`, as the caller sees it (only a caller who may
/// approve the strategy is asked to). Needs `workspace.read`.
pub async fn pending(deps: &Deps, ctx: &Ctx) -> Result<PendingOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    pending_as_seen(deps, ctx, None).await
}

/// [`pending`], with `seen_now` (the time a checking-in caller is seen at, if any) counted among
/// the connections' sightings. Opens its bundles one after another, never two at once.
async fn pending_as_seen(
    deps: &Deps,
    ctx: &Ctx,
    seen_now: Option<OffsetDateTime>,
) -> Result<PendingOut, AppError> {
    let strategy = strategy::get(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let capabilities: Vec<CapabilityOut> = repos
        .capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .map(|c| CapabilityOut::at(c, ctx.now))
        .collect();
    let agent = agent_state(repos.as_mut(), ctx.now, seen_now).await?;
    let status = repos.workspace().get().await?.status;
    let actionable = |kind: &WorkKind| status_exemption(kind.cleared_by()).allows(status);
    // Only who may acknowledge the events is asked to handle them, and only while they can be.
    let inbound = if ctx.permissions.contains(&events::ACK_PERMISSION)
        && actionable(&WorkKind::InboundEvents { count: 0 })
    {
        repos
            .inbound_events()
            .count_pending(INBOUND_EVENTS_COUNT_CAP)
            .await?
    } else {
        0
    };
    let inbox = if ctx.permissions.contains(&Permission::InboxWork)
        && status_exemption("inbox.pending").allows(status)
    {
        Some(super::inbox::context::pending_in(repos.as_mut(), ctx).await?)
    } else {
        None
    };
    let studio = if [
        Permission::SocialWork,
        Permission::SocialManage,
        Permission::AdsWork,
        Permission::AdsManage,
    ]
    .iter()
    .any(|p| ctx.permissions.contains(p))
        && status_exemption("studio.pending").allows(status)
        && strategy.approved.is_some()
    {
        Some(super::studio::work::pending_in(repos.as_mut(), ctx).await?)
    } else {
        None
    };
    // The pool's work, for who works it, while the approved strategy has prospecting on.
    let pool = if ctx.permissions.contains(&Permission::ProspectsWork)
        && status_exemption("prospects.create").allows(status)
    {
        match repos.strategy().current_approved().await? {
            Some(v) => Some(super::prospects::playbook::pending_in(repos.as_mut(), ctx, &v).await?),
            None => None,
        }
    } else {
        None
    };
    // Ownerless and stalled journeys, for who may assign them.
    let distribution = if ctx.permissions.contains(&Permission::InboxManage)
        && status_exemption("inbox.journeys.assign_owner").allows(status)
    {
        let max = repos
            .workspace_policy()
            .read()
            .await?
            .leads
            .distribution
            .max_reassignments;
        Some((
            repos.assignments().count_ownerless().await?,
            repos
                .assignments()
                .count_stalled(ctx.now, u32::from(max))
                .await?,
        ))
    } else {
        None
    };
    // Outreach's work, for who works it.
    let outreach = if ctx.permissions.contains(&Permission::OutreachWork)
        && status_exemption("outreach.enroll").allows(status)
    {
        Some(super::outreach::work::pending_in(repos.as_mut(), ctx).await?)
    } else {
        None
    };
    let shoots: Vec<jt_studio::ShootRequest> =
        if ctx.permissions.contains(&Permission::MaterialsWork)
            && status_exemption("studio.shoot_list").allows(status)
        {
            repos
                .studio_materials()
                .list_shoot_requests()
                .await?
                .into_iter()
                .filter(|q| q.status == jt_studio::ShootStatus::Open)
                .collect()
        } else {
            Vec::new()
        };
    // Analysis has no server worker: only an external agent with materials.work can clear it.
    // A live lease belongs to its claimant; expired leases become visible again at check-in.
    let mut analyses = Vec::new();
    if ctx.permissions.contains(&Permission::MaterialsWork)
        && status_exemption("studio.material_analysis_claim").allows(status)
    {
        let records: std::collections::BTreeMap<_, _> = repos
            .studio_materials()
            .list_intelligence()
            .await?
            .into_iter()
            .map(|row| (row.material_id, row))
            .collect();
        for material in repos.studio_materials().list_materials().await? {
            if material.erased_at.is_none()
                && records
                    .get(&material.id)
                    .is_none_or(|row| row.claimable(ctx.now))
            {
                analyses.push(WorkItem {
                    kind: WorkKind::StudioMaterialAnalysis { material_id: material.id, expected_revision: material.revision },
                    priority: 2,
                    hint: "Claim this material with jeeta.studio.material_analysis_claim at expected_revision and inspect the actual short-lived preview with your own tools. Read jeeta.strategy.get and jeeta.studio.material_intelligence_list to reuse existing groups and labels. Never infer capture or event dates from upload time; leave uncertain facts unknown. Complete or fail with your claim_token; never infer share permission or overwrite manual edits. Nothing wakes you: poll jeeta.work.checkin on your own schedule.".into(),
                });
            }
        }
    }
    let mut productions = Vec::new();
    if ctx.permissions.contains(&Permission::ContentWork)
        && status_exemption("studio.material_production_claim").allows(status)
    {
        for row in repos.studio_productions().list_productions().await? {
            if row.claimable(ctx.now) {
                productions.push(WorkItem {
                    kind: WorkKind::StudioMaterialProduction { production_id: row.production.id, expected_revision: row.production.revision },
                    priority: 2,
                    hint: "Read jeeta.studio.material_production_list, claim this request at expected_revision, and inspect each source with jeeta.studio.material_preview. Use your own image/video tools; upload a new distinct file and add it as ai_generated material, then complete with your claim_token and output_material_id, or fail with a bounded error_code. Sources' people and privacy restrictions remain attached; a human must approve output share permission. This server does not generate media or wake you: poll jeeta.work.checkin.".into(),
                });
            }
        }
    }
    // Production areas (design 2026-11-10 §6): the agent's is an area whose start time has come;
    // a person's are the captures an agent asked for and the areas an agent could not finish.
    let mut projects = Vec::new();
    if ctx.permissions.contains(&Permission::ContentWork)
        || ctx.permissions.contains(&Permission::ContentManage)
    {
        use crate::ports::production_projects::{AreaState, RequestStatus};
        let agent = ctx.agent_connection_id.is_some();
        let person = super::studio::library::person(ctx).is_some();
        let work = ctx.permissions.contains(&Permission::ContentWork);
        let manage = ctx.permissions.contains(&Permission::ContentManage);
        for p in repos.studio_projects().list_areas(false, None).await? {
            if agent && work && p.needs_agent(ctx.now) {
                projects.push(WorkItem {
                    kind: WorkKind::ContentArea {
                        project_id: p.id,
                        expected_revision: p.revision,
                        redo_note: p.redo.as_ref().map(|r| r.note.clone()),
                    },
                    priority: 3,
                    hint: CONTENT_AREA_HINT.into(),
                });
            }
            if person && work {
                for q in p
                    .requests
                    .iter()
                    .filter(|q| q.status == RequestStatus::Open)
                {
                    projects.push(WorkItem {
                        kind: WorkKind::ContentMaterialRequest {
                            project_id: p.id,
                            request_id: q.id,
                        },
                        priority: 2,
                        hint: "An agent asked for a real photo or video for this production \
                               area. Upload it to the library, give its share permission, and \
                               answer the request with it (jeeta.studio.project_request_update, \
                               status done and the material's id): the area goes back to the \
                               agent by itself."
                            .into(),
                    });
                }
            }
            if person && manage && p.state(ctx.now) == AreaState::Held {
                projects.push(WorkItem {
                    kind: WorkKind::ContentAreaHeld { project_id: p.id },
                    priority: 1,
                    hint: "The agent's delivery was refused three times in a row and the area \
                           is held. Open it in the content module, and send it back with a note \
                           saying what to change, or archive it."
                        .into(),
                });
            }
        }
    }
    // Finished versions that wait for a time, for the agent that plans posts. One with no
    // account that could take it is not work: nothing the agent does would clear it.
    let mut waiting = Vec::new();
    if ctx.agent_connection_id.is_some()
        && ctx.permissions.contains(&Permission::SocialWork)
        && status_exemption("social.version_schedule").allows(status)
        && strategy.approved.is_some()
    {
        for package in super::social::schedule::waiting(deps, repos.as_mut(), ctx.now).await? {
            for v in package.versions.iter().filter(|v| !v.accounts.is_empty()) {
                waiting.push(WorkItem {
                    kind: WorkKind::SocialSchedule {
                        project_id: package.project_id,
                        version_id: v.version_id,
                    },
                    priority: 2,
                    hint: SOCIAL_SCHEDULE_HINT.into(),
                });
            }
        }
    }
    // Ad campaigns: a plan or a daily look for the agent, a proposal or a held campaign for
    // the person who manages advertising.
    let mut campaigns = Vec::new();
    let ads_agent =
        ctx.agent_connection_id.is_some() && ctx.permissions.contains(&Permission::AdsWork);
    let ads_person = ctx.agent_connection_id.is_none()
        && matches!(ctx.actor, Actor::Human { .. })
        && ctx.permissions.contains(&Permission::AdsManage);
    if ads_agent || ads_person {
        use crate::ports::ads::{CampaignScope, CampaignState};
        for c in repos
            .ads()
            .list_campaigns(CampaignScope::Open, None)
            .await?
        {
            let id = c.id;
            match c.state_at(ctx.now) {
                state @ (CampaignState::Queued | CampaignState::Rejected)
                    if ads_agent && c.needs_agent(ctx.now) && strategy.approved.is_some() =>
                {
                    let rejected = (state == CampaignState::Rejected)
                        .then(|| c.clone().present(ctx.now).state.and_then(|s| s.note))
                        .flatten();
                    campaigns.push(WorkItem {
                        kind: WorkKind::AdsCampaignPlan {
                            campaign_id: id,
                            expected_revision: c.revision,
                            rejected,
                        },
                        priority: 2,
                        hint: ADS_PLAN_HINT.into(),
                    });
                }
                CampaignState::Live if ads_agent && strategy.approved.is_some() => {
                    let looked = c
                        .moves
                        .last()
                        .is_some_and(|m| ctx.now - m.at < time::Duration::hours(24));
                    if !looked {
                        campaigns.push(WorkItem {
                            kind: WorkKind::AdsCampaignReview { campaign_id: id },
                            priority: 3,
                            hint: ADS_REVIEW_HINT.into(),
                        });
                    }
                }
                CampaignState::Proposed if ads_person => campaigns.push(WorkItem {
                    kind: WorkKind::AdsCampaignProposal { campaign_id: id },
                    priority: 2,
                    hint: "An agent proposed an ad campaign. Read why and what it would cost, \
                           then approve or decline it in the ads module; it closes by itself \
                           seven days after it was proposed."
                        .into(),
                }),
                CampaignState::Held if ads_person => campaigns.push(WorkItem {
                    kind: WorkKind::AdsCampaignHeld { campaign_id: id },
                    priority: 1,
                    hint: "An ad campaign waits for you: its plan was refused three times, or \
                           the ad platform refused its build. Open it in the ads module to see \
                           why; end it, or change what blocks it."
                        .into(),
                }),
                _ => {}
            }
        }
    }
    let mut offered = std::collections::BTreeMap::new();
    for module in ["content", "social", "ads", "materials"] {
        offered.insert(
            module,
            module_work_offered(repos.as_mut(), ctx, module).await?,
        );
    }
    drop(repos);

    let state = strategy_state(&strategy);
    let mut items = strategy_items(&state, may_approve(ctx));
    if let Some(p) = inbox {
        items.extend(p.ours.into_iter().map(|c| WorkItem {
            kind: WorkKind::ReplyDue {
                conversation_id: c.id,
            },
            priority: 2,
            hint: "Read jeeta.inbox.context and respond to the conversation.".into(),
        }));
        items.extend(p.reopen_questions.into_iter().map(|c| WorkItem {
            kind: WorkKind::ReopenQuestion {
                conversation_id: c.id,
            },
            priority: 2,
            hint: "Ask an owner or manager whether to reopen the lost journey.".into(),
        }));
        items.extend(p.merges.into_iter().map(|m| WorkItem {
            kind: WorkKind::MergeSuggested { merge_id: m.id },
            priority: 3,
            hint: "Ask an inbox manager to review the suggested merge.".into(),
        }));
        items.extend(p.tasks_due.into_iter().map(|t| WorkItem {
            kind: WorkKind::TaskDue { task_id: t.id },
            priority: 3,
            hint: "Complete the due journey task.".into(),
        }));
        // `public_due` is soonest deadline first.
        items.extend(p.public_due.into_iter().filter_map(|d| {
            let deadline = d
                .deadline
                .filter(|at| *at - ctx.now <= ANSWER_DEADLINE_WINDOW)?;
            Some(WorkItem {
                kind: WorkKind::AnswerDeadline {
                    conversation_id: d.conversation_id,
                    item_id: Some(d.item_id),
                    deadline,
                },
                priority: 1,
                hint: "Answer the item with jeeta.inbox.reply before its deadline; after it the \
                       platform takes no answer."
                    .into(),
            })
        }));
        items.extend(p.approvals.into_iter().map(|a| {
            WorkItem {
                priority: if a
                    .deadline
                    .is_some_and(|at| at - ctx.now <= ANSWER_DEADLINE_WINDOW)
                {
                    1
                } else {
                    2
                },
                kind: WorkKind::ApproveReply {
                    outbox_id: a.outbox_id,
                    conversation_id: a.conversation_id,
                    deadline: a.deadline,
                },
                hint:
                    "Read the held reply, then approve it (an edit is fenced again) or discard it."
                        .into(),
            }
        }));
    }
    items.extend(enable_comment_items(deps, &capabilities));
    if let Some(p) = studio {
        items.extend(
            p.slots
                .into_iter()
                .filter(|_| ctx.permissions.contains(&Permission::SocialWork))
                .map(|s| WorkItem {
                    kind: WorkKind::StudioSlot {
                        slot_id: s.slot.id,
                        overdue: s.overdue,
                    },
                    priority: if s.overdue { 1 } else { 2 },
                    hint: "Read jeeta.studio.slot_get and supply the scheduled content.".into(),
                }),
        );
        items.extend(
            p.post_requests
                .into_iter()
                .filter(|_| ctx.permissions.contains(&Permission::SocialWork))
                .map(|q| WorkItem {
                    kind: WorkKind::StudioPostRequest {
                        post_request_id: q.id,
                    },
                    priority: 2,
                    hint:
                        "Plan posts from the request's materials (jeeta.studio.post_requests) and \
                   answer it with jeeta.studio.posts_propose: each post's format, channel, \
                   time, materials, subject and hypothesis, within the caps."
                            .into(),
                }),
        );
        items.extend(
            p.approvals
                .into_iter()
                .filter(|target| match target {
                    crate::ports::studio::ApprovalTarget::Slot(_) => {
                        ctx.permissions.contains(&Permission::SocialManage)
                    }
                    crate::ports::studio::ApprovalTarget::BudgetMove(_) => {
                        ctx.permissions.contains(&Permission::AdsManage)
                            && ctx.permissions.contains(&Permission::AdsWork)
                    }
                })
                .map(|target| WorkItem {
                    kind: WorkKind::StudioApproval { target },
                    priority: 2,
                    hint: "An owner or manager human must grant revision-bound Studio consent."
                        .into(),
                }),
        );
        items.extend(p.budget_moves.into_iter().filter(|_| ctx.permissions.contains(&Permission::AdsWork)).map(|m| WorkItem {
            kind: WorkKind::StudioBudgetMove {
                budget_move_id: m.id,
            },
            priority: 2,
            hint: if p.blockers.iter().any(|b| {
                b.target == crate::ports::studio::ApprovalTarget::BudgetMove(m.id)
                    && b.reason == "binding_stale"
            }) {
                "Rebind the ad set to the current verified account, then create a new budget move."
                    .into()
            } else {
                "Review the queued Studio budget move and its blockers.".into()
            },
        }));
    }
    if let Some(p) = pool {
        items.extend(
            p.research_due
                .into_iter()
                .map(|(task_id, remaining_today)| WorkItem {
                    kind: WorkKind::ResearchDue {
                        task_id,
                        remaining_today,
                    },
                    priority: 3,
                    hint: "Read jeeta.prospects.playbook and the task (jeeta.research.tasks_get), \
                           claim it (jeeta.research.tasks_claim), research businesses with your \
                           own tools and record each with jeeta.prospects.create."
                        .into(),
                }),
        );
        if p.to_promote > 0 {
            items.push(WorkItem {
                kind: WorkKind::ProspectsToPromote {
                    count: p.to_promote,
                },
                priority: 3,
                hint: "Promote the qualified prospects (jeeta.prospects.list with status \
                       qualified) with jeeta.prospects.promote: each becomes an inbox person \
                       with an owner."
                    .into(),
            });
        }
        if p.to_score > 0 {
            items.push(WorkItem {
                kind: WorkKind::ProspectsToScore { count: p.to_score },
                priority: 3,
                hint: "Score the new prospects (jeeta.prospects.list with status new) with \
                       jeeta.prospects.score, sending the playbook's rubric_digest."
                    .into(),
            });
        }
    }
    if let Some((ownerless, stalled)) = distribution {
        if ownerless.count > 0 {
            items.push(WorkItem {
                kind: WorkKind::OwnerlessJourneys {
                    count: ownerless.count,
                    oldest_journey_id: ownerless.oldest_journey_id,
                },
                priority: 2,
                hint: "Open journeys have no owner: assign each with \
                       jeeta.inbox.journeys_assign_owner, or hand them out with \
                       jeeta.distribution.backfill (jeeta.distribution.get shows who is eligible)."
                    .into(),
            });
        }
        if stalled > 0 {
            items.push(WorkItem {
                kind: WorkKind::AssignmentStalled { count: stalled },
                priority: 2,
                hint: "Assignments passed their SLA after the last reassignment: find them with \
                       jeeta.distribution.assignments_list and give each an owner with \
                       jeeta.inbox.journeys_assign_owner."
                    .into(),
            });
        }
    }
    if let Some(p) = outreach {
        items.extend(p.approvals.into_iter().map(|(campaign_id, revision)| {
            WorkItem {
                kind: WorkKind::CampaignApproval {
                    campaign_id,
                    revision,
                },
                priority: 2,
                hint: "Read the campaign (jeeta.outreach.campaigns_get) and its audience \
                           (jeeta.outreach.audience_preview); a person with outreach.manage \
                           approves its revision with jeeta.outreach.campaigns_approve."
                    .into(),
            }
        }));
        items.extend(p.blocked.into_iter().map(|(campaign_id, reason)| {
            WorkItem {
                kind: WorkKind::CampaignBlocked {
                    campaign_id,
                    reason,
                },
                priority: 2,
                hint: "The campaign was paused for its bounces, complaints, mailbox or strategy: \
                       read jeeta.outreach.report and the campaign, fix the cause (the audience, \
                       the mailbox), then resume or cancel it with \
                       jeeta.outreach.campaigns_control."
                    .into(),
            }
        }));
        items.extend(
            p.personalization_due
                .into_iter()
                .map(|(campaign_id, count)| WorkItem {
                    kind: WorkKind::PersonalizationDue { campaign_id, count },
                    priority: 2,
                    hint: "Enrollments send within a day and miss custom values their step \
                           needs: read them with jeeta.outreach.enrollments_list (status \
                           active) and write the values with jeeta.outreach.personalize."
                        .into(),
                }),
        );
        if p.promoted_not_contacted > 0 {
            items.push(WorkItem {
                kind: WorkKind::PromotedNotContacted {
                    count: p.promoted_not_contacted,
                },
                priority: 3,
                hint: "Promoted prospects were not written to: enroll them in a campaign with \
                       jeeta.outreach.enroll (person_ids), or reach them from the inbox."
                    .into(),
            });
        }
    }
    items.extend(shoots.into_iter().map(|q| {
        WorkItem {
            kind: WorkKind::StudioShootRequest {
                shoot_request_id: q.id,
            },
            priority: 3,
            hint:
                "Studio needs this material (jeeta.studio.shoot_list). You cannot shoot it: tell \
               the owner, or add an AI supporting visual (jeeta.studio.material_add); a real \
               photo or video is the owner's."
                    .into(),
        }
    }));
    items.extend(analyses);
    items.extend(productions);
    items.extend(projects);
    items.extend(waiting);
    items.extend(campaigns);
    // Declaring, verifying and connecting a capability need `capabilities.manage`: as with
    // every item, one is listed only to a caller who can clear it, or an agent's check-in would
    // never come back empty.
    if ctx.permissions.contains(&Permission::CapabilitiesManage) {
        items.extend(capability_items(&capabilities));
    } else {
        items.extend(capability_items(&capabilities).into_iter().filter(|i| {
            !matches!(
                i.kind,
                WorkKind::DeclareFirstCapability
                    | WorkKind::VerifyCapability { .. }
                    | WorkKind::ConnectConnector { .. }
                    | WorkKind::ReconnectConnector { .. }
            )
        }));
    }
    items.extend(inbound_items(inbound));
    items.retain(|item| {
        actionable(&item.kind) && work_module(&item.kind).is_none_or(|m| offered[&m])
    });
    items.sort_by_key(|item| item.priority);
    Ok(PendingOut {
        strategy: state,
        items,
        agent,
    })
}

/// An agent's check-in: what is pending ([`pending`]), with the caller seen at `ctx.now`, so
/// its `agent.overdue` is `false` (the latest sighting is now). Only an agent may check in, else
/// `FORBIDDEN` with `details.reason = "agents_only"`; it needs `workspace.read`.
///
/// Writes `work.checkin` about the agent's connection (payload `{}`) unless that connection's
/// last check-in was ledgered less than [`CHECKIN_LEDGER_RESOLUTION`] before `ctx.now`. The
/// connection's `last_seen_at` is not touched here: the MCP gate moves it on every call. Two
/// check-ins racing on one connection may both be ledgered.
///
/// The bundle that looks up and writes the check-in ends (committed, or dropped when nothing is
/// written) before what is pending is read, which opens bundles of its own: holding it meanwhile
/// would take two pool connections per check-in, and a burst of check-ins could hold every
/// connection while each waits for another.
pub async fn checkin(deps: &Deps, ctx: &Ctx) -> Result<PendingOut, AppError> {
    let Actor::Agent { connection_id, .. } = ctx.actor else {
        return Err(AppError {
            code: ErrorCode::Forbidden,
            message: "only an agent checks in".into(),
            details: json!({ "reason": "agents_only" }),
        });
    };
    ctx.require(Permission::WorkspaceRead)?;
    {
        let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
        if !checked_in_lately(repos.as_mut(), connection_id, ctx.now).await? {
            let in_force = version_in_force(repos.as_mut()).await?;
            let mut entry =
                ledger_entry(ctx, CHECKIN, "agent_connection", connection_id, json!({}))?;
            entry.strategy_version_id = in_force.map(|id| id.as_uuid());
            repos.ledger().append(entry).await?;
            repos.commit().await?;
        }
    }
    pending_as_seen(deps, ctx, Some(ctx.now)).await
}

/// Sets how often the workspace's agent is expected to check in, and returns the check-in state
/// under the new interval. Needs `team.manage`; `minutes` must be
/// [`MIN_AGENT_CHECKIN_INTERVAL_MINUTES`] (a quarter hour) to
/// [`MAX_AGENT_CHECKIN_INTERVAL_MINUTES`] (a week), else `VALIDATION` naming `minutes`.
///
/// Writes `work.set_checkin_interval` about the workspace's policy (payload `minutes`).
pub async fn set_checkin_interval(
    deps: &Deps,
    ctx: &Ctx,
    minutes: u32,
) -> Result<AgentState, AppError> {
    ctx.require(Permission::TeamManage)?;
    if !(MIN_AGENT_CHECKIN_INTERVAL_MINUTES..=MAX_AGENT_CHECKIN_INTERVAL_MINUTES).contains(&minutes)
    {
        return Err(invalid(
            "minutes",
            &format!(
                "minutes must be {MIN_AGENT_CHECKIN_INTERVAL_MINUTES} to \
                 {MAX_AGENT_CHECKIN_INTERVAL_MINUTES}"
            ),
        ));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut policy: WorkspacePolicy = repos.workspace_policy().get().await?;
    policy.agent_checkin_interval_minutes = minutes;
    repos.workspace_policy().set(policy, ctx.now).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    let mut entry = ledger_entry(
        ctx,
        "work.set_checkin_interval",
        "workspace_policy",
        ctx.workspace_id,
        json!({ "minutes": minutes }),
    )?;
    entry.strategy_version_id = in_force.map(|id| id.as_uuid());
    repos.ledger().append(entry).await?;
    let state = agent_state(repos.as_mut(), ctx.now, None).await?;
    repos.commit().await?;
    Ok(state)
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/// The draft's state when one is open (it is the pending work), else the approved version's, else
/// missing.
fn strategy_state(strategy: &StrategyOut) -> StrategyState {
    match (&strategy.draft, &strategy.approved) {
        (Some(draft), _) if let Some(submitted_at) = draft.submitted_at => {
            StrategyState::Submitted {
                version_id: draft.id,
                submitted_at,
            }
        }
        (Some(draft), _) => StrategyState::DraftOpen {
            gaps: draft.gaps.clone(),
        },
        (None, Some(approved)) => StrategyState::Approved {
            number: approved.number,
        },
        (None, None) => StrategyState::Missing,
    }
}

/// Whether the caller may approve a submitted draft, as `strategy.approve` decides: the role
/// owner or manager, and `team.manage`.
fn may_approve(ctx: &Ctx) -> bool {
    ctx.is_owner_or_manager() && ctx.permissions.contains(&Permission::TeamManage)
}

/// The strategy's item, if any: consult while there is no strategy or a draft is open; approve a
/// submitted draft, only for a caller who may.
fn strategy_items(state: &StrategyState, may_approve: bool) -> Vec<WorkItem> {
    let item = match state {
        StrategyState::Missing => Some((
            WorkKind::ConsultStrategy,
            "No strategy yet: start the consultation with jeeta.strategy.start_consultation; \
             jeeta.strategy.get explains the steps.",
        )),
        StrategyState::DraftOpen { .. } => Some((
            WorkKind::ConsultStrategy,
            "A strategy draft is open: continue the consultation with the owner, close its gaps \
             (jeeta.strategy.get lists them) and submit it with jeeta.strategy.submit.",
        )),
        StrategyState::Submitted { .. } if may_approve => Some((
            WorkKind::ApproveStrategy,
            "A strategy draft awaits approval: go through it with the owner, read its assumptions \
             to them (jeeta.strategy.get, draft.assumptions) and, once they confirm, approve it \
             with jeeta.strategy.approve.",
        )),
        StrategyState::Submitted { .. } | StrategyState::Approved { .. } => None,
    };
    item.map(|(kind, hint)| WorkItem {
        kind,
        priority: 1,
        hint: hint.to_owned(),
    })
    .into_iter()
    .collect()
}

/// The item of capability `c`, of a kind verified by its heartbeat, while it reads `declared`,
/// `stale` or `unreachable` (its bridge does not report it): each such kind has its own, cleared
/// by its own bridge's registration. `None` for any other kind.
pub fn offline_item(c: &Capability) -> Option<WorkItem> {
    let (name, last_seen_at) = (c.name.clone(), c.last_verified_at);
    let (kind, hint) = match c.kind_key.as_str() {
        VOICE_BRIDGE_KIND => (
            WorkKind::VoiceBridgeOffline {
                capability_id: c.id,
                name,
                last_seen_at,
            },
            "The voice bridge has not registered in the last minute (or never has), so agent \
             calls through it are refused: ask the operator to check the jeeta-voice-bridge \
             service on the server (docs/operations/voice-bridge.md). It cannot be verified by \
             evidence.",
        ),
        PHONE_KIND => (
            WorkKind::PhoneOffline {
                capability_id: c.id,
                name,
                last_seen_at,
            },
            "No device bridge has listed this phone in the last minute (or ever), so commands for \
             it are refused (device_offline): ask the owner to check that it is plugged into the \
             PC, unlocked, with USB debugging allowed, and that the jeeta-device-bridge program \
             runs there. It cannot be verified by evidence; retire it with \
             jeeta.capability.retire if it is no longer used.",
        ),
        _ => return None,
    };
    Some(WorkItem {
        kind,
        priority: 2,
        hint: hint.to_owned(),
    })
}

/// The capabilities' items, in their order: each agent or device capability to verify, each
/// connector to connect, each capability verified by its heartbeat that does not report (a voice
/// bridge, a phone: [`offline_item`]); and, when none is live, declaring the first.
fn capability_items(capabilities: &[CapabilityOut]) -> Vec<WorkItem> {
    let mut items = Vec::new();
    for out in capabilities {
        let c = &out.capability;
        let status = out.effective_status;
        if c.kind().is_some_and(|k| k.heartbeat().is_some()) {
            if matches!(
                status,
                EffectiveStatus::Declared | EffectiveStatus::Stale | EffectiveStatus::Unreachable
            ) {
                items.extend(offline_item(c));
            }
            continue;
        }
        match c.reach {
            Reach::Agent | Reach::Device
                if matches!(status, EffectiveStatus::Declared | EffectiveStatus::Stale) =>
            {
                let stale = status == EffectiveStatus::Stale;
                let hint = if stale {
                    "Its verification is older than its policy allows: check it again and \
                     verify it with jeeta.capability.verify, giving evidence of what you ran or \
                     saw."
                } else {
                    "Declared but not verified: check it and verify it with \
                     jeeta.capability.verify, giving evidence of what you ran or saw."
                };
                items.push(WorkItem {
                    kind: WorkKind::VerifyCapability {
                        capability_id: c.id,
                        name: c.name.clone(),
                        stale,
                    },
                    priority: 2,
                    hint: hint.to_owned(),
                });
            }
            Reach::Connector
                if status == EffectiveStatus::Unreachable && connector::reconnect_required(c) =>
            {
                items.push(WorkItem {
                    kind: WorkKind::ReconnectConnector {
                        capability_id: c.id,
                        name: c.name.clone(),
                    },
                    priority: 1,
                    hint: "Its provider no longer accepts its login: ask the owner to reconnect \
                           it (jeeta.connector.reconnect gives the sign-in link to hand them; a \
                           NetGSM line takes new credentials with \
                           jeeta.connector.set_credentials)."
                        .to_owned(),
                });
            }
            Reach::Connector if status == EffectiveStatus::Declared => items.push(WorkItem {
                kind: WorkKind::ConnectConnector {
                    capability_id: c.id,
                    name: c.name.clone(),
                },
                priority: 2,
                hint: "Declared but not connected: its account must be connected so that its \
                       connector can reach and verify it."
                    .to_owned(),
            }),
            Reach::Agent | Reach::Device | Reach::Connector => {}
        }
    }
    let any_live = capabilities
        .iter()
        .any(|c| c.effective_status != EffectiveStatus::Retired);
    if !any_live {
        items.push(WorkItem {
            kind: WorkKind::DeclareFirstCapability,
            priority: 3,
            hint: "No capability is declared: declare what the workspace can act through (its \
                   accounts, devices and your own access) with jeeta.capability.declare."
                .to_owned(),
        });
    }
    items
}

/// The inbound events' item, when `count` (capped) are unprocessed.
fn inbound_items(count: u32) -> Option<WorkItem> {
    (count > 0).then(|| WorkItem {
        kind: WorkKind::InboundEvents { count },
        priority: 2,
        hint: "Inbound events (messages, delivery statuses, leads, calls, consent changes) await \
               handling: read them with jeeta.events.pending, oldest first, and acknowledge each \
               one you have handled with jeeta.events.ack."
            .to_owned(),
    })
}

/// The workspace's check-in state at `now`: the latest sight of any of its connections, and of
/// `seen_now` (a caller seen at the time of its call, if any), under its interval.
async fn agent_state(
    repos: &mut dyn TenantRepos,
    now: OffsetDateTime,
    seen_now: Option<OffsetDateTime>,
) -> Result<AgentState, AppError> {
    let interval_minutes = repos
        .workspace_policy()
        .get()
        .await?
        .agent_checkin_interval_minutes;
    let last_seen_at = repos
        .agent_connections()
        .list()
        .await?
        .into_iter()
        .map(|c| c.last_seen_at)
        .chain(seen_now)
        .max();
    Ok(AgentState {
        last_seen_at,
        interval_minutes,
        overdue: agents::overdue(last_seen_at, interval_minutes, now),
    })
}

/// Whether connection `connection_id` has a check-in ledgered less than
/// [`CHECKIN_LEDGER_RESOLUTION`] before `now`.
async fn checked_in_lately(
    repos: &mut dyn TenantRepos,
    connection_id: AgentConnectionId,
    now: OffsetDateTime,
) -> Result<bool, AppError> {
    let last = repos.ledger().last_checkin_at(connection_id).await?;
    Ok(last.is_some_and(|at| now - at < CHECKIN_LEDGER_RESOLUTION))
}

/// The id of the approved version in force, if any.
async fn version_in_force(
    repos: &mut dyn TenantRepos,
) -> Result<Option<StrategyVersionId>, AppError> {
    Ok(repos.strategy().current_approved().await?.map(|v| v.id))
}

/// The Meta surface capabilities (Facebook Pages, Instagram accounts) not retired whose platform
/// comment flag is on for their login but whose grant lacks the comment permissions
/// ([`super::inbox::public::CommentStatus::Reconnect`]): an `EnableComments` item each. With the
/// flags off, none.
fn enable_comment_items(deps: &Deps, capabilities: &[CapabilityOut]) -> Vec<WorkItem> {
    capabilities
        .iter()
        .map(|out| &out.capability)
        .filter(|c| {
            matches!(c.kind_key.as_str(), "facebook_page" | "instagram")
                && c.status != jt_capability::StoredStatus::Retired
        })
        .filter(|c| {
            super::inbox::public::comment_status(deps.apps.as_ref(), c)
                == Some(super::inbox::public::CommentStatus::Reconnect)
        })
        .map(|c| WorkItem {
            kind: WorkKind::EnableComments {
                capability_id: c.id,
                name: c.name.clone(),
            },
            priority: 3,
            hint: "Comments are on for this platform, but this account's grant lacks the comment \
                   permissions: ask a human to reconnect it (jeeta.connector.reconnect)."
                .into(),
        })
        .collect()
}

/// What an agent that has never seen the system needs to carry a production area to its package:
/// what to read, what to call, in which order (design 2026-11-10 S26).
const CONTENT_AREA_HINT: &str = "Carry this production area to a content package; nobody approves \
    it in between. (1) Read jeeta.strategy.get and jeeta.studio.project_get: `brief` is the goal, \
    `hints` holds a platform or format a person chose (empty: you choose, from the goal and the \
    connected accounts), and `redo_note` on this item, when present, says what the person wants \
    changed. (2) Take the area with jeeta.content.area_claim at expected_revision and keep the \
    claim_token; the claim lasts 30 minutes from your last report, and the area leaves your \
    check-in while you hold it. (3) Follow the 14 steps of the content module's workflow \
    (jeeta.modules.list) and report where you are with jeeta.content.area_progress. (4) Use the \
    area's materials, or make a visual with your own tools: upload it with \
    jeeta.studio.file_upload, add it with jeeta.studio.material_add (genel true, origin \
    ai_generated with the name of the tool that made it, quality publishable, depicts [] and \
    share shareable; a visual showing a person, a name or a logo takes a person's permission \
    instead) and attach it with jeeta.studio.project_materials. A material you add may appear \
    in your check-in as a studio_material_analysis item; it does not hold your delivery. A \
    visual you made may be a version's only material when the version speaks about nothing \
    specific: beside it, name no recorded event (jeeta.studio.olays_list), nor its place, date \
    or client. When the work needs a real photo or video, ask with \
    jeeta.studio.project_request and give the area back with jeeta.content.area_release; it \
    returns to your check-in once the capture is there. (5) Deliver every platform version in \
    one call to jeeta.content.area_deliver, each with a hypothesis_id of the approved strategy; \
    with no connected account leave capability_id out. A refusal lists, by version index, what \
    to fix: fix it and deliver again with a new request_key. Three refusals in a row hand the \
    area to a person. An accepted delivery finishes the area.";

/// What an agent that has never seen the system needs to plan an ad campaign.
const ADS_PLAN_HINT: &str = "An ad campaign waits for its plan. Read it with \
    jeeta.ads.campaign_get (its goal, its total budget in minor units, its start), then claim it \
    with jeeta.ads.campaign_claim (campaign_id, expected_revision); the answer carries a \
    claim_token. Read the strategy (jeeta.strategy.get) for the paid hypotheses and the ad \
    accounts (jeeta.capability.list, group ads). The ad account you choose decides the platform \
    (the campaign's own account when a person chose one), and the platform decides what a plan \
    carries: `platforms` in the campaign_get answer says it field by field. On Meta (meta_ads): \
    the Facebook Page (kind facebook_page), one shareable image of the library per ad \
    (jeeta.studio.materials_list), a primary text, a headline, a call to action; the result is \
    link_click to a website or lead_form; an audience and placements. On Google (google_ads): \
    search ads, each 3 to 15 headlines and 2 to 4 descriptions, the plan's keywords (the \
    searches the ads answer), the countries and a website; no image, no page, no age range, \
    and at least 72 hours of run. On LinkedIn (linkedin_ads): one shareable JPG, PNG or GIF \
    image per ad, a primary text, a headline, a call to action LinkedIn has a button for, the \
    countries and a website; no page (the ad speaks as the company page of the ad account), no \
    description, no age range or gender (LinkedIn's targeting may not be used to discriminate \
    by them). Choose an end time 24 hours to 90 days after the start and \
    one to six ads, and deliver them with jeeta.ads.plan_submit (campaign_id, claim_token, \
    request_key, plan). You only decide: Jeeta checks the plan, holds the campaign's whole \
    budget against every limit and builds the campaign at the ad platform itself, paused first. \
    A refusal names each field to fix; the third in a row hands the campaign to a person. If \
    rejected is set, the platform turned an ad down: read why in the campaign and replace that \
    ad with jeeta.ads.campaign_move (kind fix_ad).";

/// What the agent needs for its daily look at a running campaign.
const ADS_REVIEW_HINT: &str = "A running ad campaign has had no look today. Read it with \
    jeeta.ads.campaign_get: each ad's state, the daily numbers per ad (spend, impressions, \
    clicks, results; a number the platform does not give is null) and the earlier moves. Then \
    make one move with jeeta.ads.campaign_move, with its reason: pause_ad, resume_ad, add_ad, \
    fix_ad, or none when nothing should change. The budget and the end date are a person's.";

/// What the agent that plans posts needs to give a finished version its time.
const SOCIAL_SCHEDULE_HINT: &str = "A platform version of a finished content package has no \
    time yet. Read jeeta.social.versions_waiting: each version lists the accounts it can go out \
    on. Choose an account and a time and call jeeta.social.version_schedule (project_id, \
    version_id, capability_id, publish_at as an RFC 3339 time, request_key). The posting limits \
    apply as jeeta.studio.posts_list shows them under settings: the lead before a post, quiet \
    hours, the daily cap and the spacing between posts of an account, and the planning horizon. \
    A refusal names the limit: choose another time. Nobody approves the post; it goes out at \
    its time.";

/// Assignment limits the offered work, never a human's visibility or underlying permissions.
async fn module_work_offered(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    module: &str,
) -> Result<bool, AppError> {
    if !super::modules::installed(r, module).await? {
        return Ok(false);
    }
    let Some(agent) = ctx.agent_connection_id else {
        return Ok(true);
    };
    let registry = super::modules::resolve(r.workspace().module_registry().await?)?;
    Ok(registry
        .modules
        .iter()
        .find(|m| m.blueprint.id == module)
        .is_some_and(|m| m.config.agent_ids.is_empty() || m.config.agent_ids.contains(&agent)))
}
fn work_module(kind: &WorkKind) -> Option<&'static str> {
    use crate::ports::studio::ApprovalTarget;
    Some(match kind {
        WorkKind::StudioSlot { .. }
        | WorkKind::StudioPostRequest { .. }
        | WorkKind::SocialSchedule { .. }
        | WorkKind::StudioApproval {
            target: ApprovalTarget::Slot(_),
        } => "social",
        WorkKind::StudioBudgetMove { .. }
        | WorkKind::AdsCampaignPlan { .. }
        | WorkKind::AdsCampaignReview { .. }
        | WorkKind::AdsCampaignProposal { .. }
        | WorkKind::AdsCampaignHeld { .. }
        | WorkKind::StudioApproval {
            target: ApprovalTarget::BudgetMove(_),
        } => "ads",
        WorkKind::StudioShootRequest { .. } | WorkKind::StudioMaterialAnalysis { .. } => {
            "materials"
        }
        WorkKind::StudioMaterialProduction { .. }
        | WorkKind::ContentArea { .. }
        | WorkKind::ContentMaterialRequest { .. }
        | WorkKind::ContentAreaHeld { .. } => "content",
        _ => return None,
    })
}
