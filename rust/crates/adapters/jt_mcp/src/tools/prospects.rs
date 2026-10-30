//! `jeeta.prospects.*`: the prospect pool (spec `2026-10-30-leads-pool-outreach-design.md` §3,
//! §7.1). Agents research businesses with their own tools and record them here with evidence;
//! Jeeta stores, checks, dedupes and fences, and never researches. A prospect is never contacted
//! before it is promoted into the inbox.

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::Deps;
use jt_app::usecases::prospects::{
    self, CheckInput, DecideInput, DncInput, EraseInput, LiftInput, ListInput, SettingsInput,
};
use jt_prospects::{CreateInput, ProspectId, ScoreInput, UpdateInput};
use jt_tenancy::Permission;
use schemars::{Schema, json_schema};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "prospects.check",
            description: "Before researching a business in depth, check what you know of it \
                          (business_name with city, phone, email, website, instagram, tiktok; \
                          distinct_from: prospects you know it is not). Writes nothing. Answers \
                          {ok: true}, or {ok: false, reason, ...} with the refusal \
                          jeeta.prospects.create would meet: erased_identity, do_not_contact, \
                          previously_rejected, in_inbox (person_id), duplicate (prospect_id) or \
                          possible_duplicate (candidates). Skip the business on any of them. \
                          [risk: READ]",
            permission: Permission::ProspectsWork,
            schema: check_schema,
            run: check,
        },
        ToolDef {
            use_case: "prospects.create",
            description: "Record one business you researched with your own tools (never a \
                          private individual). Every contact field (phone, email, website, \
                          instagram, tiktok, address, contact_person) needs a public source URL \
                          where the business itself publishes it, and captured_at (when you saw \
                          it, within the last 365 days). Jeeta records you as the recorder. \
                          Answers {prospect} or CONFLICT with details.reason duplicate \
                          (prospect_id), possible_duplicate (candidates: resend with \
                          distinct_from naming them if this is another business), in_inbox \
                          (person_id: add a note to that person's journey instead), \
                          previously_rejected, daily_cap (scope, resets_at) or task_closed; \
                          FORBIDDEN with details.reason do_not_contact or erased_identity; \
                          VALIDATION with details.field and details.reason. A request_key \
                          replays the first answer for 24 hours. Read the playbook \
                          (jeeta.prospects.playbook) first. [risk: WRITE]",
            permission: Permission::ProspectsWork,
            schema: create_schema,
            run: create,
        },
        ToolDef {
            use_case: "prospects.update",
            description: "Correct or re-verify a new, qualified or rejected prospect \
                          (prospect_id) at its revision (expected_revision): set fields, each \
                          with new evidence as on create, clear fields that are wrong or no \
                          longer published (clear: field names), name prospects it is not \
                          (distinct_from). The business name and kind are not edited. New \
                          contact values meet create's checks. Answers {prospect}; CONFLICT \
                          stale_revision (revision: read it again), duplicate, \
                          possible_duplicate or not_editable. [risk: WRITE]",
            permission: Permission::ProspectsWork,
            schema: update_schema,
            run: update,
        },
        ToolDef {
            use_case: "prospects.list",
            description: "List the pool, newest first: filters status (new, qualified, \
                          rejected, promoted, do_not_contact), research_task_id, city, \
                          segment_key, bucket (0-24, 25-49, 50-74, 75-100: the latest score); \
                          limit 1 to 200 (50). Rows carry the business facts, which fields \
                          are recorded (fields), the latest score and the purge time, never \
                          contact values. Answers {items, next}: pass next.before_at and \
                          next.before_id back for the following page. [risk: READ]",
            permission: Permission::ProspectsWork,
            schema: list_schema,
            run: list,
        },
        ToolDef {
            use_case: "prospects.get",
            description: "Read one prospect (prospect_id) with every field's evidence, its \
                          latest scores, the prospects sharing its website or name and city \
                          (duplicate_candidates) and its ledger history. [risk: READ]",
            permission: Permission::ProspectsWork,
            schema: id_schema,
            run: get,
        },
        ToolDef {
            use_case: "prospects.score",
            description: "Score a new or qualified prospect (prospect_id) 0-100 with the \
                          approved strategy's rubric: one reason per criterion {criterion, \
                          points up to its weight, evidence: one sentence, source?}; the points \
                          add up to the score; rubric_digest is the digest the playbook gives. \
                          A score at or above the rubric's qualify_at qualifies a new prospect. \
                          Answers {score, status, qualified}; CONFLICT rubric_mismatch \
                          (current: read the playbook again), prospecting_off or not_scorable. \
                          [risk: WRITE]",
            permission: Permission::ProspectsWork,
            schema: score_schema,
            run: score,
        },
        ToolDef {
            use_case: "prospects.decide",
            description: "Decide a prospect (prospect_id) at its revision (expected_revision): \
                          qualify a new one, reject a new or qualified one with a reason \
                          (not_icp, closed_business, no_contact_data, competitor, \
                          already_customer, duplicate, other with a note), or reopen a \
                          rejection (a person with prospects.manage only). Answers {prospect}; \
                          CONFLICT invalid_transition or stale_revision. [risk: WRITE]",
            permission: Permission::ProspectsWork,
            schema: decide_schema,
            run: decide,
        },
        ToolDef {
            use_case: "prospects.do_not_contact",
            description: "A business asked not to be contacted: call this at once. With \
                          prospect_id the prospect becomes do_not_contact, its contact data is \
                          emptied and its keys stay only as hashes; with keys [{kind: phone, \
                          email, instagram, tiktok, domain or name_city (name|city), value}] \
                          (an objection heard by phone) the values are hashed. reason: \
                          objected, legal, other (with a note). Nobody can record it again \
                          until a person lifts it. Answers {prospect_id, kinds}. Requires \
                          confirm: true. [risk: DESTRUCTIVE]",
            permission: Permission::ProspectsWork,
            schema: dnc_schema,
            run: do_not_contact,
        },
        ToolDef {
            use_case: "prospects.dnc_lift",
            description: "Lift a do-not-contact entry: the kind and the raw value (the hash is \
                          computed again). A person with prospects.manage only; an agent is \
                          refused (human_only); an erasure is never lifted. Answers {kind, \
                          lifted}. [risk: WRITE]",
            permission: Permission::ProspectsManage,
            schema: lift_schema,
            run: dnc_lift,
        },
        ToolDef {
            use_case: "prospects.erase",
            description: "Erase a prospect now (prospect_id; a person with prospects.manage \
                          only): the row goes and every key it held is kept as an erased hash so \
                          it is never recorded again. A promoted prospect is erased with its \
                          person (CONFLICT erase_the_person). Answers {prospect_id, erased, \
                          kinds}. Requires confirm: true. [risk: DESTRUCTIVE]",
            permission: Permission::ProspectsManage,
            schema: erase_schema,
            run: erase,
        },
        ToolDef {
            use_case: "prospects.settings_get",
            description: "Read the pool's settings: timezone (the daily caps count in it), \
                          rejected_retention_days, unpromoted_retention_days, \
                          rejected_memory_days, max_promotions_per_day, \
                          agents_promote_qualified_only. [risk: READ]",
            permission: Permission::ProspectsWork,
            schema: schema_for::<NoArgs>,
            run: settings_get,
        },
        ToolDef {
            use_case: "prospects.settings_set",
            description: "Change the pool's settings (prospects.manage): any of timezone (IANA), \
                          rejected_retention_days and unpromoted_retention_days (1 to 730), \
                          rejected_memory_days (0 to 1095), max_promotions_per_day (1 to 1000), \
                          agents_promote_qualified_only; the others stay. Answers the settings. \
                          [risk: WRITE]",
            permission: Permission::ProspectsManage,
            schema: settings_schema,
            run: settings_set,
        },
    ]
}

