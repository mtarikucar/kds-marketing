//! `jeeta.distribution.*`: lead distribution (spec `2026-10-30-leads-pool-outreach-design.md`
//! §3.9, §7.1): who owns a new journey. Ordered rules, then the default rule (unless the mode is
//! manual), pick among the eligible members; every decision is in the assignment log, and no open
//! journey is ever ownerless without one.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::distribution::{
    self, AssignmentsListInput, BackfillInput, RepSetInput, RulesSetInput,
};
use jt_tenancy::{Permission, UserId};
use schemars::{Schema, json_schema};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::ToolFuture;

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "distribution.get",
            description: "Read lead distribution: the mode (auto: the rules, then every eligible \
                          member by round robin; manual: only the rules, the rest wait for a \
                          manager), max_reassignments, the ordered rules, each member who holds \
                          inbox.work with their profile, open_owned, on_shift and eligible, the \
                          ownerless open journeys (count, oldest_journey_id) and the stalled \
                          assignments. [risk: READ]",
            permission: Permission::InboxWork,
            schema: empty_schema,
            run: get,
        },
        ToolDef {
            use_case: "distribution.rules_set",
            description: "Replace the distribution rules (up to 100, applied in order): each \
                          {id? (keeps its round robin), name, enabled, when {sources (prospect, \
                          channel, meta_ads, form, import, repeat), cities, sectors, languages, \
                          segments, min_score} (an empty list takes any value; a fact the lead \
                          lacks never matches a non-empty one), to {kind: members, user_ids} or \
                          {kind: all_eligible}, method round_robin | least_loaded, sla_minutes \
                          (5 to 10080 working minutes of the owner) }; and optionally mode auto | \
                          manual and max_reassignments (0 to 10). Needs inbox.manage. Answers as \
                          jeeta.distribution.get. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: rules_schema,
            run: rules_set,
        },
        ToolDef {
            use_case: "distribution.rep_set",
            description: "Replace a member's distribution profile (user_id), whole: accepting, \
                          max_open (1 to 10000 open journeys), languages, cities and sectors (up \
                          to 20 each; empty takes any), hours {tz, from, to, days} (working hours: \
                          on shift first, SLA counted inside them), away_until. A member sets \
                          their own with inbox.work; another's needs inbox.manage. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: rep_schema,
            run: rep_set,
        },
        ToolDef {
            use_case: "distribution.assignments_list",
            description: "Read the assignment log, newest first: filter journey_id, user_id; \
                          limit 1 to 200 (50). Each decision names its cause (rule, default, \
                          manual, sla_reassign, member_left, import, no_eligible), the member \
                          (none when nobody was named), the rule, the SLA due time and when the \
                          owner acted. Answers {items, next}: pass next.assigned_at and next.id \
                          back as before_at and before_id. [risk: READ]",
            permission: Permission::InboxWork,
            schema: list_schema,
            run: assignments_list,
        },
        ToolDef {
            use_case: "distribution.backfill",
            description: "Distribute up to limit (1 to 200, default 200) open journeys without an \
                          owner, longest open first, whatever their decision (a v1 import, \
                          nobody eligible, a manager's unassignment). Needs inbox.manage. Answers \
                          {assigned, no_eligible, imported, reassigned, kept}. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: backfill_schema,
            run: backfill,
        },
    ]
}

fn uuid(description: &str) -> Value {
    json!({ "type": "string", "format": "uuid", "description": description })
}

fn strings(max_items: usize) -> Value {
    json!({ "type": "array", "maxItems": max_items, "items": { "type": "string", "minLength": 1, "maxLength": 80 } })
}

fn empty_schema() -> Schema {
    json_schema!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn rules_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "rules": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": uuid("The rule's id, to keep its round robin."),
                        "name": { "type": "string", "minLength": 1, "maxLength": 80 },
                        "enabled": { "type": "boolean" },
                        "when": {
                            "type": "object",
                            "properties": {
                                "sources": { "type": "array", "items": { "type": "string", "enum": ["prospect", "channel", "meta_ads", "form", "import", "repeat"] } },
                                "cities": strings(20),
                                "sectors": strings(20),
                                "languages": strings(20),
                                "segments": strings(20),
                                "min_score": { "type": "integer", "minimum": 0, "maximum": 100 },
                            },
                            "additionalProperties": false,
                        },
                        "to": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "kind": { "const": "members" },
                                        "user_ids": { "type": "array", "minItems": 1, "maxItems": 100, "items": uuid("A member.") },
                                    },
                                    "required": ["kind", "user_ids"],
                                    "additionalProperties": false,
                                },
                                {
                                    "type": "object",
                                    "properties": { "kind": { "const": "all_eligible" } },
                                    "required": ["kind"],
                                    "additionalProperties": false,
                                },
                            ],
                        },
                        "method": { "type": "string", "enum": ["round_robin", "least_loaded"] },
                        "sla_minutes": { "type": "integer", "minimum": 5, "maximum": 10080 },
                    },
                    "required": ["name", "to", "method"],
                    "additionalProperties": false,
                },
            },
            "mode": { "type": "string", "enum": ["auto", "manual"] },
            "max_reassignments": { "type": "integer", "minimum": 0, "maximum": 10 },
        },
        "required": ["rules"],
        "additionalProperties": false,
    })
}

fn rep_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "user_id": uuid("The member."),
            "accepting": { "type": "boolean" },
            "max_open": { "type": "integer", "minimum": 1, "maximum": 10000 },
            "languages": strings(20),
            "cities": strings(20),
            "sectors": strings(20),
            "hours": {
                "type": "object",
                "properties": {
                    "tz": { "type": "string", "description": "An IANA time zone." },
                    "from": { "type": "integer", "minimum": 0, "maximum": 23 },
                    "to": { "type": "integer", "minimum": 1, "maximum": 24 },
                    "days": { "type": "array", "minItems": 1, "maxItems": 7, "items": { "type": "integer", "minimum": 1, "maximum": 7 } },
                },
                "required": ["tz", "from", "to", "days"],
                "additionalProperties": false,
            },
            "away_until": { "type": "string", "format": "date-time" },
        },
        "required": ["user_id"],
        "additionalProperties": false,
    })
}

fn list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "journey_id": uuid("Only this journey's decisions."),
            "user_id": uuid("Only the decisions naming this member."),
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            "before_at": { "type": "string", "format": "date-time", "description": "next.assigned_at of the previous page." },
            "before_id": uuid("next.id of the previous page."),
        },
        "additionalProperties": false,
    })
}

fn backfill_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 200 } },
        "additionalProperties": false,
    })
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&distribution::get(deps, ctx).await?)
    })
}

fn rules_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: RulesSetInput = args(raw)?;
        to_json(&distribution::rules_set(deps, ctx, input).await?)
    })
}

fn rep_set<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id = raw
            .as_object_mut()
            .and_then(|o| o.remove("user_id"))
            .unwrap_or(Value::Null);
        let id: Uuid = args(id)?;
        let input: RepSetInput = args(raw)?;
        to_json(&distribution::rep_set(deps, ctx, UserId(id), input).await?)
    })
}

fn assignments_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: AssignmentsListInput = args(raw)?;
        to_json(&distribution::assignments_list(deps, ctx, input).await?)
    })
}

fn backfill<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: BackfillInput = args(raw)?;
        to_json(&distribution::backfill(deps, ctx, input).await?)
    })
}
