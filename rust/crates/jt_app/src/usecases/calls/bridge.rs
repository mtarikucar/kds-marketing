//! The voice bridge's surface (spec `2026-10-27-agent-voice-calls-design.md` §10, phase V1): the
//! sidecar that is the workspace's phone line for agent calls registers itself every
//! [`HEARTBEAT_S`] seconds ([`register`], its heartbeat), takes the commands queued for its calls
//! ([`commands`], a long-poll of at most [`MAX_WAIT_S`] seconds) and reports what happened on them
//! ([`events`]). The catalog serves these to the bridge only: no MCP tool, no panel session. What
//! it does as every bridge does (who may call as it, its heartbeat, its health, its long-poll) is
//! the bridge kernel's ([`crate::usecases::bridges::kernel`]), with [`VOICE_BRIDGE`] as its spec;
//! what is the voice bridge's own stays here: the facts it reports, its capability per extension,
//! its command queue and its events.
//!
//! **Who.** The bridge calls with an API key issued with `calls.bridge` and nothing else
//! ([`ctx_for_bridge`]); every use case here refuses any other caller, a person or an agent whose
//! key holds every permission included (`FORBIDDEN`, `details.reason = "bridge_key_only"`): the
//! bridge is handed the numbers it dials, which no agent's output shows. It acts as the system
//! (`Actor::System { component: "voice_bridge" }`), never through an agent connection, so its
//! heartbeat never reads as an agent checking in.
//!
//! **Heartbeat.** A registration verifies the bridge's `voice_bridge` capability (declaring it on
//! the first one, the extension as its external id) and keeps what the bridge reported of itself
//! under `connector_public.bridge`; `last_verified_at` is the heartbeat. The capability reads
//! stale a minute after it (`jt_capability::Heartbeat`) and the `voice_bridge_health` job marks it
//! unreachable ten minutes after it. A registration that brings it back from any other status
//! writes `calls.bridge.online`.
//!
//! **Commands.** A poll leases its bridge's oldest commands that are not acknowledged; one that
//! is not acknowledged (an event `command_done{id}`) within [`REDELIVER_AFTER`] of being taken is
//! handed out again, so no command is lost; the bridge acts on a command id once, however often it
//! is handed it. While none is due the poll waits: a command queued in this server wakes it at
//! once (the calls' signals, `crate::ports::bridges::BridgeSignals`), and it looks again at least
//! every [`kernel::FALLBACK_TICK`] (what another instance queued, a lease running out).
//!
//! **Events.** A batch is applied call by call, in each call's `bridge_seq` order, each event at
//! most once by its `(bridge_call_id, bridge_seq)`: a retried batch changes nothing. An event is
//! applied to its session with `jt_calls::reduce` (its turns appended, the caller's cut of a
//! played sentence marked on that sentence's turn, the commands it yields queued for the bridge).
//! A call's answer writes `calls.answered`; its end (the caller hung up, the line failed) settles
//! it as every end of an agent's call is settled (`super::settle`: the journey's `CallMade`, the
//! spend, `calls.ended`). An event of a call that is not an agent's call through a voice bridge is
//! counted `unmatched` and dropped.
//!
//! No ledger entry carries a key, an event's words or a phone number.

use std::collections::BTreeMap;

use jt_calls::{BridgeEvent, CallMode, CallState};
use jt_capability::{Capability, CapabilityId, StoredStatus, effective_status};
use jt_tenancy::Permission;
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};

use super::session::Pending;
use super::{extension_is_valid, signal_key};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::calls::QueuedCommand;
use crate::usecases::api_keys::AgentPrincipal;
use crate::usecases::bridges::kernel::{self, Beat, BridgeSpec, FactsMerge, Held};
use crate::usecases::capabilities::version_in_force;
use crate::usecases::{Deps, invalid};

pub use jt_calls::wire::{
    BridgeCommand, CommandsOut, CommandsQuery, EventIn, EventsInput, EventsOut, RegisterInput,
    RegisterOut, SpeechToText, TextToSpeech,
};

