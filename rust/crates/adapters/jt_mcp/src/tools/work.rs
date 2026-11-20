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
                          knowledge is {empty, revision, frame, derive_due}: the knowledge \
                          base's state (empty: no card has text yet, so nothing is planned, \
                          delivered or sent; revision: what jeeta.strategy.frame_apply names as \
                          kb_revision; frame: the number of the frame in force; derive_due: \
                          posting or prospecting, the derivations a card change waits for). \
                          strategy is deprecated: missing without a frame, {approved: {number}} \
                          with one. Each item has a kind (knowledge_derive with kb_revision and \
                          part (to an agent with content.work for posting, prospects.work for \
                          prospecting: read jeeta.strategy.knowledge_get and apply with \
                          jeeta.strategy.frame_apply), knowledge_note with note_id and \
                          expected_revision (to an agent with any work permission: claim it \
                          with jeeta.strategy.note_claim and file it with \
                          jeeta.strategy.note_file), knowledge_proposal with proposal_id and \
                          knowledge_empty (to a person who keeps the knowledge base), \
                          verify_capability with capability_id, name and stale, \
                          connect_connector and reconnect_connector with capability_id and name, \
                          voice_bridge_offline and phone_offline with capability_id, name and \
                          last_seen_at (its bridge does not report it: no evidence verifies it), \
                          inbound_events with count (up to 1000: unacknowledged events to read \
                          with jeeta.events.pending; listed only to a key that may acknowledge \
                          them, with capabilities.manage), studio_shoot_request with \
                          shoot_request_id (a material Studio needs, listed with \
                          jeeta.studio.shoot_list: tell the owner, who shoots it), \
                          studio_material_analysis with material_id, expected_revision and \
                          unfiled (to an agent with materials.work: claim, inspect the preview with \
                          your own tools, and complete or fail; unfiled true: a person uploaded it \
                          with no olay, so file it with the completion, reading \
                          jeeta.studio.olays_list; live leases and terminal results are omitted), \
                          studio_material_production with production_id and expected_revision \
                          (human-requested edit/crop/poster: claim and produce with your own tools, \
                          then upload a distinct AI result; no server generation), \
                          studio_post_request with post_request_id (plan posts from \
                          its materials and answer it with jeeta.studio.posts_propose), \
                          content_area with project_id, expected_revision and redo_note (to \
                          an agent with content.work: a production area whose start time has \
                          come; take it with jeeta.content.area_claim and carry it to a \
                          package; it leaves the list while an agent holds it), \
                          social_schedule with project_id and version_id (to an agent with \
                          social.work: a finished platform version without a time; give it one \
                          with jeeta.social.version_schedule), content_material_request with \
                          project_id and request_id and content_area_held with project_id (to \
                          a person: a capture an agent asked for, and an area whose delivery \
                          was refused three times), \
                          declare_first_capability (with the verify and connect items, only \
                          to a key with capabilities.manage), research_due \
                          with task_id and remaining_today (research businesses for that task \
                          with your own tools and record them; to a key with prospects.work), \
                          prospects_to_score with count (new prospects to score under the \
                          frame's rubric)), a priority \
                          (1 is the most urgent) and a hint saying what to do. No item asks you \
                          to redo what a person already approved. agent says when an agent was \
                          last seen, the \
                          check-in interval in minutes and whether the agent is overdue. \
                          [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: pending,
        },
        ToolDef {
            use_case: "work.checkin",
            description: "Check in: call this on your own schedule, at least once per check-in \
                          interval (agent.interval_minutes, learned from your own check-ins), \
                          and the owner sees a warning when you are late. When a person gives \
                          you work in the panel and your key has a wake address, Jeeta also \
                          wakes you; call this first then too. Returns what is pending, as \
                          jeeta.work.pending does; act on the items. The check-in is recorded \
                          at most once an hour. Uploaded materials remain pending until an \
                          external agent claims and analyzes them; no server vision job runs. \
                          [risk: WRITE]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: checkin,
        },
        ToolDef {
            use_case: "work.set_checkin_interval",
            description: "Set how often the workspace's agent is expected to check in, in \
                          minutes: 15 (a quarter hour) to 10080 (a week); a day unless set. \
                          An agent with enough check-ins of its own is judged by its own \
                          rhythm instead; this is the fallback. \
                          Returns the check-in state under the new interval: last_seen_at, \
                          interval_minutes and overdue. [risk: WRITE]",
            permissions: &[Permission::TeamManage],
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