fn uuid(description: &str) -> Value {
    json!({ "type": "string", "format": "uuid", "description": description })
}

fn text(max: usize, description: &str) -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": max, "description": description })
}

fn source() -> Value {
    json!({
        "description": "Where the value was seen: a public page (kind url), or a person's note (kind manual, people only).",
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "url" },
                    "url": { "type": "string", "format": "uri", "maxLength": 2048 },
                    "note": { "type": "string", "maxLength": 200 },
                },
                "required": ["kind", "url"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "manual" },
                    "note": { "type": "string", "minLength": 1, "maxLength": 200 },
                },
                "required": ["kind", "note"],
                "additionalProperties": false,
            },
        ],
    })
}

/// A recorded value with its evidence.
fn field(value: Value, description: &str) -> Value {
    json!({
        "type": "object",
        "description": description,
        "properties": {
            "value": value,
            "sources": { "type": "array", "minItems": 1, "maxItems": 5, "items": source() },
            "captured_at": { "type": "string", "format": "date-time", "description": "When you saw it: within the last 365 days." },
        },
        "required": ["value", "sources", "captured_at"],
        "additionalProperties": false,
    })
}

fn signals() -> Value {
    json!({
        "type": "array",
        "maxItems": 20,
        "description": "Why the business fits, each with where you saw it.",
        "items": {
            "type": "object",
            "properties": { "text": text(200, "One signal."), "source": source() },
            "required": ["text", "source"],
            "additionalProperties": false,
        },
    })
}

