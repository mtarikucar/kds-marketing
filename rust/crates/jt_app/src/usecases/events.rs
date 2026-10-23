//! The workspace's inbound events (spec §4.4, §11): `events.pending`, `events.list` and
//! `events.ack`.
//!
//! An inbound event is what a webhook or a poll brought in through one of the workspace's
//! connections (a message, a delivery status, a lead, a call, a consent change), stored once per
//! provider id ([`super::webhook`]). Until the milestones that turn events into conversations
//! and measurements consume them, an agent reads them here and acknowledges each one it has
//! handled; `work.pending` lists them while any is unprocessed.
//!
//! - **`events.pending`** reads the unprocessed events **oldest first** (a queue is worked in the
//!   order it filled, so a steady inflow never starves the oldest), a page at a time; the next
//!   page starts after the previous page's last event (`after_at`, `after_id`, which the page
//!   answers in `next`).
//! - **`events.list`** reads every event, processed ones included unless asked otherwise,
//!   **newest first**, a page at a time back (`before_at`, `before_id`), optionally of one
//!   provider or one kind.
//! - **`events.ack`** marks events processed. Marking is once: an event already processed keeps
//!   its time and does not count again.
//!
//! An event is answered as [`InboundEventOut`]: its parsed payload (with what the provider
//! adapters scrub at parse time already scrubbed), **never the raw body**, which no read of the
//! repository gives back; the raw body stays beside the event for 30 days, for support only.
//!
//! **Gates.** Exempt from the strategy gate (events are observation, not work the strategy
//! plans), subject to the workspace-status check. Reading needs `workspace.read`; acknowledging
//! changes the workspace's records and needs `capabilities.manage`, the permission that governs
//! the connections the events arrive through (there is no lighter write permission).

use std::collections::BTreeSet;

use jt_capability::CapabilityId;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::capabilities::{append, version_in_force};
use super::{Deps, invalid};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{EventOrder, EventQuery};

/// The page size when the caller names none.
pub const DEFAULT_EVENT_LIMIT: u32 = 50;
/// The largest page; a larger `limit` is clamped to it (and `0` reads as 1).
pub const MAX_EVENT_LIMIT: u32 = 200;
/// The most ids one `events.ack` takes.
pub const MAX_ACK_IDS: usize = 200;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/// `events.pending`: at most `limit` unprocessed events, after the event `(after_at, after_id)`
/// (both or neither). The panel's query and the MCP tool's arguments alike; an unknown field is
/// refused.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    /// Default [`DEFAULT_EVENT_LIMIT`], clamped to `1..=`[`MAX_EVENT_LIMIT`].
    #[serde(default)]
    pub limit: Option<u32>,
    /// The `received_at` of the previous page's last event (RFC 3339).
    #[serde(default)]
    pub after_at: Option<String>,
    /// The `id` of the previous page's last event.
    #[serde(default)]
    pub after_id: Option<InboundEventId>,
}

/// `events.list`: at most `limit` events, before the event `(before_at, before_id)` (both or
/// neither), processed ones included unless `include_processed` is `false`, of one provider or
/// one kind when named. The panel's query and the MCP tool's arguments alike.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    /// Default [`DEFAULT_EVENT_LIMIT`], clamped to `1..=`[`MAX_EVENT_LIMIT`].
    #[serde(default)]
    pub limit: Option<u32>,
    /// The `received_at` of the previous page's last event (RFC 3339).
    #[serde(default)]
    pub before_at: Option<String>,
    /// The `id` of the previous page's last event.
    #[serde(default)]
    pub before_id: Option<InboundEventId>,
    /// Missing reads as `true`.
    #[serde(default)]
    pub include_processed: Option<bool>,
    /// Only events of this kind (`message`, `message_echo`, `status`, `lead_gen`,
    /// `call_event`, `consent`, or another key as stored).
    #[serde(default)]
    pub kind: Option<EventKind>,
    /// Only events of this provider (`meta`, `netgsm`, `x`).
    #[serde(default)]
    pub provider: Option<Provider>,
}

