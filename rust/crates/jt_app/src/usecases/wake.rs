//! Waking an agent when a person gives it work: `agents.wake_set`, `agents.wake_remove`,
//! `agents.wake_now`, `agents.wakes`, the requests the person's own actions record, the
//! check-in's part, and the `agent_wake` job that sends them.
//!
//! Agents live outside Jeeta and check in on their own schedule (`work.checkin`). That schedule
//! is right for what the clock produces, but a person who asks for something now should not
//! wait for the next hour. So an agent (an API key, see [`crate::ports::wake`]) may carry one
//! **wake address**: a Claude Code routine's API trigger, or any HTTPS webhook. Only a person
//! holding `team.manage` sets or removes it, in the panel: no MCP tool reads or writes it, and
//! every use case here refuses an agent's key.
//!
//! **What wakes an agent.** A person's own action that creates or changes work an agent can take
//! records a wake request, in the same transaction, for each agent whose key may take that work
//! (the permission and module `work.pending` lists it under: [`Need`]) and that has a usable
//! address. The places, with their reason codes:
//!
//! - `content.area_redo` (a revision; also the social page's "request a revision"):
//!   `content_revision`, for `content.work` agents of the content module, when the area waits
//!   for an agent afterwards (an agent still holding its claim is already on it);
//! - `studio.project_create` by a person, starting now: `content_requested`; `studio.project_update`
//!   unarchiving an area that then waits for an agent: `content_requested`;
//! - `studio.project_request_update` answering the last open capture request, so the area goes
//!   back to the agent: `capture_answered`;
//! - `studio.material_production_request` and `studio.project_production`: `production_requested`;
//! - `studio.material_add` by a person (an upload that waits for its analysis):
//!   `material_uploaded`, for `materials.work` agents of the materials module;
//!   `studio.material_analysis_retry`: `analysis_retried`;
//! - `content.delivery_accept` (a held delivery accepted: its versions wait for a time):
//!   `delivery_accepted`, for `social.work` agents of the social module; `social.account_pause`
//!   resuming an account: `account_resumed`;
//! - `ads.campaign_open` starting now, `ads.campaign_approve`, `ads.campaign_resume`:
//!   `ad_campaign_opened`, for `ads.work` agents of the ads module;
//! - `research.tasks_create` by a person: `research_requested`, for `prospects.work` agents;
//! - `inbox.hand_to_agent` and `inbox.unsnooze` by a person: `conversation_handed`, for
//!   `inbox.work` agents;
//! - `strategy.approve` by a person: `strategy_approved`, for the agents of the work it opens
//!   (`social.work`, `ads.work`, `prospects.work`);
//! - `agents.wake_now`: `manual`, for the one agent named.
//!
//! **What deliberately does not.** Work the clock or the system makes: the planner's areas (an
//! olay's, a calendar day's, the floor), package requests (the planner's alone), a slot reaching
//! its preparation time, a campaign's daily look, research quotas resetting, due tasks and
//! answer deadlines, outreach's personalisation and follow-ups: the agent's own schedule exists
//! for them, and waking it on a clock would only move the schedule. Work an agent makes for
//! itself or another (scores, promotions, proposals, budget moves): the agent is already
//! running. Inbound events (messages, comments, leads): they arrive at any rate, so waking on
//! each would spend the rate limits on what the schedule handles; a hand-over by a person is
//! the inbox's wake. A person's action on a start in the future (an area or a campaign starting
//! later): the work appears on the clock, so nothing is woken now. Items only a person clears
//! (approvals, held areas, capture requests): no agent can take them.
//!
//! **How.** A request bumps the row's `seq`, adds its reason (distinct, capped) and its person,
//! and opens or extends the row's one pending wake. The `agent_wake` job sends it
//! [`WAKE_SETTLE`](crate::ports::wake::WAKE_SETTLE) after the last request, never later than [`WAKE_SETTLE_MAX`](crate::ports::wake::WAKE_SETTLE_MAX) after the
//! first; at most once per [`WAKE_MIN_GAP`](crate::ports::wake::WAKE_MIN_GAP) and [`WAKE_HOURLY_CAP`](crate::ports::wake::WAKE_HOURLY_CAP) times an hour per agent (a
//! wake held back waits, and the panel says until when). An agent that checks in drops its own
//! pending wake when no request came after the check-in began: it read the work already. A
//! routine answering `429` is tried again after its `Retry-After`; the network or a `5xx` with
//! backoff from [`WAKE_RETRY_BASE`](crate::ports::wake::WAKE_RETRY_BASE), given up after [`WAKE_RETRY_FOR`](crate::ports::wake::WAKE_RETRY_FOR); `401`, `403` or `404`
//! marks the address refused (one ledger entry, the attempt's) and stops until a person sets it
//! again. Every attempt that reached the network writes `agent.wake`: who caused it, which agent,
//! the reasons, the outcome, the session a routine created; never the token.
//!
//! **Interval.** How often an agent checks in is learned from its own check-ins: the median gap
//! between its scheduled check-ins (a woken run's are left out), once there are two gaps, within
//! the bounds of `work.set_checkin_interval`; until then the workspace's number. "Next expected"
//! is the last scheduled check-in plus that interval ([`interval_of`]).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use jt_ledger::Actor;
use jt_tenancy::{ApiKeyId, MembershipStatus, Permission, UserId, WorkspaceId, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

use super::studio::library::person;
use super::{Deps, invalid, ledger_entry};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
pub use crate::ports::wake::{
    AgentWakeRow, PendingWake, WaitingFor, WakeAnswer, WakeAttempt, WakeKind, WakeOutcome,
    WakeReason,
};
use crate::ports::wake::{
    WAKE_CAUSED_BY_CAP, WAKE_REASONS_CAP, WAKE_RETRY_BASE, WAKE_RETRY_FOR, WAKE_RETRY_MAX_DELAY,
    WakeAddress, WebhookWake, wake_text,
};
use crate::ports::{
    AgentConnectionRow, ApiKeyRow, ApiKeyStatus, MAX_AGENT_CHECKIN_INTERVAL_MINUTES,
    MIN_AGENT_CHECKIN_INTERVAL_MINUTES, TenantRepos,
};

/// An agent seen this recently is taken to be running.
pub const WORKING_WINDOW: Duration = Duration::minutes(2);
/// A fire this recent, with the agent not seen since, reads as "called".
pub const CALLED_WINDOW: Duration = Duration::minutes(15);
/// The longest `Retry-After` honoured, and the wait when a `429` gives none.
const RETRY_AFTER_MAX: Duration = Duration::hours(1);
const RETRY_AFTER_DEFAULT: Duration = Duration::seconds(60);
const RETRY_AFTER_MIN: Duration = Duration::seconds(10);

/// The longest routine id, webhook URL, token and secret taken.
pub const ROUTINE_ID_MAX: usize = 128;
pub const URL_MAX: usize = 2048;
pub const SECRET_MAX: usize = 4096;

const NO_SUCH_AGENT: &str = "no such agent";

// ---------------------------------------------------------------------------------------------
// What work needs
// ---------------------------------------------------------------------------------------------

/// What an agent's key must hold to take some work: the permission, and the module it must be
/// offered (installed, and the agent among its assigned agents, or none assigned), as
/// `work.pending` decides what an agent sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Need {
    pub key: &'static str,
    pub permission: Permission,
    pub module: Option<&'static str>,
}

