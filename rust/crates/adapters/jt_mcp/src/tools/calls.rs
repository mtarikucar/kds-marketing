//! `jeeta.calls.*`: the workspace's phone calls (spec `2026-10-27-agent-voice-calls-design.md`
//! §7). An agent reads and sets the call policy, places a rep's call (the rep's PBX extension
//! rings first, then the person) or a call it talks on itself through the workspace's voice
//! bridge (`listen`, `say`, `transfer`, turn by turn), reads the call log and records how a call
//! went. Phone numbers are masked in every output of these tools.

use jt_app::ctx::Ctx;
use jt_app::ports::calls::CallId;
use jt_app::usecases::Deps;
use jt_app::usecases::calls::listen::{self, ListenQuery};
use jt_app::usecases::calls::say::{self, SayInput, TransferInput};
use jt_app::usecases::calls::{self, EndInput, ListQuery, PlaceInput, PolicyInput};
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "calls.policy_get",
            description: "Read the workspace's call policy: greeting_inbound, voicemail_text, \
                          recording_announcement, disclose_assistant and disclosure_sentence \
                          (the sentence every agent-driven opening must contain), \
                          holding_default, the timers (slow_agent_s, holding_again_s, \
                          fallback_after_s, caller_silence_s, caller_silence_close_s), \
                          max_duration_s, handoff_extension and estimated_minor_per_minute (the \
                          tariff per started minute, 0 when unknown). [risk: READ]",
            permission: Permission::CallsWork,
            schema: schema_for::<NoArgs>,
            run: policy_get,
        },
        ToolDef {
            use_case: "calls.policy_set",
            description: "Replace the workspace's call policy with the given one (every field \
                          as jeeta.calls.policy_get returns it; a field left out takes its \
                          default). Only a person may turn disclose_assistant off (FORBIDDEN \
                          for you). Returns the stored policy. [risk: WRITE]",
            permission: Permission::CallsManage,
            schema: policy_schema,
            run: policy_set,
        },
        ToolDef {
            use_case: "calls.place",
            description: "Place a phone call to a person (person_id, or phone: a number one of \
                          the workspace's people holds) for a purpose: commercial (needs IYS \
                          consent on the phone channel), service (needs an existing \
                          relationship: a won journey, or an appointment or quote in the last \
                          180 days, or an open appointment) or callback (needs an inbound call \
                          in the last 7 days). mode human rings the rep's PBX extension \
                          (rep_extension) first, then the person, through the workspace's \
                          verified NetGSM PBX. mode agent: you talk to the person yourself \
                          through the workspace's voice bridge, with a plan written before you \
                          dial: opening (must contain the policy's disclosure_sentence), goal \
                          (never played), holding (1 to 5 phrases played while you think), \
                          fallback (0 to 3 lines played when you stay silent), closing (played \
                          before the call is hung up), max_duration_s (1 to 900), language tr; \
                          every sentence at most 600 characters. One live agent call per \
                          connection. Then loop jeeta.calls.listen and jeeta.calls.say. Every \
                          gate is checked again right before dialing: a refusal is CONFLICT \
                          with details.reason one of workspace_inactive, strategy_required, \
                          bridge_offline, bridge_busy, person_erased, person_merged, \
                          no_phone_identity, suppressed, journey_lost, consent_missing, \
                          no_relationship, no_recent_inbound, outside_work_hours, \
                          daily_ops_cap, budget_exhausted, disclosure_missing. Returns {call, \
                          turns}; the number is masked. After the call, record its outcome \
                          with jeeta.calls.end. [risk: SPEND]",
            permission: Permission::CallsWork,
            schema: place_schema,
            run: place,
        },
        ToolDef {
            use_case: "calls.listen",
            description: "Wait for what happens on your call: answers as soon as there are \
                          turns after after_seq (the person's words, a sentence played, a \
                          holding phrase, caller_silence, the hangup), or the call ended; \
                          otherwise after wait_s seconds (at most 25) with timed_out true, and \
                          you listen again with the same after_seq. Returns {call_id, state, \
                          events: [{seq, at, kind, text, meta}], timed_out}; pass the last \
                          event's seq as after_seq next time. After the person speaks, reply \
                          with jeeta.calls.say within 10 seconds: after 4 s the caller hears a \
                          holding phrase, after 20 s a fallback line from your plan, and the \
                          call ends by script once the fallback lines are spent. [risk: READ]",
            permission: Permission::CallsWork,
            schema: listen_schema,
            run: listen,
        },
        ToolDef {
            use_case: "calls.say",
            description: "Say a sentence (text, at most 600 characters) to the person on your \
                          live call; the voice bridge speaks it as you wrote it. expect_reply \
                          (default true): false when you will speak again before the person \
                          answers. allow_barge_in (default true): the person may cut it by \
                          speaking (the turn then records interrupted_at_char). Reply within \
                          10 seconds of the person's words: after 4 s the caller hears a \
                          holding phrase, after 20 s a fallback line from your plan, and the \
                          call ends by script. CONFLICT not_live once the call ended. Returns \
                          {call_id, seq, state}. [risk: WRITE]",
            permission: Permission::CallsWork,
            schema: say_schema,
            run: say,
        },
        ToolDef {
            use_case: "calls.transfer",
            description: "Hand the person on your live call over to a rep: to_extension (the \
                          rep's PBX extension; the policy's handoff_extension when left out). \
                          Your part of the call ends at once (transferred); the line goes on \
                          with the rep. Returns {call, turns}. [risk: WRITE]",
            permission: Permission::CallsWork,
            schema: transfer_schema,
            run: transfer,
        },
        ToolDef {
            use_case: "calls.get",
            description: "Read one call: its session (state, purpose, mode, times, end cause, \
                          outcome, duration, cost, recording) and its turns. The number is \
                          masked. [risk: READ]",
            permission: Permission::CallsWork,
            schema: schema_for::<CallArgs>,
            run: get,
        },
        ToolDef {
            use_case: "calls.list",
            description: "List the workspace's calls, newest first, optionally only a person's \
                          (person_id), in a state, of a direction (inbound, outbound) or since \
                          a time; limit 1 to 200 (50). Numbers are masked. Returns {calls: \
                          [...]}. [risk: READ]",
            permission: Permission::CallsWork,
            schema: schema_for::<ListArgs>,
            run: list,
        },
        ToolDef {
            use_case: "calls.end",
            description: "Record how a call went: outcome connected, no_answer, voicemail, \
                          refused_by_customer, appointment, callback_requested or other; an \
                          optional summary (at most 2000 characters, kept as a journey note) \
                          and follow_up_task {title, due_at}. A call still on the line is \
                          ended (your call hears its plan's closing first). The person's \
                          journey gets the call; with a known duration and a tariff the spend \
                          is recorded on the line's budget item. Ending twice changes nothing. \
                          Returns {call, turns}. [risk: WRITE]",
            permission: Permission::CallsWork,
            schema: end_schema,
            run: end,
        },
    ]
}