/// `events.ack`: the events to mark processed, 1 to [`MAX_ACK_IDS`] ids (a repeated id counts
/// once).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ack {
    pub ids: Vec<InboundEventId>,
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

/// An inbound event as it may be shown: never its raw body.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InboundEventOut {
    pub id: InboundEventId,
    pub provider: Provider,
    /// The capability it arrived through, when known.
    pub capability_id: Option<CapabilityId>,
    /// The provider's id of the event (a `wamid`, a `mid`, `netgsm-mo:<gorevid>`, …).
    pub external_id: String,
    pub kind: EventKind,
    /// The provider's item, as its adapter parsed it (each adapter documents its own), plus
    /// `occurred_at` when the provider said when it happened.
    pub payload: Value,
    #[serde(with = "time::serde::rfc3339")]
    pub received_at: OffsetDateTime,
    /// When it was acknowledged; `None` while pending.
    #[serde(with = "time::serde::rfc3339::option")]
    pub processed_at: Option<OffsetDateTime>,
}

impl From<InboundEvent> for InboundEventOut {
    fn from(e: InboundEvent) -> Self {
        InboundEventOut {
            id: e.id,
            provider: e.provider,
            capability_id: e.capability_id,
            external_id: e.external_id,
            kind: e.kind,
            payload: e.payload,
            received_at: e.received_at,
            processed_at: e.processed_at,
        }
    }
}

/// One page of events and where the next one starts: `next` is `None` on the last page, else the
/// cursor to send back as it reads.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EventPage<C> {
    pub events: Vec<InboundEventOut>,
    pub next: Option<C>,
}

/// Where the next page of `events.pending` starts: after this event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AfterCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub after_at: OffsetDateTime,
    pub after_id: InboundEventId,
}

/// Where the next page of `events.list` starts: before this event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BeforeCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub before_at: OffsetDateTime,
    pub before_id: InboundEventId,
}

/// How many events an `events.ack` newly marked processed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AckOut {
    pub acked: u32,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// One page of the context's unprocessed events, oldest (`received_at`, then id) first, after the
/// cursor when one is given. Needs `workspace.read`. A cursor half without the other, or an
/// `after_at` that is not RFC 3339, is `VALIDATION` naming the field.
pub async fn pending(
    deps: &Deps,
    ctx: &Ctx,
    input: Pending,
) -> Result<EventPage<AfterCursor>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let after = cursor(
        ("after_at", "after_id"),
        input.after_at.as_deref(),
        input.after_id,
    )?;
    let limit = page_size(input.limit);
    let query = EventQuery {
        pending_only: true,
        provider: None,
        kind: None,
        order: EventOrder::OldestFirst { after },
        limit: limit + 1,
    };
    let (events, last) = read_page(deps, ctx, query, limit).await?;
    Ok(EventPage {
        events,
        next: last.map(|(after_at, after_id)| AfterCursor { after_at, after_id }),
    })
}

/// One page of the context's events, newest (`received_at`, then id, both descending) first,
/// before the cursor when one is given; processed ones too unless `include_processed` is `false`;
/// of one provider or one kind when named. Needs `workspace.read`. Cursor errors as
/// [`pending`]'s, for `before_at` and `before_id`.
pub async fn list(
    deps: &Deps,
    ctx: &Ctx,
    input: List,
) -> Result<EventPage<BeforeCursor>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let before = cursor(
        ("before_at", "before_id"),
        input.before_at.as_deref(),
        input.before_id,
    )?;
    let limit = page_size(input.limit);
    let query = EventQuery {
        pending_only: input.include_processed == Some(false),
        provider: input.provider,
        kind: input.kind,
        order: EventOrder::NewestFirst { before },
        limit: limit + 1,
    };
    let (events, last) = read_page(deps, ctx, query, limit).await?;
    Ok(EventPage {
        events,
        next: last.map(|(before_at, before_id)| BeforeCursor {
            before_at,
            before_id,
        }),
    })
}