pub const CONTENT: Need = Need {
    key: "content",
    permission: Permission::ContentWork,
    module: Some("content"),
};
pub const MATERIALS: Need = Need {
    key: "materials",
    permission: Permission::MaterialsWork,
    module: Some("materials"),
};
pub const SOCIAL: Need = Need {
    key: "social",
    permission: Permission::SocialWork,
    module: Some("social"),
};
pub const ADS: Need = Need {
    key: "ads",
    permission: Permission::AdsWork,
    module: Some("ads"),
};
pub const RESEARCH: Need = Need {
    key: "research",
    permission: Permission::ProspectsWork,
    module: None,
};
pub const INBOX: Need = Need {
    key: "inbox",
    permission: Permission::InboxWork,
    module: None,
};
/// Every need the panel reads a state for.
pub const NEEDS: [Need; 6] = [CONTENT, MATERIALS, SOCIAL, ADS, RESEARCH, INBOX];

/// Which manage permission lets a person wake an agent by hand for the work permission its key
/// holds (besides `team.manage`, which always does).
const MANAGES: [(Permission, Permission); 7] = [
    (Permission::ContentManage, Permission::ContentWork),
    (Permission::ContentManage, Permission::MaterialsWork),
    (Permission::SocialManage, Permission::SocialWork),
    (Permission::AdsManage, Permission::AdsWork),
    (Permission::ProspectsManage, Permission::ProspectsWork),
    (Permission::OutreachManage, Permission::OutreachWork),
    (Permission::InboxManage, Permission::InboxWork),
];

// ---------------------------------------------------------------------------------------------
// The agents
// ---------------------------------------------------------------------------------------------

/// One agent: an active key, what it acts with now, and its connections.
struct Agent {
    key: ApiKeyRow,
    /// The key's scopes its issuer still holds; empty when the issuer left.
    permissions: BTreeSet<Permission>,
    connections: Vec<AgentConnectionRow>,
}

impl Agent {
    fn last_seen_at(&self) -> Option<OffsetDateTime> {
        self.connections.iter().map(|c| c.last_seen_at).max()
    }

    fn takes(&self, need: &Need, offered: &Offered) -> bool {
        self.permissions.contains(&need.permission)
            && need
                .module
                .is_none_or(|m| offered.offers(m, &self.connections))
    }
}

/// The modules' installation and assignment, read once.
struct Offered {
    modules: BTreeMap<String, (bool, Vec<jt_tenancy::AgentConnectionId>)>,
}

impl Offered {
    async fn read(repos: &mut dyn TenantRepos) -> Result<Offered, AppError> {
        let registry = super::modules::resolve(repos.workspace().module_registry().await?)?;
        Ok(Offered {
            modules: registry
                .modules
                .into_iter()
                .map(|m| (m.blueprint.id.clone(), (m.installed, m.config.agent_ids)))
                .collect(),
        })
    }

    /// Whether `module` is installed and offered to an agent with `connections` (as
    /// `work::module_work_offered` decides for one connection).
    fn offers(&self, module: &str, connections: &[AgentConnectionRow]) -> bool {
        self.modules.get(module).is_some_and(|(installed, ids)| {
            *installed && (ids.is_empty() || connections.iter().any(|c| ids.contains(&c.id)))
        })
    }
}

