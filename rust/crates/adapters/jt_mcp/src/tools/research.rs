//! `jeeta.research.*`: research tasks (spec `2026-10-30-leads-pool-outreach-design.md` §3.7,
//! §7.1), the briefs agents fill the prospect pool from with their own tools. Jeeta never
//! researches: a task says what to look for, and the agent records what it finds with
//! `jeeta.prospects.create`.

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::Deps;
use jt_app::usecases::research::{self, CloseInput, CreateInput, ListInput};
use jt_prospects::ResearchTaskId;
use jt_tenancy::Permission;
use schemars::{Schema, json_schema};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::ToolFuture;

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "research.tasks_list",
            description: "List the research tasks, newest first: filter status (open, done, \
                          canceled, superseded); limit 1 to 200 (50). Each item is {task, \
                          remaining_today}: a task's kind is standing (icp_key: one per ICP \
                          entry of the approved strategy, kept by Jeeta) or ad_hoc \
                          (target_count), with its brief (segment_key, sectors, areas, signals, \
                          exclusions, size_hint, language, note), rubric_digest, daily_cap, \
                          status and claim. Answers {items, next}: pass next.before_at and \
                          next.before_id back for the following page. [risk: READ]",
            permissions: &[Permission::ProspectsWork],
            schema: list_schema,
            run: tasks_list,
        },
        ToolDef {
            use_case: "research.tasks_get",
            description: "Read one research task (task_id): the task, remaining_today (how many \
                          prospects it may still record today: its daily cap, the workspace's \
                          ceiling and, for a standing task, its segment's backlog), found (how \
                          many it recorded) and its 20 newest prospects (no contact values). \
                          [risk: READ]",
            permissions: &[Permission::ProspectsWork],
            schema: id_schema,
            run: tasks_get,
        },
        ToolDef {
            use_case: "research.tasks_create",
            description: "Ask for research beyond the standing tasks: an ad-hoc task with a \
                          brief {sectors (1 to 10), areas [{city, district?}] (1 to 20), \
                          signals and exclusions (up to 10 each), size_hint, language, note, \
                          segment_key? (one of the strategy's audience)}, target_count (1 to \
                          500) and daily_cap (1 to 500). It closes itself once target_count \
                          prospects are recorded for it. CONFLICT prospecting_off while the \
                          approved strategy has no ICP entry. A request_key replays the task it \
                          created for 24 hours. Answers {task, remaining_today}. [risk: WRITE]",
            permissions: &[Permission::ProspectsWork],
            schema: create_schema,
            run: tasks_create,
        },
        ToolDef {
            use_case: "research.tasks_claim",
            description: "Claim an open research task (task_id) for two hours before working on \
                          it, or renew your claim. The claim is advisory: when another recorder \
                          holds a live claim, the answer says so (claimed: false, held_by_other: \
                          true, with their claim) and you may still record; prefer another task. \
                          Answers {task_id, claimed, claim, held_by_other}; CONFLICT task_closed. \
                          [risk: WRITE]",
            permissions: &[Permission::ProspectsWork],
            schema: id_schema,
            run: tasks_claim,
        },
        ToolDef {
            use_case: "research.tasks_close",
            description: "Close an open ad-hoc research task (task_id) with outcome done or \
                          canceled and a note (up to 1000 characters). A standing task follows \
                          its ICP entry and is never closed by hand (CONFLICT standing_task); \
                          CONFLICT task_closed when it is closed already. Answers {task, \
                          remaining_today}. [risk: WRITE]",
            permissions: &[Permission::ProspectsWork],
            schema: close_schema,
            run: tasks_close,
        },
    ]
}

fn uuid(description: &str) -> Value {
    json!({ "type": "string", "format": "uuid", "description": description })
}

fn text(max: usize, description: &str) -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": max, "description": description })
}

fn list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["open", "done", "canceled", "superseded"] },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            "before_at": { "type": "string", "format": "date-time", "description": "next.before_at of the previous page." },
            "before_id": uuid("next.before_id of the previous page."),
        },
        "additionalProperties": false,
    })
}

fn id_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "task_id": uuid("The research task.") },
        "required": ["task_id"],
        "additionalProperties": false,
    })
}

fn create_schema() -> Schema {
    let list = |max_items: usize, max: usize, description: &str| json!({ "type": "array", "maxItems": max_items, "items": text(max, description) });
    json_schema!({
        "type": "object",
        "properties": {
            "brief": {
                "type": "object",
                "properties": {
                    "segment_key": { "type": "string", "pattern": "^[a-z0-9_]{2,32}$", "description": "One of the strategy's audience segments." },
                    "sectors": { "type": "array", "minItems": 1, "maxItems": 10, "items": text(80, "A sector, in the workspace's words.") },
                    "areas": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": { "city": text(80, "The city."), "district": text(80, "The district.") },
                            "required": ["city"],
                            "additionalProperties": false,
                        },
                    },
                    "signals": list(10, 200, "What to look for."),
                    "exclusions": list(10, 200, "What disqualifies."),
                    "size_hint": { "type": "string", "maxLength": 200 },
                    "language": { "type": "string", "minLength": 2, "maxLength": 8, "description": "A BCP 47 primary tag: tr, en." },
                    "note": { "type": "string", "maxLength": 1000 },
                },
                "required": ["sectors", "areas"],
                "additionalProperties": false,
            },
            "target_count": { "type": "integer", "minimum": 1, "maximum": 500 },
            "daily_cap": { "type": "integer", "minimum": 1, "maximum": 500 },
            "request_key": text(128, "Replays the task it created for 24 hours."),
        },
        "required": ["brief", "target_count", "daily_cap"],
        "additionalProperties": false,
    })
}

fn close_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "task_id": uuid("The research task."),
            "outcome": { "type": "string", "enum": ["done", "canceled"] },
            "note": { "type": "string", "maxLength": 1000 },
        },
        "required": ["task_id", "outcome"],
        "additionalProperties": false,
    })
}

/// Takes `task_id` out of the arguments; the rest is the body.
fn split(mut raw: Value) -> Result<(ResearchTaskId, Value), AppError> {
    let id = raw
        .as_object_mut()
        .and_then(|o| o.remove("task_id"))
        .unwrap_or(Value::Null);
    let id: Uuid = args(id)?;
    Ok((ResearchTaskId(id), raw))
}

fn tasks_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: ListInput = args(raw)?;
        to_json(&research::tasks_list(deps, ctx, input).await?)
    })
}

fn tasks_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw)?;
        let NoArgs {} = args(rest)?;
        to_json(&research::tasks_get(deps, ctx, id).await?)
    })
}

fn tasks_create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: CreateInput = args(raw)?;
        to_json(&research::tasks_create(deps, ctx, input).await?)
    })
}

fn tasks_claim<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw)?;
        let NoArgs {} = args(rest)?;
        to_json(&research::tasks_claim(deps, ctx, id).await?)
    })
}

fn tasks_close<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw)?;
        let input: CloseInput = args(rest)?;
        to_json(&research::tasks_close(deps, ctx, id, input).await?)
    })
}