/// A call.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CallArgs {
    /// The call id, from jeeta.calls.list or jeeta.calls.place.
    call_id: Uuid,
}

/// The schema of `jeeta.calls.list`; read as [`ListQuery`].
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ListArgs {
    /// Only this person's calls.
    person_id: Option<Uuid>,
    /// planned, dialing, ringing, live, holding, ending or ended.
    #[schemars(schema_with = "state_schema")]
    state: Option<String>,
    /// inbound or outbound.
    #[schemars(schema_with = "direction_schema")]
    direction: Option<String>,
    /// RFC 3339: only calls started at or after it.
    since: Option<String>,
    /// 1 to 200.
    #[schemars(range(min = 1, max = 200))]
    limit: Option<u32>,
}

fn state_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "enum": ["planned", "dialing", "ringing", "live", "holding", "ending", "ended"] })
}

fn direction_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "enum": ["inbound", "outbound"] })
}

fn text(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn seconds(description: &str) -> Value {
    json!({ "type": "integer", "minimum": 1, "description": description })
}

fn policy_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "greeting_inbound": text("Played when an agent on duty answers an inbound call."),
            "voicemail_text": text("Played before a voicemail is recorded."),
            "recording_announcement": text("Played before anything is recorded."),
            "disclose_assistant": { "type": "boolean" },
            "disclosure_sentence": text("The sentence an agent-driven opening must contain."),
            "holding_default": { "type": "array", "maxItems": 5, "items": { "type": "string" } },
            "max_duration_s": { "type": "integer", "minimum": 1, "maximum": 900 },
            "slow_agent_s": seconds("Agent silence before the first holding phrase."),
            "holding_again_s": seconds("Agent silence before the second holding phrase."),
            "fallback_after_s": seconds("Agent silence before the next fallback line."),
            "caller_silence_s": seconds("Caller silence before you are told."),
            "caller_silence_close_s": seconds("Caller silence before the scripted closing."),
            "handoff_extension": { "type": ["string", "null"], "pattern": "^[0-9]{1,16}$" },
            "estimated_minor_per_minute": { "type": "integer", "minimum": 0 },
        },
        "additionalProperties": false,
    })
}