/// The workspace's active keys as agents, oldest first.
async fn agents_in(repos: &mut dyn TenantRepos) -> Result<Vec<Agent>, AppError> {
    let keys: Vec<ApiKeyRow> = repos
        .api_keys()
        .list()
        .await?
        .into_iter()
        .filter(|k| k.status == ApiKeyStatus::Active)
        .collect();
    let connections = repos.agent_connections().list().await?;
    let mut roles: BTreeMap<UserId, BTreeSet<Permission>> = BTreeMap::new();
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let held = match roles.get(&key.issued_by) {
            Some(held) => held.clone(),
            None => {
                let membership = repos
                    .memberships()
                    .find_by_user(key.issued_by)
                    .await?
                    .filter(|m| m.status == MembershipStatus::Active);
                let held = match membership {
                    Some(m) => repos
                        .roles()
                        .find(m.role_id)
                        .await?
                        .map(|r| r.permissions)
                        .unwrap_or_default(),
                    None => BTreeSet::new(),
                };
                roles.insert(key.issued_by, held.clone());
                held
            }
        };
        let permissions = key.scopes.intersection(&held).copied().collect();
        let connections = connections
            .iter()
            .filter(|c| c.api_key_id == key.id)
            .cloned()
            .collect();
        out.push(Agent {
            key,
            permissions,
            connections,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/// Records a wake request with `reason` for every agent that may take work of one of `needs`
/// and has a usable address, when the caller is a person acting in person (an agent's or the
/// system's action wakes nobody). In the caller's transaction: commits with the person's action
/// or not at all. Reads nothing more than the wake rows when no agent has an address.
pub(crate) async fn request(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    needs: &[Need],
    reason: WakeReason,
) -> Result<(), AppError> {
    let Some(user) = person(ctx) else {
        return Ok(());
    };
    let rows = repos.agent_connections().wakes().await?;
    if !rows.iter().any(AgentWakeRow::usable) {
        return Ok(());
    }
    let agents = agents_in(repos).await?;
    let offered = Offered::read(repos).await?;
    for row in rows.iter().filter(|r| r.usable()) {
        let takes = agents
            .iter()
            .find(|a| a.key.id == row.api_key_id)
            .is_some_and(|a| needs.iter().any(|n| a.takes(n, &offered)));
        if !takes {
            continue;
        }
        let Some(mut row) = repos
            .agent_connections()
            .wake_lock(row.api_key_id)
            .await?
            .filter(AgentWakeRow::usable)
        else {
            continue;
        };
        add_request(&mut row, ctx.now, reason, Some(user), false);
        repos.agent_connections().wake_save(row).await?;
    }
    Ok(())
}

/// Adds one request at `now` to `row`'s pending wake, opening it when there is none.
fn add_request(
    row: &mut AgentWakeRow,
    now: OffsetDateTime,
    reason: WakeReason,
    by: Option<UserId>,
    manual: bool,
) {
    row.seq += 1;
    let p = row.pending.get_or_insert_with(|| PendingWake {
        first_at: now,
        last_at: now,
        reasons: Vec::new(),
        caused_by: Vec::new(),
        manual: false,
        failures: 0,
        first_failure_at: None,
        retry_at: None,
    });
    p.last_at = p.last_at.max(now);
    if !p.reasons.contains(&reason) && p.reasons.len() < WAKE_REASONS_CAP {
        p.reasons.push(reason);
    }
    if let Some(user) = by
        && !p.caused_by.contains(&user)
        && p.caused_by.len() < WAKE_CAUSED_BY_CAP
    {
        p.caused_by.push(user);
    }
    p.manual |= manual;
}

// ---------------------------------------------------------------------------------------------
// The check-in's part
// ---------------------------------------------------------------------------------------------

/// At the start of an agent's check-in through a connection of key `key`, at `now`: keeps the
/// check-in for learning the interval, and answers the row's `seq` when a wake is pending for
/// it, for [`checkin_seen`] once the check-in has read its work.
pub(crate) async fn checkin_began(
    repos: &mut dyn TenantRepos,
    key: ApiKeyId,
    now: OffsetDateTime,
) -> Result<Option<u64>, AppError> {
    let (mut row, new) = match repos.agent_connections().wake_lock(key).await? {
        Some(row) => (row, false),
        None => (AgentWakeRow::new(key), true),
    };
    let marked = row.mark_checkin(now);
    let pending = row.pending.as_ref().map(|_| row.seq);
    if marked || new {
        repos.agent_connections().wake_save(row).await?;
    }
    Ok(pending)
}

/// After a check-in of key `key` read its pending work: drops the key's pending wake unless a
/// request came after the check-in began (`seq` moved), since the agent has seen the work.
pub(crate) async fn checkin_seen(
    deps: &Deps,
    ws: WorkspaceId,
    key: ApiKeyId,
    seq: u64,
) -> Result<(), AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    let Some(mut row) = repos.agent_connections().wake_lock(key).await? else {
        return Ok(());
    };
    if row.seq != seq || row.pending.is_none() {
        return Ok(());
    }
    row.pending = None;
    repos.agent_connections().wake_save(row).await?;
    repos.commit().await
}

// ---------------------------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------------------------

/// An agent's check-in interval in minutes, and whether it was learned from its own check-ins
/// (else `fallback`, the workspace's number).
pub fn interval_of(row: Option<&AgentWakeRow>, fallback: u32) -> (u32, bool) {
    match row.and_then(|r| {
        r.learned_interval_minutes(
            MIN_AGENT_CHECKIN_INTERVAL_MINUTES,
            MAX_AGENT_CHECKIN_INTERVAL_MINUTES,
        )
    }) {
        Some(m) => (m, true),
        None => (fallback, false),
    }
}

/// When the agent is next expected: its last scheduled check-in (else its last sight) plus its
/// interval.
fn next_expected(
    row: Option<&AgentWakeRow>,
    last_seen_at: Option<OffsetDateTime>,
    interval: u32,
) -> Option<OffsetDateTime> {
    row.and_then(AgentWakeRow::last_scheduled_checkin)
        .or(last_seen_at)
        .map(|at| at + Duration::minutes(i64::from(interval)))
}

/// Each key's interval in minutes, learned or `fallback`: what `agents.list` and `work.pending`
/// judge lateness by.
pub(crate) async fn intervals(
    repos: &mut dyn TenantRepos,
    fallback: u32,
) -> Result<BTreeMap<ApiKeyId, u32>, AppError> {
    Ok(repos
        .agent_connections()
        .wakes()
        .await?
        .iter()
        .map(|r| (r.api_key_id, interval_of(Some(r), fallback).0))
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/// A wake address as reads show it: the kind, the routine's id or the webhook's host, who set
/// it and when, and whether it was refused. Never the token, the secret or the URL's path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WakeAddressOut {
    pub kind: WakeKind,
    /// The routine's id, or the webhook URL's host.
    pub target: String,
    pub has_secret: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub set_at: OffsetDateTime,
    pub set_by: UserId,
    #[serde(with = "time::serde::rfc3339::option")]
    pub refused_at: Option<OffsetDateTime>,
}

impl From<&WakeAddress> for WakeAddressOut {
    fn from(a: &WakeAddress) -> Self {
        WakeAddressOut {
            kind: a.kind,
            target: match a.kind {
                WakeKind::ClaudeRoutine => a.target.clone(),
                WakeKind::Webhook => url::Url::parse(&a.target)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or_default(),
            },
            has_secret: a.has_secret,
            set_at: a.set_at,
            set_by: a.set_by,
            refused_at: a.refused_at,
        }
    }
}

/// The wake waiting to go out, as reads show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingOut {
    #[serde(with = "time::serde::rfc3339")]
    pub due_at: OffsetDateTime,
    pub waiting_for: WaitingFor,
    pub reasons: Vec<WakeReason>,
}

/// One agent's wake state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentWakeOut {
    pub api_key_id: ApiKeyId,
    pub address: Option<WakeAddressOut>,
    pub pending: Option<PendingOut>,
    pub last: Option<WakeAttempt>,
    /// The latest sight of any of its connections.
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_seen_at: Option<OffsetDateTime>,
    pub interval_minutes: u32,
    /// Learned from its own check-ins, not the workspace's number.
    pub interval_learned: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_expected_at: Option<OffsetDateTime>,
    /// Whether the caller may wake it by hand now (`agents.wake_now`), and from when when only
    /// the rate limits stop it.
    pub run_now: Option<RunNow>,
}

/// Whether a person may press "run now", and when it would go out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RunNow {
    pub api_key_id: ApiKeyId,
    /// The rate limits allow a fire only from then; `None`: now.
    #[serde(with = "time::serde::rfc3339::option")]
    pub after: Option<OffsetDateTime>,
}