/// The kind of the bridge's capability.
pub const VOICE_BRIDGE_KIND: &str = "voice_bridge";
/// The voice bridge as the bridge kernel knows it: the system component `voice_bridge`, its key's
/// one permission `calls.bridge`, a heartbeat every 15 seconds, `calls.bridge.online` /
/// `calls.bridge.offline` as its capability comes back and goes silent, a command handed out
/// again 10 seconds after it was taken unacknowledged, and the facts it reports under
/// `connector_public.bridge` replaced whole by each registration (it reports all of them every
/// time).
pub const VOICE_BRIDGE: BridgeSpec = BridgeSpec {
    component: "voice_bridge",
    name: "voice bridge",
    permission: Permission::CallsBridge,
    heartbeat_s: 15,
    online_action: "calls.bridge.online",
    offline_action: "calls.bridge.offline",
    redeliver_after: Duration::seconds(10),
    merge: FactsMerge::Replace,
};
/// How often the bridge registers, as its registration tells it.
pub const HEARTBEAT_S: u32 = VOICE_BRIDGE.heartbeat_s;
/// The longest a poll for commands waits.
pub use super::MAX_WAIT_S;
/// How long a command handed out stays the bridge's before it is handed out again.
pub const REDELIVER_AFTER: Duration = VOICE_BRIDGE.redeliver_after;
/// The most commands one poll hands out.
pub const MAX_COMMANDS: u32 = 20;
/// The most events one batch carries.
pub const MAX_EVENTS: usize = 100;

/// How far before its arrival an event's own time is believed; an older one counts as this old.
const MAX_EVENT_AGE: Duration = Duration::minutes(1);
/// The longest id the bridge gives a call.
const MAX_BRIDGE_CALL_ID_CHARS: usize = 128;
/// The most codecs a registration names.
const MAX_CODECS: usize = 8;
/// The most calls one bridge says it carries at once.
const MAX_LINES: u8 = 8;
/// The longest model, voice or version a registration reports.
const MAX_FACT_CHARS: usize = 128;

// ---------------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------------

/// The context of a call the voice bridge makes at `now` with the key behind `p`: the system
/// component `voice_bridge` in the key's workspace, with the key's effective scopes, no role and
/// no agent connection ([`kernel::ctx_for`]).
pub fn ctx_for_bridge(p: &AgentPrincipal, now: OffsetDateTime) -> Ctx {
    kernel::ctx_for(&VOICE_BRIDGE, p, now)
}

/// `Ok` for the bridge's own context: `calls.bridge` (else `FORBIDDEN` naming it), held alone by
/// the bridge's component (else `FORBIDDEN` with `details.reason = "bridge_key_only"`).
fn authorize(ctx: &Ctx) -> Result<(), AppError> {
    kernel::require_bridge(&VOICE_BRIDGE, ctx)
}

// ---------------------------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------------------------

fn is_name(text: &str, max: usize, extra: impl Fn(u8) -> bool) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit() || extra(b))
}

fn is_line(text: &str) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= MAX_FACT_CHARS
        && !text.chars().any(char::is_control)
}

/// The facts `input` reports, as `connector_public.bridge` keeps them, once each is valid (else
/// `VALIDATION` naming the first that is not).
fn bridge_facts(input: &RegisterInput) -> Result<Value, AppError> {
    if !extension_is_valid(&input.extension) {
        return Err(invalid("extension", "an extension is 1 to 16 digits"));
    }
    let codec = |c: &String| {
        is_name(c, 16, |b| {
            b.is_ascii_alphabetic() || matches!(b, b'.' | b'_' | b'-')
        })
    };
    if input.codecs.len() > MAX_CODECS || !input.codecs.iter().all(codec) {
        return Err(invalid(
            "codecs",
            "at most 8 codecs, each 1 to 16 of A-Z, a-z, 0-9, '.', '_' and '-'",
        ));
    }
    if !(1..=MAX_LINES).contains(&input.max_calls) {
        return Err(invalid("max_calls", "max_calls is 1 to 8"));
    }
    let engine = |e: &str| {
        is_name(e, 32, |b| {
            b.is_ascii_lowercase() || matches!(b, b'_' | b'-')
        })
    };
    for (field, ok) in [
        ("stt.engine", engine(&input.stt.engine)),
        ("tts.engine", engine(&input.tts.engine)),
    ] {
        if !ok {
            return Err(invalid(
                field,
                "an engine name is 1 to 32 of a-z, 0-9, '_' and '-'",
            ));
        }
    }
    for (field, ok) in [
        ("stt.model", is_line(&input.stt.model)),
        ("tts.voice", is_line(&input.tts.voice)),
        ("version", is_line(&input.version)),
    ] {
        if !ok {
            return Err(invalid(
                field,
                &format!("{field} is 1 to 128 characters, without control characters"),
            ));
        }
    }
    Ok(json!({
        "extension": input.extension,
        "codecs": input.codecs,
        "max_calls": input.max_calls,
        "stt": input.stt,
        "tts": input.tts,
        "version": input.version,
    }))
}