/// The settable fields, shared by create and update's `set`.
fn record_properties() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({
        "sector": text(80, "In the workspace's words, e.g. kafe."),
        "city": text(80, "The city."),
        "district": text(80, "The district."),
        "language": { "type": "string", "minLength": 2, "maxLength": 8, "description": "A BCP 47 primary tag: tr, en." },
        "segment_key": { "type": "string", "pattern": "^[a-z0-9_]{2,32}$", "description": "The ICP entry's audience segment." },
        "labels": { "type": "array", "maxItems": 20, "items": text(40, "A label.") },
        "phone": field(text(40, "As published."), "The business's published phone."),
        "email": field(text(254, "As published; never guessed."), "The business's published email."),
        "website": field(text(2048, "An http(s) URL of the business's own site, not a social profile."), "The website."),
        "instagram": field(text(120, "A handle or profile URL."), "The official Instagram account."),
        "tiktok": field(text(120, "A handle or profile URL."), "The official TikTok account."),
        "address": field(text(300, "The business address."), "The published address."),
        "contact_person": field(
            json!({
                "type": "object",
                "properties": { "name": text(120, "As the business publishes it."), "role": { "type": "string", "maxLength": 80 } },
                "required": ["name"],
                "additionalProperties": false,
            }),
            "A contact the business itself publishes: name and role only.",
        ),
        "size": field(
            json!({
                "type": "object",
                "properties": {
                    "branches": { "type": "integer", "minimum": 0, "maximum": 65535 },
                    "employees": { "type": "string", "enum": ["1-9", "10-49", "50-249", "250+"] },
                    "note": { "type": "string", "maxLength": 120 },
                },
                "additionalProperties": false,
            }),
            "How big it is.",
        ),
        "signals": signals(),
        "notes": { "type": "string", "maxLength": 2000, "description": "About the business, never about a person." },
    }) else {
        unreachable!("a JSON object")
    };
    map
}

fn create_schema() -> Schema {
    let mut properties = record_properties();
    let Value::Object(more) = json!({
        "business_name": text(200, "The business's name."),
        "entity_kind": { "type": "string", "enum": ["legal_entity", "sole_trader", "unknown_business"] },
        "country": { "type": "string", "minLength": 2, "maxLength": 2, "description": "ISO 3166-1 alpha-2, TR when left out." },
        "research_task_id": uuid("The research task you work on."),
        "discovered_at": { "type": "array", "maxItems": 5, "items": source(), "description": "Where you found the business (a directory, a search result)." },
        "distinct_from": { "type": "array", "items": uuid("A prospect this business is not."), "maxItems": 50 },
        "request_key": text(128, "Replays the first answer for 24 hours."),
    }) else {
        unreachable!("a JSON object")
    };
    properties.extend(more);
    json_schema!({
        "type": "object",
        "properties": properties,
        "required": ["business_name", "entity_kind"],
        "additionalProperties": false,
    })
}

fn field_names() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "string",
            "enum": ["sector", "city", "district", "language", "segment_key", "labels", "phone",
                     "email", "website", "instagram", "tiktok", "address", "contact_person",
                     "size", "signals", "notes"],
        },
    })
}

fn update_schema() -> Schema {
    let set = json!({
        "type": "object",
        "properties": record_properties(),
        "additionalProperties": false,
    });
    json_schema!({
        "type": "object",
        "properties": {
            "prospect_id": uuid("The prospect."),
            "expected_revision": { "type": "integer", "minimum": 1 },
            "set": set,
            "clear": field_names(),
            "distinct_from": { "type": "array", "items": uuid("A prospect this business is not."), "maxItems": 50 },
        },
        "required": ["prospect_id", "expected_revision"],
        "additionalProperties": false,
    })
}

fn check_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "business_name": text(200, "With city, checks the name and city."),
            "city": text(80, "The city."),
            "phone": text(40, "A phone."),
            "email": text(254, "An email."),
            "website": text(2048, "A website URL."),
            "instagram": text(120, "A handle or profile URL."),
            "tiktok": text(120, "A handle or profile URL."),
            "distinct_from": { "type": "array", "items": uuid("A prospect it is not."), "maxItems": 50 },
        },
        "additionalProperties": false,
    })
}

fn list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["new", "qualified", "rejected", "promoted", "do_not_contact"] },
            "research_task_id": uuid("Only this task's prospects."),
            "city": text(80, "The city, as recorded."),
            "segment_key": text(32, "The segment."),
            "bucket": { "type": "string", "enum": ["0-24", "25-49", "50-74", "75-100"] },
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
        "properties": { "prospect_id": uuid("The prospect.") },
        "required": ["prospect_id"],
        "additionalProperties": false,
    })
}

