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
//!   `declared` or `stale` (a lapsed verification is asked for again);
//! - `ConnectConnector` (2): each capability reached through a connector that reads `declared`
//!   (M1b sets connectors up);
//! - `InboundEvents` (2): inbound events (webhooks, polls) not yet acknowledged, with how many
//!   (counted up to [`INBOUND_EVENTS_COUNT_CAP`]: a count of the cap means at least that many);
//! - `DeclareFirstCapability` (3): no capability that is not retired.
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

use jt_capability::{CapabilityId, EffectiveStatus, Reach};
use jt_ledger::Actor;
use jt_strategy::{Gap, StrategyVersionId};
use jt_tenancy::{AgentConnectionId, Permission};
use serde::Serialize;
use serde_json::json;
use time::{Duration, OffsetDateTime};

use super::capabilities::CapabilityOut;
use super::strategy::{self, StrategyOut};
use super::{Deps, agents, connector, invalid, ledger_entry};
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
    InboundEvents { count: u32 },
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
    let inbound = repos
        .inbound_events()
        .count_pending(INBOUND_EVENTS_COUNT_CAP)
        .await?;
    drop(repos);

    let state = strategy_state(&strategy);
    let mut items = strategy_items(&state, may_approve(ctx));
    items.extend(capability_items(&capabilities));
    items.extend(inbound_items(inbound));
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

/// The capabilities' items, in their order: each agent or device capability to verify, each
/// connector to connect; and, when none is live, declaring the first.
fn capability_items(capabilities: &[CapabilityOut]) -> Vec<WorkItem> {
    let mut items = Vec::new();
    for out in capabilities {
        let c = &out.capability;
        let status = out.effective_status;
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