/// What a page's waiting work can expect from the agents that may take it: one state for all
/// such agents, the best one (an agent at work, then a call on its way, a call made, an agent
/// with a usable address waiting for its schedule, a refused address, an agent without an
/// address). One sentence in the panel, never one line per agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum NeedWake {
    /// No agent may take this work.
    NoAgent,
    /// An agent was seen within [`WORKING_WINDOW`].
    Working {
        api_key_id: ApiKeyId,
        #[serde(with = "time::serde::rfc3339")]
        last_seen_at: OffsetDateTime,
    },
    /// A call goes out at `due_at`.
    Calling {
        api_key_id: ApiKeyId,
        #[serde(with = "time::serde::rfc3339")]
        due_at: OffsetDateTime,
        waiting_for: WaitingFor,
    },
    /// An agent was called at `at` and has not come yet.
    Called {
        api_key_id: ApiKeyId,
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
    /// The agents wait for their own schedule. `has_address`: at least one could be woken
    /// (then `run_now`, when the caller may); `failed_at`: its last call failed.
    Schedule {
        #[serde(with = "time::serde::rfc3339::option")]
        next_expected_at: Option<OffsetDateTime>,
        interval_minutes: u32,
        has_address: bool,
        #[serde(with = "time::serde::rfc3339::option")]
        failed_at: Option<OffsetDateTime>,
        run_now: Option<RunNow>,
    },
    /// The only agents that could be woken have a refused address.
    Refused { api_key_id: ApiKeyId },
}

/// `agents.wakes`: every agent's wake state and, per kind of work, what its waiting items can
/// expect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WakesOut {
    pub agents: Vec<AgentWakeOut>,
    /// Keyed by [`Need::key`]: `content`, `materials`, `social`, `ads`, `research`, `inbox`.
    pub needs: BTreeMap<&'static str, NeedWake>,
}

/// `agents.wakes`. Needs `workspace.read`, and a person in the panel (an agent never reads wake
/// addresses).
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<WakesOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    people_only(ctx)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    list_in(repos.as_mut(), ctx).await
}

async fn list_in(repos: &mut dyn TenantRepos, ctx: &Ctx) -> Result<WakesOut, AppError> {
    let fallback = repos
        .workspace_policy()
        .get()
        .await?
        .agent_checkin_interval_minutes;
    let rows: BTreeMap<ApiKeyId, AgentWakeRow> = repos
        .agent_connections()
        .wakes()
        .await?
        .into_iter()
        .map(|r| (r.api_key_id, r))
        .collect();
    let agents = agents_in(repos).await?;
    let offered = Offered::read(repos).await?;
    let views: Vec<(AgentWakeOut, &Agent)> = agents
        .iter()
        .map(|a| (view(ctx, a, rows.get(&a.key.id), fallback), a))
        .collect();
    let needs = NEEDS
        .iter()
        .map(|need| {
            let candidates: Vec<&AgentWakeOut> = views
                .iter()
                .filter(|(_, a)| a.takes(need, &offered))
                .map(|(v, _)| v)
                .collect();
            (need.key, need_state(ctx.now, &candidates))
        })
        .collect();
    Ok(WakesOut {
        agents: views.into_iter().map(|(v, _)| v).collect(),
        needs,
    })
}

/// Agent `a`'s wake state at `ctx.now`, for `ctx`'s caller.
fn view(ctx: &Ctx, a: &Agent, row: Option<&AgentWakeRow>, fallback: u32) -> AgentWakeOut {
    let (interval_minutes, interval_learned) = interval_of(row, fallback);
    let last_seen_at = a.last_seen_at();
    let usable = row.is_some_and(AgentWakeRow::usable);
    let pending = row.and_then(|r| {
        let (due_at, waiting_for) = r.due()?;
        Some(PendingOut {
            due_at,
            waiting_for,
            reasons: r.pending.as_ref()?.reasons.clone(),
        })
    });
    let run_now = (usable && pending.is_none() && may_wake(ctx, a)).then(|| RunNow {
        api_key_id: a.key.id,
        after: row
            .and_then(AgentWakeRow::rate_free_at)
            .filter(|at| *at > ctx.now),
    });
    AgentWakeOut {
        api_key_id: a.key.id,
        address: row
            .and_then(|r| r.address.as_ref())
            .map(WakeAddressOut::from),
        pending,
        last: row.and_then(|r| r.last.clone()),
        last_seen_at,
        interval_minutes,
        interval_learned,
        next_expected_at: next_expected(row, last_seen_at, interval_minutes),
        run_now,
    }
}

/// The one state of the work `candidates` may take (see [`NeedWake`]).
fn need_state(now: OffsetDateTime, candidates: &[&AgentWakeOut]) -> NeedWake {
    if candidates.is_empty() {
        return NeedWake::NoAgent;
    }
    if let Some((v, seen)) = candidates
        .iter()
        .filter_map(|v| Some((v, v.last_seen_at?)))
        .filter(|(_, seen)| now - *seen <= WORKING_WINDOW)
        .max_by_key(|(_, seen)| *seen)
    {
        return NeedWake::Working {
            api_key_id: v.api_key_id,
            last_seen_at: seen,
        };
    }
    if let Some((v, p)) = candidates
        .iter()
        .filter_map(|v| Some((v, v.pending.as_ref()?)))
        .min_by_key(|(_, p)| p.due_at)
    {
        return NeedWake::Calling {
            api_key_id: v.api_key_id,
            due_at: p.due_at,
            waiting_for: p.waiting_for,
        };
    }
    let usable = |v: &&&AgentWakeOut| v.address.as_ref().is_some_and(|a| a.refused_at.is_none());
    if let Some((v, at)) = candidates
        .iter()
        .filter(usable)
        .filter_map(|v| {
            let last = v.last.as_ref()?;
            (last.outcome == WakeOutcome::Fired
                && now - last.at <= CALLED_WINDOW
                && v.last_seen_at.is_none_or(|seen| seen < last.at))
            .then_some((v, last.at))
        })
        .max_by_key(|(_, at)| *at)
    {
        return NeedWake::Called {
            api_key_id: v.api_key_id,
            at,
        };
    }
    let woken: Vec<&&AgentWakeOut> = candidates.iter().filter(usable).collect();
    if woken.is_empty()
        && let Some(v) = candidates
            .iter()
            .find(|v| v.address.as_ref().is_some_and(|a| a.refused_at.is_some()))
    {
        return NeedWake::Refused {
            api_key_id: v.api_key_id,
        };
    }
    let soonest = candidates
        .iter()
        .filter(|v| v.next_expected_at.is_some())
        .min_by_key(|v| v.next_expected_at);
    let failed_at = woken
        .iter()
        .filter_map(|v| v.last.as_ref())
        .filter(|l| {
            matches!(
                l.outcome,
                WakeOutcome::GaveUp | WakeOutcome::Rejected | WakeOutcome::Unavailable
            )
        })
        .map(|l| l.at)
        .max();
    NeedWake::Schedule {
        next_expected_at: soonest.and_then(|v| v.next_expected_at),
        interval_minutes: soonest
            .or(candidates.first())
            .map_or(0, |v| v.interval_minutes),
        has_address: !woken.is_empty(),
        failed_at,
        run_now: woken.iter().find_map(|v| v.run_now),
    }
}