fn place_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "person_id": { "type": "string", "format": "uuid" },
            "phone": text("A phone number one of the workspace's people holds."),
            "journey_id": { "type": "string", "format": "uuid" },
            "purpose": { "type": "string", "enum": ["service", "commercial", "callback"] },
            "mode": { "type": "string", "enum": ["human", "agent"] },
            "rep_extension": { "type": "string", "pattern": "^[0-9]{1,16}$" },
            "capability_id": { "type": "string", "format": "uuid", "description": "The netgsm_pbx (mode human) or voice_bridge (mode agent) capability; the only live one when left out." },
            "plan": {
                "type": "object",
                "description": "Mode agent only: the call's script, every sentence played as written.",
                "properties": {
                    "opening": text("Played when the person answers; must contain the policy's disclosure_sentence."),
                    "goal": text("What the call is for; never played."),
                    "holding": { "type": "array", "minItems": 1, "maxItems": 5, "items": { "type": "string", "maxLength": 600 } },
                    "fallback": { "type": "array", "maxItems": 3, "items": { "type": "string", "maxLength": 600 } },
                    "closing": text("Played before the call is hung up."),
                    "max_duration_s": { "type": "integer", "minimum": 1, "maximum": 900 },
                    "language": { "type": "string", "enum": ["tr"] },
                    "disclose_assistant": { "type": "boolean" },
                },
                "required": ["opening", "goal", "holding", "closing", "max_duration_s"],
                "additionalProperties": false,
            },
        },
        "required": ["purpose", "mode"],
        "additionalProperties": false,
    })
}

fn listen_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "call_id": { "type": "string", "format": "uuid" },
            "after_seq": { "type": "integer", "minimum": 0, "description": "The last event's seq you saw; every turn when left out." },
            "wait_s": { "type": "integer", "minimum": 0, "maximum": 25, "description": "How long to wait for a turn (25 when left out)." },
        },
        "required": ["call_id"],
        "additionalProperties": false,
    })
}

fn say_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "call_id": { "type": "string", "format": "uuid" },
            "text": { "type": "string", "minLength": 1, "maxLength": 600 },
            "expect_reply": { "type": "boolean" },
            "allow_barge_in": { "type": "boolean" },
        },
        "required": ["call_id", "text"],
        "additionalProperties": false,
    })
}

fn transfer_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "call_id": { "type": "string", "format": "uuid" },
            "to_extension": { "type": "string", "pattern": "^[0-9]{1,16}$" },
        },
        "required": ["call_id"],
        "additionalProperties": false,
    })
}

fn end_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "call_id": { "type": "string", "format": "uuid" },
            "outcome": { "type": "string", "enum": ["connected", "no_answer", "voicemail", "refused_by_customer", "appointment", "callback_requested", "other"] },
            "summary": { "type": "string", "maxLength": 2000 },
            "follow_up_task": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "due_at": { "type": "string", "format": "date-time" },
                },
                "required": ["title", "due_at"],
                "additionalProperties": false,
            },
        },
        "required": ["call_id", "outcome"],
        "additionalProperties": false,
    })
}

/// `raw` without its `call_id`, which names the call; the call id.
fn split_call(mut raw: Value) -> Result<(CallId, Value), jt_app::error::AppError> {
    let id = raw
        .as_object_mut()
        .and_then(|o| o.remove("call_id"))
        .unwrap_or(Value::Null);
    let id: Uuid = args(id)?;
    Ok((CallId(id), raw))
}

fn policy_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&calls::policy_get(deps, ctx).await?)
    })
}

fn policy_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: PolicyInput = args(raw)?;
        to_json(&calls::policy_set(deps, ctx, input).await?)
    })
}

fn place<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: PlaceInput = args(raw)?;
        to_json(&calls::place(deps, ctx, input).await?)
    })
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CallArgs { call_id } = args(raw)?;
        to_json(&calls::get(deps, ctx, CallId(call_id)).await?)
    })
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query: ListQuery = args(raw)?;
        listed("calls", &calls::list(deps, ctx, query).await?)
    })
}

fn listen<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split_call(raw)?;
        let query: ListenQuery = args(rest)?;
        to_json(&listen::listen(deps, ctx, id, query).await?)
    })
}

fn say<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split_call(raw)?;
        let input: SayInput = args(rest)?;
        to_json(&say::say(deps, ctx, id, input).await?)
    })
}

fn transfer<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split_call(raw)?;
        let input: TransferInput = args(rest)?;
        to_json(&say::transfer(deps, ctx, id, input).await?)
    })
}

fn end<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split_call(raw)?;
        let input: EndInput = args(rest)?;
        to_json(&calls::end(deps, ctx, id, input).await?)
    })
}
