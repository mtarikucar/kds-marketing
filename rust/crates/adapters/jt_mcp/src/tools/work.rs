//! `jeeta.work.pending`, `jeeta.work.checkin` and `jeeta.work.set_checkin_interval`: what is
//! pending for the workspace, the agent's check-in (an agent's call only, so it has no panel
//! twin) and how often the agent is expected to check in.
//!
//! Reading what is pending and checking in need `workspace.read`; setting the interval needs
//! `team.manage`.

use jt_app::ctx::Ctx;
use jt_app::ports::{MAX_AGENT_CHECKIN_INTERVAL_MINUTES, MIN_AGENT_CHECKIN_INTERVAL_MINUTES};
use jt_app::usecases::{Deps, work};
use jt_tenancy::Permission;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "work.pending",
            description: "What is pending for the workspace, most urgent first: start here. \
                          strategy is missing, submitted, {draft_open: {gaps}} or {approved: \
                          {number}}. Each item has a kind (consult_strategy, approve_strategy, \
                          verify_capability with capability_id, name and stale, \
                          connect_connector and reconnect_connector with capability_id and name, \
                          voice_bridge_offline and phone_offline with capability_id, name and \
                          last_seen_at (its bridge does not report it: no evidence verifies it), \
                          inbound_events with count (up to 1000: unacknowledged events to read \
                          with jeeta.events.pending; listed only to a key that may acknowledge \
                          them, with capabilities.manage), declare_first_capability), a priority \
                          (1 is the most urgent) and a hint saying what to do. agent says when an agent was last seen, the \
                          check-in interval in minutes and whether the agent is overdue. \
                          [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: pending,
        },
        ToolDef {
            use_case: "work.checkin",
            description: "Check in: call this on your own schedule, at least once per check-in \
                          interval (agent.interval_minutes); nothing will wake you, and the \
                          owner sees a warning when you are late. Returns what is pending, as \
                          jeeta.work.pending does; act on the items. The check-in is recorded \
                          at most once an hour. [risk: WRITE]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: checkin,
        },
        ToolDef {
            use_case: "work.set_checkin_interval",
            description: "Set how often the workspace's agent is expected to check in, in \
                          minutes: 15 (a quarter hour) to 10080 (a week); a day unless set. \
                          Returns the check-in state under the new interval: last_seen_at, \
                          interval_minutes and overdue. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<IntervalArgs>,
            run: set_checkin_interval,
        },
    ]
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IntervalArgs {
    /// Minutes between check-ins.
    #[schemars(range(min = MIN_AGENT_CHECKIN_INTERVAL_MINUTES, max = MAX_AGENT_CHECKIN_INTERVAL_MINUTES))]
    minutes: u32,
}

fn pending<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&work::pending(deps, ctx).await?)
    })
}

fn checkin<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&work::checkin(deps, ctx).await?)
    })
}

fn set_checkin_interval<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let IntervalArgs { minutes } = args(raw)?;
        to_json(&work::set_checkin_interval(deps, ctx, minutes).await?)
    })
}