/// Whether `ctx`'s person may wake agent `a` by hand: `team.manage`, or the manage permission
/// of work its key holds (who may give it that work may ask it to start on it).
fn may_wake(ctx: &Ctx, a: &Agent) -> bool {
    person(ctx).is_some()
        && (ctx.permissions.contains(&Permission::TeamManage)
            || MANAGES.iter().any(|(manage, work)| {
                ctx.permissions.contains(manage) && a.permissions.contains(work)
            }))
}

/// `FORBIDDEN` (`details.reason = "people_only"`) unless a person in the panel calls.
fn people_only(ctx: &Ctx) -> Result<UserId, AppError> {
    person(ctx).ok_or_else(|| AppError {
        code: ErrorCode::Forbidden,
        message: "only a person manages an agent's wake address".into(),
        details: json!({ "reason": "people_only" }),
    })
}

// ---------------------------------------------------------------------------------------------
// Setting, removing, waking by hand
// ---------------------------------------------------------------------------------------------

/// What setting a wake address takes. `Debug` masks the token and the secret.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetWake {
    pub api_key_id: ApiKeyId,
    pub kind: WakeKind,
    /// A routine's id (`trig_…`).
    #[serde(default)]
    pub routine_id: Option<String>,
    /// A routine's token, shown once in claude.ai when its API trigger is made.
    #[serde(default)]
    pub token: Option<String>,
    /// A webhook's HTTPS URL.
    #[serde(default)]
    pub url: Option<String>,
    /// A webhook's bearer secret, optional.
    #[serde(default)]
    pub secret: Option<String>,
}

impl fmt::Debug for SetWake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SetWake")
            .field("api_key_id", &self.api_key_id)
            .field("kind", &self.kind)
            .field("routine_id", &self.routine_id)
            .field("token", &self.token.as_ref().map(|_| "***"))
            .field("url", &"…")
            .field("secret", &self.secret.as_ref().map(|_| "***"))
            .finish()
    }
}

/// The sealed form of a wake address's token or secret.
#[derive(Serialize, Deserialize)]
struct WakeSecret {
    token: String,
}

/// `agents.wake_set`: sets agent `api_key_id`'s wake address, replacing any (a refused one
/// included: setting it again is how a refusal is cleared). Needs `team.manage`, a person in the
/// panel, and an active key of this workspace (`NOT_FOUND` otherwise).
///
/// A routine needs `routine_id` (`trig_` then letters, digits, `_` or `-`, at most
/// [`ROUTINE_ID_MAX`] characters) and `token`; a webhook needs `url`, an `https` URL without a
/// user or password whose host is public (the egress rules of the tenant tier), at most
/// [`URL_MAX`] characters, and takes an optional `secret`. A token or secret is printable ASCII
/// without spaces, at most [`SECRET_MAX`] characters. Anything else is `VALIDATION` naming the
/// field. The token is sealed for the workspace, never stored or returned in the clear.
///
/// A pending wake is dropped (it was for the old address). Writes `agents.wake_set` (payload
/// `api_key_id`, `kind`, `target`: the routine's id or the URL's host).
pub async fn set(deps: &Deps, ctx: &Ctx, input: SetWake) -> Result<WakesOut, AppError> {
    ctx.require(Permission::TeamManage)?;
    let user = people_only(ctx)?;
    let (target, secret) = match input.kind {
        WakeKind::ClaudeRoutine => {
            let id = input.routine_id.as_deref().map(str::trim).unwrap_or("");
            let well_formed = id.len() > "trig_".len()
                && id.len() <= ROUTINE_ID_MAX
                && id.starts_with("trig_")
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if !well_formed {
                return Err(invalid(
                    "routine_id",
                    "a routine id starts with trig_ and has only letters, digits, _ or -",
                ));
            }
            let token = secret_of("token", input.token.as_deref())?
                .ok_or_else(|| invalid("token", "a routine needs its token"))?;
            (id.to_owned(), Some(token))
        }
        WakeKind::Webhook => {
            let url = webhook_url(deps, input.url.as_deref())?;
            (url, secret_of("secret", input.secret.as_deref())?)
        }
    };
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    active_key(repos.as_mut(), input.api_key_id).await?;
    let sealed = match &secret {
        Some(token) => {
            let plain = Zeroizing::new(
                serde_json::to_vec(&WakeSecret {
                    token: token.to_string(),
                })
                .map_err(|_| AppError::internal("the wake token cannot be sealed"))?,
            );
            Some(deps.seal.seal(ctx.workspace_id, &plain)?)
        }
        None => None,
    };
    drop(secret);
    let mut row = repos
        .agent_connections()
        .wake_lock(input.api_key_id)
        .await?
        .unwrap_or_else(|| AgentWakeRow::new(input.api_key_id));
    let address = WakeAddress {
        kind: input.kind,
        target,
        has_secret: sealed.is_some(),
        set_at: ctx.now,
        set_by: user,
        refused_at: None,
    };
    let shown = WakeAddressOut::from(&address).target;
    row.address = Some(address);
    row.pending = None;
    repos.agent_connections().wake_save(row).await?;
    repos
        .agent_connections()
        .wake_set_sealed(input.api_key_id, sealed)
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "agents.wake_set",
            "api_key",
            input.api_key_id,
            json!({ "api_key_id": input.api_key_id, "kind": input.kind, "target": shown }),
        )?)
        .await?;
    let out = list_in(repos.as_mut(), ctx).await?;
    repos.commit().await?;
    Ok(out)
}