/// Marks the events `input.ids` processed at `ctx.now` and answers how many it newly marked (an
/// event already processed keeps its time and does not count). Needs `capabilities.manage`.
///
/// No id, or more than [`MAX_ACK_IDS`], is `VALIDATION` naming `ids`. All or nothing: an id
/// that is not one of the workspace's events is `NOT_FOUND` naming it in `details.id`, and then
/// nothing is marked.
///
/// Writes `events.acked` about the workspace's events (`subject.kind = "inbound_events"`, its id
/// the workspace's; payload `n`, how many were newly marked) when it marked any; acknowledging
/// only events already processed writes nothing.
pub async fn ack(deps: &Deps, ctx: &Ctx, input: Ack) -> Result<AckOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    if input.ids.is_empty() || input.ids.len() > MAX_ACK_IDS {
        return Err(invalid(
            "ids",
            &format!("ids must hold 1 to {MAX_ACK_IDS} event ids"),
        ));
    }
    // Each id once, in the order first given.
    let mut seen = BTreeSet::new();
    let ids: Vec<InboundEventId> = input
        .ids
        .into_iter()
        .filter(|id| seen.insert(*id))
        .collect();

    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut acked: u32 = 0;
    for id in ids {
        let marked = repos
            .inbound_events()
            .mark_processed(id, ctx.now)
            .await
            .map_err(|e| match e.code {
                ErrorCode::NotFound => AppError {
                    details: json!({ "id": id }),
                    ..e
                },
                _ => e,
            })?;
        acked += u32::from(marked);
    }
    if acked > 0 {
        let in_force = version_in_force(repos.as_mut()).await?;
        append(
            repos.as_mut(),
            ctx,
            "events.acked",
            "inbound_events",
            ctx.workspace_id,
            in_force,
            json!({ "n": acked }),
        )
        .await?;
        repos.commit().await?;
    }
    Ok(AckOut { acked })
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// `limit`, defaulted and clamped.
fn page_size(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_EVENT_LIMIT)
}

/// Reads `query` (which asks one event more than `limit`, to know whether another page follows)
/// and answers at most `limit` events and, when more follow, the key of the last one answered.
async fn read_page(
    deps: &Deps,
    ctx: &Ctx,
    query: EventQuery,
    limit: u32,
) -> Result<
    (
        Vec<InboundEventOut>,
        Option<(OffsetDateTime, InboundEventId)>,
    ),
    AppError,
> {
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let mut events = repos.inbound_events().list(query).await?;
    let more = events.len() > limit as usize;
    events.truncate(limit as usize);
    let last = more
        .then(|| events.last().map(|e| (e.received_at, e.id)))
        .flatten();
    Ok((
        events.into_iter().map(InboundEventOut::from).collect(),
        last,
    ))
}

/// A key-set cursor from its two halves, named `fields` (the time's, the id's): both or neither,
/// else `VALIDATION` naming the missing one; a time that is not RFC 3339 is `VALIDATION` naming
/// it.
fn cursor(
    (at_field, id_field): (&str, &str),
    at: Option<&str>,
    id: Option<InboundEventId>,
) -> Result<Option<(OffsetDateTime, InboundEventId)>, AppError> {
    match (at, id) {
        (None, None) => Ok(None),
        (Some(at), Some(id)) => {
            let at = OffsetDateTime::parse(at, &Rfc3339).map_err(|_| {
                invalid(
                    at_field,
                    &format!(
                        "{at_field} must be an RFC 3339 time, as an event's received_at reads"
                    ),
                )
            })?;
            Ok(Some((at, id)))
        }
        (Some(_), None) => Err(invalid(
            id_field,
            &format!("{id_field} must come with {at_field}"),
        )),
        (None, Some(_)) => Err(invalid(
            at_field,
            &format!("{at_field} must come with {id_field}"),
        )),
    }
}
