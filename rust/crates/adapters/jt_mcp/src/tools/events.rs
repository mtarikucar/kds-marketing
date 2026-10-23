//! `jeeta.events.pending`, `jeeta.events.ack` and `jeeta.events.list`: what the workspace's
//! connections brought in (messages, delivery statuses, leads, calls, consent changes), for the
//! agent to read and acknowledge until later milestones turn events into conversations and
//! measurements.
//!
//! Reading needs `workspace.read`; acknowledging needs `capabilities.manage`. The arguments are
//! the panel's queries and body, read by the same types (unknown fields are refused), and the
//! outputs are the panel's JSON: a page `{events, next}` and `{acked}`. No output carries an
//! event's raw body.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::events::{self, Ack, List, MAX_ACK_IDS, MAX_EVENT_LIMIT, Pending};
use jt_connector::Provider;
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde_json::Value;
use uuid::Uuid;

use super::{ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "events.pending",
            description: "Read the inbound events not yet acknowledged (messages, delivery \
                          statuses, leads, calls, consent changes that webhooks and polls \
                          brought in), oldest first, at most limit (default 50, at most 200). \
                          Each has id, provider, capability_id, external_id, kind, payload (the \
                          provider's item, with occurred_at when known), received_at and \
                          processed_at. Returns {events, next}: when next is not null, pass its \
                          after_at and after_id for the following page. Acknowledge each event \
                          you have handled with jeeta.events.ack. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<PendingArgs>,
            run: pending,
        },
        ToolDef {
            use_case: "events.ack",
            description: "Acknowledge inbound events you have handled: ids lists 1 to 200 event \
                          ids from jeeta.events.pending. They are marked processed and leave the \
                          pending list; one already acknowledged keeps its time and is not \
                          counted again. All or nothing: an id that is not one of the \
                          workspace's events is NOT_FOUND and nothing is marked. Returns \
                          {acked}: how many were newly marked. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<AckArgs>,
            run: ack,
        },
        ToolDef {
            use_case: "events.list",
            description: "Read the workspace's inbound events, newest first, acknowledged ones \
                          included unless include_processed is false, optionally of one provider \
                          (meta, netgsm, x) or one kind (message, message_echo, status, \
                          lead_gen, call_event, consent), at most limit (default 50, at most \
                          200). Returns {events, next}: when next is not null, pass its \
                          before_at and before_id for the older page. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<ListArgs>,
            run: list,
        },
    ]
}

/// The schema of `jeeta.events.pending`; the arguments are read as the panel's query is
/// ([`Pending`]).
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct PendingArgs {
    /// At most this many events: 1 to 200, default 50.
    #[schemars(range(min = 1, max = MAX_EVENT_LIMIT))]
    limit: Option<u32>,
    /// The received_at of the previous page's last event (next.after_at); given together with
    /// after_id.
    #[serde(default)]
    #[schemars(schema_with = "super::optional_date_time_schema")]
    after_at: Option<String>,
    /// The id of the previous page's last event (next.after_id); given together with after_at.
    after_id: Option<Uuid>,
}

/// The schema of `jeeta.events.list`; the arguments are read as [`List`].
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ListArgs {
    /// At most this many events: 1 to 200, default 50.
    #[schemars(range(min = 1, max = MAX_EVENT_LIMIT))]
    limit: Option<u32>,
    /// The received_at of the previous page's last event (next.before_at); given together with
    /// before_id.
    #[serde(default)]
    #[schemars(schema_with = "super::optional_date_time_schema")]
    before_at: Option<String>,
    /// The id of the previous page's last event (next.before_id); given together with
    /// before_at.
    before_id: Option<Uuid>,
    /// Include acknowledged events; true unless set.
    include_processed: Option<bool>,
    /// Only events of this kind: message, message_echo, status, lead_gen, call_event, consent
    /// (or another kind as stored).
    kind: Option<String>,
    /// Only events of this provider.
    #[serde(default)]
    #[schemars(schema_with = "provider_schema")]
    provider: Option<String>,
}

/// The schema of `jeeta.events.ack`; the arguments are read as [`Ack`].
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct AckArgs {
    /// The ids of the events handled, from jeeta.events.pending.
    #[schemars(length(min = 1, max = MAX_ACK_IDS))]
    ids: Vec<Uuid>,
}

/// The JSON Schema of an optional provider, naming every provider there is.
fn provider_schema(_: &mut SchemaGenerator) -> Schema {
    let keys: Vec<&str> = Provider::all().iter().map(Provider::key).collect();
    json_schema!({ "type": ["string", "null"], "enum": keys })
}

fn pending<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: Pending = args(raw)?;
        to_json(&events::pending(deps, ctx, input).await?)
    })
}

fn ack<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: Ack = args(raw)?;
        to_json(&events::ack(deps, ctx, input).await?)
    })
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: List = args(raw)?;
        to_json(&events::list(deps, ctx, input).await?)
    })
}