/// `agents.wake_remove`: removes agent `api_key_id`'s wake address and its sealed token, and
/// drops its pending wake; its check-ins and its last outcome stay. Needs `team.manage` and a
/// person in the panel; an agent without an address is `NOT_FOUND`. Writes `agents.wake_remove`
/// (payload `api_key_id`, `kind`).
pub async fn remove(deps: &Deps, ctx: &Ctx, api_key_id: ApiKeyId) -> Result<WakesOut, AppError> {
    ctx.require(Permission::TeamManage)?;
    people_only(ctx)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut row = repos
        .agent_connections()
        .wake_lock(api_key_id)
        .await?
        .filter(|r| r.address.is_some())
        .ok_or_else(|| AppError::not_found("the agent has no wake address"))?;
    let kind = row.address.take().map(|a| a.kind);
    row.pending = None;
    repos.agent_connections().wake_save(row).await?;
    repos
        .agent_connections()
        .wake_set_sealed(api_key_id, None)
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "agents.wake_remove",
            "api_key",
            api_key_id,
            json!({ "api_key_id": api_key_id, "kind": kind }),
        )?)
        .await?;
    let out = list_in(repos.as_mut(), ctx).await?;
    repos.commit().await?;
    Ok(out)
}

/// `agents.wake_now`: wakes agent `api_key_id` as soon as the rate limits let it, with no settle
/// time. A person in the panel holding `team.manage`, or the manage permission of work the
/// agent's key holds (`content.manage` for `content.work` or `materials.work`, `social.manage`,
/// `ads.manage`, `prospects.manage`, `outreach.manage`, `inbox.manage` for their `.work`): who
/// may give an agent work, which wakes it anyway, may ask it to start now. `FORBIDDEN` otherwise.
///
/// An agent without a usable address is `CONFLICT` (`details.reason` `no_wake_address` or
/// `wake_refused`); one the rate limits hold back is `CONFLICT` with `details.reason =
/// "rate_limited"` and `details.retry_at`, when it may be tried again; a wake already waiting
/// to go out answers as it is (pressing twice is pressing once). The fire is sent by the
/// `agent_wake` job, within seconds. Writes `agents.wake_now` (payload `api_key_id`).
pub async fn wake_now(deps: &Deps, ctx: &Ctx, api_key_id: ApiKeyId) -> Result<WakesOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let user = people_only(ctx)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let agent = agents_in(repos.as_mut())
        .await?
        .into_iter()
        .find(|a| a.key.id == api_key_id)
        .ok_or_else(|| AppError::not_found(NO_SUCH_AGENT))?;
    if !may_wake(ctx, &agent) {
        return Err(AppError {
            code: ErrorCode::Forbidden,
            message: "waking this agent needs team.manage or the manage permission of its work"
                .into(),
            details: json!({ "permission": Permission::TeamManage.key() }),
        });
    }
    let mut row = repos
        .agent_connections()
        .wake_lock(api_key_id)
        .await?
        .filter(|r| r.address.is_some())
        .ok_or_else(|| conflict("the agent has no wake address", "no_wake_address", None))?;
    if !row.usable() {
        return Err(conflict(
            "the agent's wake address was refused: set it again",
            "wake_refused",
            None,
        ));
    }
    if row.pending.is_none()
        && let Some(at) = row.rate_free_at().filter(|at| *at > ctx.now)
    {
        return Err(conflict(
            "the agent was woken a moment ago",
            "rate_limited",
            Some(at),
        ));
    }
    add_request(&mut row, ctx.now, WakeReason::Manual, Some(user), true);
    repos.agent_connections().wake_save(row).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "agents.wake_now",
            "api_key",
            api_key_id,
            json!({ "api_key_id": api_key_id }),
        )?)
        .await?;
    let out = list_in(repos.as_mut(), ctx).await?;
    repos.commit().await?;
    Ok(out)
}

fn conflict(message: &str, reason: &str, retry_at: Option<OffsetDateTime>) -> AppError {
    let mut details = json!({ "reason": reason });
    if let Some(at) = retry_at {
        details["retry_at"] = json!(
            at.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        );
    }
    AppError {
        code: ErrorCode::Conflict,
        message: message.into(),
        details,
    }
}

/// Key `id`, active, of this workspace; `NOT_FOUND` otherwise.
async fn active_key(repos: &mut dyn TenantRepos, id: ApiKeyId) -> Result<ApiKeyRow, AppError> {
    repos
        .api_keys()
        .list()
        .await?
        .into_iter()
        .find(|k| k.id == id && k.status == ApiKeyStatus::Active)
        .ok_or_else(|| AppError::not_found(NO_SUCH_AGENT))
}

/// A token or secret: trimmed, empty meaning none; printable ASCII without spaces, at most
/// [`SECRET_MAX`] characters, else `VALIDATION` naming `field`.
fn secret_of(field: &str, raw: Option<&str>) -> Result<Option<Zeroizing<String>>, AppError> {
    let Some(text) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if text.len() > SECRET_MAX || !text.chars().all(|c| c.is_ascii_graphic()) {
        return Err(invalid(
            field,
            "a token is printable characters without spaces, at most 4096",
        ));
    }
    Ok(Some(Zeroizing::new(text.to_owned())))
}

/// A webhook URL as stored: `https`, no user or password, no fragment, a public host (the
/// tenant tier's rule, [`crate::ports::TenantHostRegistry::check`]), at most [`URL_MAX`]
/// characters.
fn webhook_url(deps: &Deps, raw: Option<&str>) -> Result<String, AppError> {
    let text = raw.map(str::trim).unwrap_or("");
    let bad = || invalid("url", "a webhook address is an https URL on a public host");
    if text.is_empty() || text.len() > URL_MAX {
        return Err(bad());
    }
    let url = url::Url::parse(text).map_err(|_| bad())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(bad());
    }
    let host = url.host_str().ok_or_else(bad)?;
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    deps.hosts.check(&host).map_err(|e| {
        let mut err = bad();
        err.details["reason"] = e.details["reason"].clone();
        err
    })?;
    Ok(url.to_string())
}