/// The bridge's heartbeat (see the module docs): verifies the workspace's live `voice_bridge`
/// capability of `input.extension` (whatever it read before, a person's `mark_unreachable`
/// included), declaring it first when there is none (writing `capability.declare`, its name
/// `Voice bridge {extension}`), and stores the facts the bridge reported. Writes
/// `calls.bridge.online` (`capability_id`, `extension`, `version`, `declared`) when the
/// capability did not read verified until now. An extension whose only bridge was retired is not
/// declared again: `CONFLICT` with `details.reason = "bridge_retired"`, until someone declares a
/// new one. Only the bridge's key.
pub async fn register(
    deps: &Deps,
    ctx: &Ctx,
    input: RegisterInput,
) -> Result<RegisterOut, AppError> {
    authorize(ctx)?;
    let facts = bridge_facts(&input)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let in_force = version_in_force(r.as_mut()).await?;
    let bridges = kernel::of_kind(r.as_mut(), VOICE_BRIDGE_KIND).await?;
    let (id, declared) = match kernel::held(&bridges, &input.extension) {
        Held::Live(c) => (c.id, false),
        Held::Retired => {
            return Err(AppError {
                code: ErrorCode::Conflict,
                message: "the voice bridge of this extension is retired".into(),
                details: json!({ "reason": "bridge_retired" }),
            });
        }
        Held::Missing => {
            let name = format!("Voice bridge {}", input.extension);
            let ids = deps.ids.as_ref();
            let declared = kernel::declare(
                r.as_mut(),
                ctx,
                ids,
                VOICE_BRIDGE_KIND,
                &name,
                &input.extension,
                in_force,
            );
            (declared.await?, true)
        }
    };
    let beat = Beat {
        capability_id: id,
        facts: Map::from_iter([("bridge".to_owned(), facts)]),
        online: json!({
            "capability_id": id,
            "extension": input.extension,
            "version": input.version,
            "declared": declared,
        }),
    };
    let capability = kernel::heartbeat(r.as_mut(), ctx, &VOICE_BRIDGE, in_force, beat).await?;
    r.commit().await?;
    Ok(RegisterOut {
        capability_id: id,
        status: effective_status(&capability, ctx.now),
        heartbeat_s: HEARTBEAT_S,
    })
}