fn score_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "prospect_id": uuid("The prospect."),
            "score": { "type": "integer", "minimum": 0, "maximum": 100 },
            "reasons": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "criterion": text(32, "A criterion key of the rubric."),
                        "points": { "type": "integer", "minimum": 0, "maximum": 100 },
                        "evidence": text(300, "One sentence."),
                        "source": source(),
                    },
                    "required": ["criterion", "points", "evidence"],
                    "additionalProperties": false,
                },
            },
            "rubric_digest": text(64, "From the playbook."),
        },
        "required": ["prospect_id", "score", "reasons", "rubric_digest"],
        "additionalProperties": false,
    })
}

fn decide_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "prospect_id": uuid("The prospect."),
            "decision": { "type": "string", "enum": ["qualify", "reject", "reopen"] },
            "reason": { "type": "string", "enum": ["not_icp", "closed_business", "no_contact_data", "competitor", "already_customer", "duplicate", "other"] },
            "note": { "type": "string", "maxLength": 500 },
            "expected_revision": { "type": "integer", "minimum": 1 },
        },
        "required": ["prospect_id", "decision", "expected_revision"],
        "additionalProperties": false,
    })
}

fn key_kinds() -> Value {
    json!({ "type": "string", "enum": ["phone", "email", "instagram", "tiktok", "domain", "name_city"] })
}

fn dnc_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "confirm": { "type": "boolean", "description": "Must be true." },
            "prospect_id": uuid("The prospect, or give keys instead."),
            "keys": {
                "type": "array",
                "maxItems": 20,
                "items": {
                    "type": "object",
                    "properties": { "kind": key_kinds(), "value": text(400, "The raw value; name_city as name|city.") },
                    "required": ["kind", "value"],
                    "additionalProperties": false,
                },
            },
            "reason": { "type": "string", "enum": ["objected", "legal", "other"] },
            "note": { "type": "string", "maxLength": 500 },
        },
        "required": ["confirm", "reason"],
        "additionalProperties": false,
    })
}

fn lift_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "kind": key_kinds(), "value": text(400, "The raw value.") },
        "required": ["kind", "value"],
        "additionalProperties": false,
    })
}

fn erase_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "prospect_id": uuid("The prospect."), "confirm": { "type": "boolean", "description": "Must be true." } },
        "required": ["prospect_id", "confirm"],
        "additionalProperties": false,
    })
}

fn settings_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "timezone": text(64, "An IANA time zone, e.g. Europe/Istanbul."),
            "rejected_retention_days": { "type": "integer", "minimum": 1, "maximum": 730 },
            "unpromoted_retention_days": { "type": "integer", "minimum": 1, "maximum": 730 },
            "rejected_memory_days": { "type": "integer", "minimum": 0, "maximum": 1095 },
            "max_promotions_per_day": { "type": "integer", "minimum": 1, "maximum": 1000 },
            "agents_promote_qualified_only": { "type": "boolean" },
        },
        "additionalProperties": false,
    })
}

/// Takes `key` out of the arguments as the prospect's id; the rest is the body.
fn split(mut raw: Value, key: &str) -> Result<(ProspectId, Value), AppError> {
    let id = raw
        .as_object_mut()
        .and_then(|o| o.remove(key))
        .unwrap_or(Value::Null);
    let id: Uuid = args(id)?;
    Ok((ProspectId(id), raw))
}

fn check<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: CheckInput = args(raw)?;
        to_json(&prospects::check(deps, ctx, input).await?)
    })
}

fn create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: CreateInput = args(raw)?;
        to_json(&prospects::create(deps, ctx, input).await?)
    })
}

fn update<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "prospect_id")?;
        let input: UpdateInput = args(rest)?;
        to_json(&prospects::update(deps, ctx, id, input).await?)
    })
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: ListInput = args(raw)?;
        to_json(&prospects::list(deps, ctx, input).await?)
    })
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "prospect_id")?;
        let NoArgs {} = args(rest)?;
        to_json(&prospects::get(deps, ctx, id).await?)
    })
}

fn score<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "prospect_id")?;
        let input: ScoreInput = args(rest)?;
        to_json(&prospects::score(deps, ctx, id, input).await?)
    })
}

fn decide<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "prospect_id")?;
        let input: DecideInput = args(rest)?;
        to_json(&prospects::decide(deps, ctx, id, input).await?)
    })
}

fn do_not_contact<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: DncInput = args(raw)?;
        to_json(&prospects::do_not_contact(deps, ctx, input).await?)
    })
}

fn dnc_lift<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: LiftInput = args(raw)?;
        to_json(&prospects::dnc_lift(deps, ctx, input).await?)
    })
}

fn erase<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "prospect_id")?;
        let input: EraseInput = args(rest)?;
        to_json(&prospects::erase(deps, ctx, id, input).await?)
    })
}

fn settings_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&prospects::settings_get(deps, ctx).await?)
    })
}

fn settings_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: SettingsInput = args(raw)?;
        to_json(&prospects::settings_set(deps, ctx, input).await?)
    })
}