// ---------------------------------------------------------------------------------------------
// The agent_wake job
// ---------------------------------------------------------------------------------------------

/// What one run of the job did with one wake.
pub(crate) enum Sent {
    /// It went out (whatever the target answered): the attempt was ledgered.
    Attempted(WakeOutcome),
    /// It was no longer due, or its address changed meanwhile: nothing sent or written.
    Skipped,
}

/// The wakes due at `now` in workspace `ws`, by key, read in a transaction of their own. In a
/// suspended workspace nothing is sent and the pending wakes are dropped: no work can be done
/// there.
pub(crate) async fn due_in(
    deps: &Deps,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Result<Vec<ApiKeyId>, AppError> {
    let mut repos = deps.uow.tenant(ws).await?;
    let rows = repos.agent_connections().wakes().await?;
    let due: Vec<ApiKeyId> = rows
        .iter()
        .filter(|r| r.due_at().is_some_and(|at| at <= now))
        .map(|r| r.api_key_id)
        .collect();
    if repos.workspace().get().await?.status == WorkspaceStatus::Suspended {
        for key in due {
            if let Some(mut row) = repos.agent_connections().wake_lock(key).await? {
                row.pending = None;
                repos.agent_connections().wake_save(row).await?;
            }
        }
        repos.commit().await?;
        return Ok(Vec::new());
    }
    Ok(due)
}

/// Sends key `key`'s due wake in workspace `ws` at `now`, through `waker`.
///
/// The row and its sealed token are read under the row's lock in a transaction of its own,
/// ended before the target is called; the answer is written in a second transaction, under the
/// lock again, only while the row still has the address the call went to (a person who set or
/// removed it meanwhile wins: `Skipped`). The token is opened only for the call and dropped
/// right after; it is never logged, stored or ledgered.
pub(crate) async fn send_one(
    deps: &Deps,
    waker: &dyn crate::ports::wake::AgentWaker,
    ws: WorkspaceId,
    key: ApiKeyId,
    now: OffsetDateTime,
    component: &str,
) -> Result<Sent, AppError> {
    let (row, sealed) = {
        let mut repos = deps.uow.tenant(ws).await?;
        let Some(row) = repos.agent_connections().wake_lock(key).await? else {
            return Ok(Sent::Skipped);
        };
        if row.due_at().is_none_or(|at| at > now) {
            return Ok(Sent::Skipped);
        }
        let sealed = repos.agent_connections().wake_sealed(key).await?;
        (row, sealed)
    };
    let (Some(address), Some(pending)) = (row.address.clone(), row.pending.clone()) else {
        return Ok(Sent::Skipped);
    };
    let secret: Option<Zeroizing<String>> = match &sealed {
        Some(bytes) => {
            let plain = deps.seal.open(ws, bytes)?;
            let parsed: WakeSecret = serde_json::from_slice(&plain)
                .map_err(|_| AppError::internal("the sealed wake token cannot be read"))?;
            Some(Zeroizing::new(parsed.token))
        }
        None => None,
    };
    let answer = match address.kind {
        WakeKind::ClaudeRoutine => match &secret {
            Some(token) => {
                waker
                    .fire_routine(&address.target, token, &wake_text(&pending.reasons))
                    .await
            }
            None => WakeAnswer::Refused { status: None },
        },
        WakeKind::Webhook => {
            let body = WebhookWake {
                workspace_id: ws,
                agent_id: key,
                reasons: pending.reasons.clone(),
                at: now,
            };
            waker
                .post_webhook(
                    &address.target,
                    secret.as_deref().map(String::as_str),
                    &body,
                )
                .await
        }
    };
    drop(secret);

    let mut repos = deps.uow.tenant(ws).await?;
    let Some(mut current) = repos.agent_connections().wake_lock(key).await? else {
        return Ok(Sent::Skipped);
    };
    if current.address.as_ref() != Some(&address) {
        return Ok(Sent::Skipped);
    }
    let (outcome, status, session_id, session_url, retry_at) =
        apply(&mut current, &pending, answer, now);
    let payload = json!({
        "api_key_id": key,
        "kind": address.kind,
        "reasons": pending.reasons,
        "caused_by": pending.caused_by,
        "manual": pending.manual,
        "outcome": outcome,
        "status": status,
        "session_id": session_id,
        "session_url": session_url,
        "retry_at": retry_at.and_then(|at| at.format(&time::format_description::well_known::Rfc3339).ok()),
    });
    repos.agent_connections().wake_save(current).await?;
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: component.to_owned(),
        },
        permissions: BTreeSet::new(),
        role_key: None,
        now,
        agent_connection_id: None,
    };
    repos
        .ledger()
        .append(ledger_entry(&ctx, "agent.wake", "api_key", key, payload)?)
        .await?;
    repos.commit().await?;
    Ok(Sent::Attempted(outcome))
}