/// The workspace's `voice_bridge` capabilities that are not retired, oldest first.
async fn live_bridges(r: &mut dyn TenantRepos) -> Result<Vec<Capability>, AppError> {
    Ok(kernel::of_kind(r, VOICE_BRIDGE_KIND)
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

impl From<QueuedCommand> for BridgeCommand {
    fn from(q: QueuedCommand) -> Self {
        BridgeCommand::of(q.id, q.call_id, q.bridge_call_id, &q.command)
    }
}

/// The bridge's poll (see the module docs): leases at most [`MAX_COMMANDS`] of its due commands,
/// waiting up to `query.wait_s` seconds for one. A bridge the workspace does not have is
/// `NOT_FOUND` (an extension named) or `CONFLICT` (none named and none registered); several
/// bridges and none named is `VALIDATION` naming `extension`. Only the bridge's key.
pub async fn commands(
    deps: &Deps,
    ctx: &Ctx,
    query: CommandsQuery,
) -> Result<CommandsOut, AppError> {
    authorize(ctx)?;
    let wait = std::time::Duration::from_secs(u64::from(
        query.wait_s.unwrap_or(MAX_WAIT_S).min(MAX_WAIT_S),
    ));
    let capability = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        bridge_of(r.as_mut(), query.extension.as_deref()).await?
    };
    // Each read leases as of when it is made: `ctx.now` plus the time waited so far.
    let taken = kernel::wait_for(
        deps.bridge_signals.as_ref(),
        signal_key(ctx.workspace_id),
        wait,
        move |waited| {
            Box::pin(kernel::lease(
                deps,
                ctx,
                &VOICE_BRIDGE,
                waited,
                move |r, _, at| {
                    Box::pin(r.calls().take_commands(
                        capability,
                        at.now,
                        at.redeliver_before,
                        MAX_COMMANDS,
                    ))
                },
            ))
        },
    )
    .await?;
    Ok(match taken {
        Some(taken) => CommandsOut {
            commands: taken.into_iter().map(BridgeCommand::from).collect(),
            timed_out: false,
        },
        None => CommandsOut {
            commands: Vec::new(),
            timed_out: true,
        },
    })
}

/// The live bridge of `extension`, or the workspace's only live bridge (see [`commands`]).
async fn bridge_of(
    r: &mut dyn TenantRepos,
    extension: Option<&str>,
) -> Result<CapabilityId, AppError> {
    let bridges = live_bridges(r).await?;
    if let Some(extension) = extension {
        return bridges
            .iter()
            .find(|c| c.external_id.as_deref() == Some(extension))
            .map(|c| c.id)
            .ok_or_else(|| AppError::not_found("no voice bridge has this extension"));
    }
    match bridges.as_slice() {
        [only] => Ok(only.id),
        [] => Err(AppError::conflict("no voice bridge is registered")),
        _ => Err(invalid(
            "extension",
            "the workspace has several voice bridges: name the extension",
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/// The event's kind, as its `kind` field names it.
fn kind_of(event: &BridgeEvent) -> &'static str {
    match event {
        BridgeEvent::Inbound { .. } => "inbound",
        BridgeEvent::Ringing => "ringing",
        BridgeEvent::Answered => "answered",
        BridgeEvent::Utterance { .. } => "utterance",
        BridgeEvent::Dtmf { .. } => "dtmf",
        BridgeEvent::Said { .. } => "said",
        BridgeEvent::Silence { .. } => "silence",
        BridgeEvent::Recording { .. } => "recording",
        BridgeEvent::Hangup { .. } => "hangup",
        BridgeEvent::Error { .. } => "error",
        BridgeEvent::Phrase { .. } => "phrase",
        BridgeEvent::Trace { .. } => "trace",
        BridgeEvent::CommandDone { .. } => "command_done",
    }
}

/// Applies a batch of the bridge's events (see the module docs). A batch over [`MAX_EVENTS`], or
/// an event whose `bridge_call_id` is empty, longer than 128 characters or holds whitespace or a
/// control character, is `VALIDATION` (naming `events` or `events[i].bridge_call_id`) and nothing
/// is applied. Each call's events are applied in one transaction, which wakes what listens on
/// the workspace's calls once committed. Only the bridge's key.
pub async fn events(deps: &Deps, ctx: &Ctx, input: EventsInput) -> Result<EventsOut, AppError> {
    authorize(ctx)?;
    if input.events.len() > MAX_EVENTS {
        return Err(invalid("events", "a batch carries at most 100 events"));
    }
    for (i, e) in input.events.iter().enumerate() {
        let id = &e.bridge_call_id;
        if id.is_empty()
            || id.chars().count() > MAX_BRIDGE_CALL_ID_CHARS
            || id.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(invalid(
                &format!("events[{i}].bridge_call_id"),
                "a bridge call id is 1 to 128 characters, without spaces",
            ));
        }
    }
    let mut calls: BTreeMap<String, Vec<EventIn>> = BTreeMap::new();
    for e in input.events {
        calls.entry(e.bridge_call_id.clone()).or_default().push(e);
    }
    let mut out = EventsOut::default();
    for (bridge_call_id, mut events) in calls {
        events.sort_by_key(|e| e.bridge_seq);
        apply_call(deps, ctx, &bridge_call_id, events, &mut out).await?;
    }
    Ok(out)
}

/// Applies `events`, in order, to the session the bridge knows as `bridge_call_id`, counting
/// them into `out`.
async fn apply_call(
    deps: &Deps,
    ctx: &Ctx,
    bridge_call_id: &str,
    events: Vec<EventIn>,
    out: &mut EventsOut,
) -> Result<(), AppError> {
    let count = u32::try_from(events.len()).unwrap_or(u32::MAX);
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(mut session) = r.calls().lock_by_bridge_id(bridge_call_id).await? else {
        out.unmatched += count;
        return Ok(());
    };
    let bridge = r
        .capabilities()
        .find(session.capability_id)
        .await?
        .filter(|c| c.kind_key == VOICE_BRIDGE_KIND);
    let Some(bridge) = bridge.filter(|_| session.mode == CallMode::Agent) else {
        out.unmatched += count;
        return Ok(());
    };
    let policy = super::policy_of(r.as_mut()).await?;
    let (was_answered, was_ended) = (
        session.answered_at.is_some(),
        session.state == CallState::Ended,
    );
    let mut pending = Pending::default();
    let mut applied = 0;
    for e in events {
        let fresh = r
            .calls()
            .note_bridge_event(
                bridge.id,
                bridge_call_id,
                e.bridge_seq,
                kind_of(&e.event),
                ctx.now,
            )
            .await?;
        if !fresh {
            out.duplicates += 1;
            continue;
        }
        out.accepted += 1;
        applied += 1;
        if let BridgeEvent::CommandDone { id } = &e.event {
            r.calls().ack_command(bridge.id, *id, ctx.now).await?;
        }
        let at = e.at.clamp(ctx.now - MAX_EVENT_AGE, ctx.now);
        pending.add(jt_calls::reduce(&mut session, &e.event, at, &policy));
    }
    if applied == 0 {
        return Ok(());
    }
    let id = session.id;
    pending.store(deps, r.as_mut(), id, ctx.now).await?;
    if !was_answered && session.answered_at.is_some() {
        super::ledger(
            r.as_mut(),
            ctx,
            "calls.answered",
            id,
            json!({ "call_id": id }),
        )
        .await?;
    }
    if !was_ended && session.state == CallState::Ended {
        super::settle(deps, ctx, r.as_mut(), &mut session).await?;
    }
    r.calls().update(session, ctx.now).await?;
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    Ok(())
}