/// Writes `answer` (to the wake `sent`) into `row` at `now`; returns the outcome, the status,
/// the session's id and address, and the retry time, for the ledger.
#[allow(clippy::type_complexity)]
fn apply(
    row: &mut AgentWakeRow,
    sent: &PendingWake,
    answer: WakeAnswer,
    now: OffsetDateTime,
) -> (
    WakeOutcome,
    Option<u16>,
    Option<String>,
    Option<String>,
    Option<OffsetDateTime>,
) {
    let attempt =
        |outcome, status, session_id: Option<String>, session_url: Option<String>| WakeAttempt {
            at: now,
            reasons: sent.reasons.clone(),
            outcome,
            status,
            session_id,
            session_url,
        };
    match answer {
        WakeAnswer::Fired {
            status,
            session_id,
            session_url,
        } => {
            row.record_fire(now);
            // The woken session reads whatever is committed when it checks in, requests
            // recorded during the call included.
            row.pending = None;
            row.last = Some(attempt(
                WakeOutcome::Fired,
                Some(status),
                session_id.clone(),
                session_url.clone(),
            ));
            (
                WakeOutcome::Fired,
                Some(status),
                session_id,
                session_url,
                None,
            )
        }
        WakeAnswer::RateLimited { retry_after } => {
            let wait = retry_after
                .unwrap_or(RETRY_AFTER_DEFAULT)
                .clamp(RETRY_AFTER_MIN, RETRY_AFTER_MAX);
            let retry_at = now + wait;
            if let Some(p) = row.pending.as_mut() {
                p.retry_at = Some(retry_at);
            }
            row.last = Some(attempt(WakeOutcome::RateLimited, Some(429), None, None));
            (
                WakeOutcome::RateLimited,
                Some(429),
                None,
                None,
                Some(retry_at),
            )
        }
        WakeAnswer::Unavailable { status } => {
            let Some(p) = row.pending.as_mut() else {
                return (WakeOutcome::Unavailable, status, None, None, None);
            };
            p.failures += 1;
            let first = *p.first_failure_at.get_or_insert(now);
            if now - first >= WAKE_RETRY_FOR {
                row.pending = None;
                row.last = Some(attempt(WakeOutcome::GaveUp, status, None, None));
                return (WakeOutcome::GaveUp, status, None, None, None);
            }
            let exponent = p.failures.saturating_sub(1).min(16);
            let delay = (WAKE_RETRY_BASE * 2_i32.pow(exponent)).min(WAKE_RETRY_MAX_DELAY);
            let retry_at = now + delay;
            p.retry_at = Some(retry_at);
            row.last = Some(attempt(WakeOutcome::Unavailable, status, None, None));
            (WakeOutcome::Unavailable, status, None, None, Some(retry_at))
        }
        WakeAnswer::Refused { status } => {
            if let Some(a) = row.address.as_mut() {
                a.refused_at = Some(now);
            }
            row.pending = None;
            row.last = Some(attempt(WakeOutcome::Refused, status, None, None));
            (WakeOutcome::Refused, status, None, None, None)
        }
        WakeAnswer::Rejected { status } => {
            row.pending = None;
            row.last = Some(attempt(WakeOutcome::Rejected, Some(status), None, None));
            (WakeOutcome::Rejected, Some(status), None, None, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::wake::{WAKE_HOURLY_CAP, WAKE_MIN_GAP, WAKE_SETTLE, WAKE_SETTLE_MAX};
    use time::macros::datetime;

    fn routine_row() -> AgentWakeRow {
        let mut r = AgentWakeRow::new(ApiKeyId::new_v7());
        r.address = Some(WakeAddress {
            kind: WakeKind::ClaudeRoutine,
            target: "trig_1".into(),
            has_secret: true,
            set_at: datetime!(2026-11-19 10:00 UTC),
            set_by: UserId::new_v7(),
            refused_at: None,
        });
        r
    }

    #[test]
    fn requests_accumulate_into_one_pending_wake_with_capped_reasons() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = routine_row();
        let user = UserId::new_v7();
        for i in 0..5 {
            add_request(
                &mut r,
                t + Duration::seconds(i * 10),
                WakeReason::MaterialUploaded,
                Some(user),
                false,
            );
        }
        let p = r.pending.as_ref().unwrap();
        assert_eq!(r.seq, 5);
        assert_eq!(p.reasons, [WakeReason::MaterialUploaded]);
        assert_eq!(p.caused_by, [user]);
        assert_eq!(p.first_at, t);
        assert_eq!(p.last_at, t + Duration::seconds(40));
        assert_eq!(r.due_at(), Some(t + Duration::seconds(85)));
    }

    #[test]
    fn failures_back_off_then_give_up_after_thirty_minutes() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = routine_row();
        add_request(&mut r, t, WakeReason::ContentRevision, None, false);
        let sent = r.pending.clone().unwrap();
        let (o, _, _, _, retry) = apply(
            &mut r,
            &sent,
            WakeAnswer::Unavailable { status: Some(503) },
            t,
        );
        assert_eq!(o, WakeOutcome::Unavailable);
        assert_eq!(retry, Some(t + Duration::seconds(30)));
        let (_, _, _, _, retry) = apply(
            &mut r,
            &sent,
            WakeAnswer::Unavailable { status: None },
            t + Duration::seconds(30),
        );
        assert_eq!(retry, Some(t + Duration::seconds(90)));
        let (o, ..) = apply(
            &mut r,
            &sent,
            WakeAnswer::Unavailable { status: None },
            t + Duration::minutes(30),
        );
        assert_eq!(o, WakeOutcome::GaveUp);
        assert!(r.pending.is_none());
    }

    #[test]
    fn a_refusal_marks_the_address_and_stops() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = routine_row();
        add_request(&mut r, t, WakeReason::ContentRevision, None, false);
        let sent = r.pending.clone().unwrap();
        let (o, status, ..) = apply(&mut r, &sent, WakeAnswer::Refused { status: Some(401) }, t);
        assert_eq!((o, status), (WakeOutcome::Refused, Some(401)));
        assert!(!r.usable());
        add_request(&mut r, t, WakeReason::ContentRevision, None, false);
        assert_eq!(r.due_at(), None);
    }

    #[test]
    fn a_429_waits_for_its_retry_after() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = routine_row();
        add_request(&mut r, t, WakeReason::ContentRevision, None, false);
        let sent = r.pending.clone().unwrap();
        let (o, _, _, _, retry) = apply(
            &mut r,
            &sent,
            WakeAnswer::RateLimited {
                retry_after: Some(Duration::seconds(120)),
            },
            t + Duration::seconds(45),
        );
        assert_eq!(o, WakeOutcome::RateLimited);
        assert_eq!(retry, Some(t + Duration::seconds(165)));
        assert_eq!(
            r.due(),
            Some((t + Duration::seconds(165), WaitingFor::Retry))
        );
    }

    #[test]
    fn a_fire_clears_the_wake_and_counts_for_the_rate() {
        let t = datetime!(2026-11-19 12:00 UTC);
        let mut r = routine_row();
        add_request(&mut r, t, WakeReason::ContentRevision, None, false);
        let sent = r.pending.clone().unwrap();
        apply(
            &mut r,
            &sent,
            WakeAnswer::Fired {
                status: 200,
                session_id: Some("s1".into()),
                session_url: Some("https://claude.ai/code/s1".into()),
            },
            t,
        );
        assert!(r.pending.is_none());
        assert_eq!(r.fires, [t]);
        assert_eq!(r.rate_free_at(), Some(t + WAKE_MIN_GAP));
        assert_eq!(r.last.as_ref().unwrap().session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn the_hourly_cap_is_twenty() {
        assert_eq!(WAKE_HOURLY_CAP, 20);
        assert_eq!(WAKE_SETTLE, Duration::seconds(45));
        assert_eq!(WAKE_SETTLE_MAX, Duration::minutes(3));
    }
}
