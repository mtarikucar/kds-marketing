//! The voice bridge's surface (V1-T1): its heartbeat verifies the `voice_bridge` capability, its
//! command queue is long-polled with a lease that re-delivers what it never acknowledged, its event
//! batches are applied once per `(bridge_call_id, bridge_seq)`, and its key reaches nothing else.
mod support;

use std::time::Instant;

use jt_app::catalog;
use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::calls::bridge::{
    self, CommandsOut, CommandsQuery, EventsInput, RegisterInput,
};
use jt_app::usecases::calls::{self, PlaceInput};
use jt_app::usecases::capabilities::{self, DeclareInput};
use jt_app::usecases::{jobs, work};
use jt_calls::{
    CallCommandId, CallDirection, CallId, CallMetrics, CallMode, CallPlan, CallPurpose,
    CallSession, CallState, Command, RecordingState, TurnClock,
};
use jt_capability::{CapabilityId, EffectiveStatus, Evidence, Reach, StoredStatus};
use jt_ledger::Actor;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

/// The number the agent calls, as stored.
const E164: &str = "+905321234567";

/// The bridge's key: issued by the owner with `calls.bridge` alone.
async fn bridge_key(w: &World) -> AgentPrincipal {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: "voice bridge".into(),
            scopes: vec!["calls.bridge".into()],
        },
    )
    .await
    .unwrap();
    api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap()
}

/// The bridge calling at `now`.
fn bridge_at(key: &AgentPrincipal, now: OffsetDateTime) -> Ctx {
    bridge::ctx_for_bridge(key, now)
}

/// What the bridge reports of itself every 15 seconds, as it sends it.
fn facts_json(extension: &str) -> Value {
    json!({
        "extension": extension,
        "codecs": ["PCMA", "PCMU"],
        "max_calls": 1,
        "stt": { "engine": "vosk", "model": "vosk-model-small-tr-0.3" },
        "tts": { "engine": "piper", "voice": "tr_TR-fahrettin-medium" },
        "version": "0.1.0",
    })
}

fn facts(extension: &str) -> RegisterInput {
    serde_json::from_value(facts_json(extension)).unwrap()
}

/// An active workspace, the bridge's key, and the bridge registered as extension 101 at the fixed
/// time.
async fn rig() -> (World, AgentPrincipal, CapabilityId) {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w).await;
    let out = bridge::register(&w.deps, &bridge_at(&key, FIXED_NOW), facts("101"))
        .await
        .unwrap();
    (w, key, out.capability_id)
}

fn plan() -> CallPlan {
    CallPlan {
        opening: "Merhaba, ben Acme'nin dijital asistanıyım.".into(),
        goal: "Randevuyu teyit etmek".into(),
        holding: vec!["Bir saniye lütfen.".into()],
        fallback: vec![],
        closing: "İyi günler dilerim.".into(),
        max_duration_s: 360,
        language: "tr".into(),
        disclose_assistant: true,
    }
}

/// An agent's call through bridge `bridge`, dialing, its `dial` command queued: what placing an
/// agent's call (V1-T2) leaves for the bridge.
async fn dialing(w: &World, bridge: CapabilityId, bridge_call_id: &str) -> CallId {
    let session = CallSession {
        id: CallId::new_v7(),
        workspace_id: w.ws,
        capability_id: bridge,
        direction: CallDirection::Outbound,
        purpose: CallPurpose::Service,
        person_id: None,
        journey_id: None,
        mode: CallMode::Agent,
        state: CallState::Dialing,
        plan: Some(plan()),
        counterpart_e164: E164.into(),
        bridge_call_id: Some(bridge_call_id.into()),
        pbx_unique_id: None,
        crm_id: None,
        agent_connection_id: None,
        placed_by: Actor::System {
            component: "test".into(),
        },
        started_at: FIXED_NOW,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording: RecordingState::Off,
        metrics: CallMetrics::default(),
        clock: TurnClock::default(),
    };
    let id = session.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.calls().insert(session, FIXED_NOW).await.unwrap();
    r.calls()
        .enqueue_commands(
            id,
            vec![(
                CallCommandId::new_v7(),
                Command::Dial {
                    to_e164: E164.into(),
                    plan: plan(),
                },
            )],
            FIXED_NOW,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}

/// One poll at `now` that does not wait.
async fn poll(w: &World, key: &AgentPrincipal, now: OffsetDateTime) -> CommandsOut {
    bridge::commands(&w.deps, &bridge_at(key, now), query(Some(0)))
        .await
        .unwrap()
}

fn query(wait_s: Option<u32>) -> CommandsQuery {
    CommandsQuery {
        wait_s,
        extension: None,
    }
}

/// The kinds of the commands a poll handed out.
fn kinds(out: &CommandsOut) -> Vec<String> {
    out.commands.iter().map(|c| c.kind.clone()).collect()
}

fn batch(events: Value) -> EventsInput {
    serde_json::from_value(json!({ "events": events })).unwrap()
}

/// `seconds` after the fixed time, as the RFC 3339 an event carries.
fn at(seconds: i64) -> String {
    (FIXED_NOW + Duration::seconds(seconds))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

fn later(seconds: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(seconds)
}

async fn capability(w: &World, id: CapabilityId, now: OffsetDateTime) -> (EffectiveStatus, Value) {
    let out = capabilities::get(&w.deps, &support::at(&w.owner_ctx, now), id)
        .await
        .unwrap();
    (
        out.effective_status,
        serde_json::to_value(out.capability).unwrap(),
    )
}

/// The voice-bridge items of what is pending for the owner at `now`.
async fn offline_items(w: &World, now: OffsetDateTime) -> Vec<Value> {
    let pending = work::pending(&w.deps, &support::at(&w.owner_ctx, now))
        .await
        .unwrap();
    serde_json::to_value(pending.items)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "voice_bridge_offline")
        .cloned()
        .collect()
}

#[tokio::test]
async fn register_verifies_capability_and_records_facts() {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = bridge_key(&w).await;
    let out = bridge::register(&w.deps, &bridge_at(&key, FIXED_NOW), facts("101"))
        .await
        .unwrap();
    assert_eq!(out.status, EffectiveStatus::Verified);
    assert_eq!(out.heartbeat_s, 15);

    // The first registration declared the capability: reached like a device, its extension as
    // its external id, verified now, the facts the bridge reported under `bridge`.
    let (status, c) = capability(&w, out.capability_id, FIXED_NOW).await;
    assert_eq!(status, EffectiveStatus::Verified);
    assert_eq!(c["kind_key"], "voice_bridge");
    assert_eq!(c["reach"], json!(Reach::Device));
    assert_eq!(c["external_id"], "101");
    assert_eq!(c["status"], json!(StoredStatus::Verified));
    assert_eq!(c["last_verified_at"], json!(at(0)));
    assert_eq!(
        c["connector_public"]["bridge"],
        json!({
            "extension": "101",
            "codecs": ["PCMA", "PCMU"],
            "max_calls": 1,
            "stt": { "engine": "vosk", "model": "vosk-model-small-tr-0.3" },
            "tts": { "engine": "piper", "voice": "tr_TR-fahrettin-medium" },
            "version": "0.1.0",
        })
    );
    let declared = w.entries("capability.declare");
    assert_eq!(declared.len(), 1);
    assert_eq!(declared[0].payload["kind_key"], "voice_bridge");
    let online = w.entries("calls.bridge.online");
    assert_eq!(online.len(), 1);
    assert_eq!(online[0].payload["capability_id"], json!(out.capability_id));
    assert_eq!(online[0].payload["extension"], "101");
    assert_eq!(online[0].payload["version"], "0.1.0");
    assert!(matches!(online[0].actor, Actor::System { .. }));

    // The next heartbeat finds the same capability and only moves its time; a new version is
    // recorded; a heartbeat that changes no status writes no ledger entry.
    let mut newer = facts("101");
    newer.version = "0.1.1".into();
    let again = bridge::register(&w.deps, &bridge_at(&key, later(15)), newer)
        .await
        .unwrap();
    assert_eq!(again.capability_id, out.capability_id);
    let (_, c) = capability(&w, out.capability_id, later(15)).await;
    assert_eq!(c["last_verified_at"], json!(at(15)));
    assert_eq!(c["connector_public"]["bridge"]["version"], "0.1.1");
    assert_eq!(w.entries("calls.bridge.online").len(), 1);
    assert_eq!(w.entries("capability.declare").len(), 1);

    // A bridge the owner declared in the panel is the one its extension's bridge verifies.
    let mine = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            external_id: Some("102".into()),
            ..declaring("voice_bridge", "İkinci hat")
        },
    )
    .await
    .unwrap();
    assert_eq!(mine.capability.reach, Reach::Device);
    let second = bridge::register(&w.deps, &bridge_at(&key, later(20)), facts("102"))
        .await
        .unwrap();
    assert_eq!(second.capability_id, mine.capability.id);
    assert_eq!(w.entries("capability.declare").len(), 2);

    // Malformed facts are refused, naming the field.
    for (field, bad) in [
        ("extension", json!({ "extension": "10a" })),
        ("extension", json!({ "extension": "" })),
        ("max_calls", json!({ "max_calls": 0 })),
        ("version", json!({ "version": "" })),
        (
            "stt.engine",
            json!({ "stt": { "engine": "", "model": "m" } }),
        ),
        (
            "tts.voice",
            json!({ "tts": { "engine": "piper", "voice": "a\nb" } }),
        ),
        ("codecs", json!({ "codecs": ["PCMA", "x y"] })),
    ] {
        let mut input = facts_json("101");
        for (k, v) in bad.as_object().unwrap() {
            input[k] = v.clone();
        }
        let input: RegisterInput = serde_json::from_value(input).unwrap();
        let e = err(bridge::register(&w.deps, &bridge_at(&key, later(25)), input).await);
        assert_invalid(&e, field);
    }
    // Nothing the bridge reported carries its key.
    let token = format!("{}", w.entries("calls.bridge.online")[0].payload);
    assert!(!token.contains("jt_live_"), "{token}");
}

#[tokio::test]
async fn stale_after_60s_unreachable_after_10m() {
    let (w, key, bridge) = rig().await;
    // A minute after its heartbeat it is still verified; a second more and it is stale, and the
    // agent is told the bridge is offline.
    assert_eq!(
        capability(&w, bridge, later(60)).await.0,
        EffectiveStatus::Verified
    );
    assert!(offline_items(&w, later(60)).await.is_empty());
    assert_eq!(
        capability(&w, bridge, later(61)).await.0,
        EffectiveStatus::Stale
    );
    let items = offline_items(&w, later(61)).await;
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["capability_id"], json!(bridge));
    assert_eq!(items[0]["priority"], 2);
    assert_eq!(items[0]["last_seen_at"], json!(at(0)));
    // Never a request to verify it by evidence: only its heartbeat verifies it.
    let pending = work::pending(&w.deps, &support::at(&w.owner_ctx, later(61)))
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&pending.items)
            .unwrap()
            .contains("verify_capability")
    );

    // The health job leaves it stale until ten minutes have passed, then marks it unreachable,
    // once.
    let run = jobs::run_voice_bridge_health(&w.deps, later(9 * 60)).await;
    assert_eq!(run, jobs::JobReport::default());
    assert_eq!(
        capability(&w, bridge, later(9 * 60)).await.0,
        EffectiveStatus::Stale
    );
    let run = jobs::run_voice_bridge_health(&w.deps, later(10 * 60 + 1)).await;
    assert_eq!((run.touched, run.changed, run.failed), (1, 1, 0));
    let (status, c) = capability(&w, bridge, later(10 * 60 + 1)).await;
    assert_eq!(status, EffectiveStatus::Unreachable);
    // Its last heartbeat stays readable: when it was last heard.
    assert_eq!(c["last_verified_at"], json!(at(0)));
    let offline = w.entries("calls.bridge.offline");
    assert_eq!(offline.len(), 1);
    assert_eq!(offline[0].payload["capability_id"], json!(bridge));
    let run = jobs::run_voice_bridge_health(&w.deps, later(11 * 60)).await;
    assert_eq!(run, jobs::JobReport::default());
    assert_eq!(w.entries("calls.bridge.offline").len(), 1);
    assert_eq!(offline_items(&w, later(11 * 60)).await.len(), 1);

    // Its next registration brings it back.
    bridge::register(&w.deps, &bridge_at(&key, later(12 * 60)), facts("101"))
        .await
        .unwrap();
    assert_eq!(
        capability(&w, bridge, later(12 * 60)).await.0,
        EffectiveStatus::Verified
    );
    assert_eq!(w.entries("calls.bridge.online").len(), 2);
    assert!(offline_items(&w, later(12 * 60)).await.is_empty());
}

#[tokio::test]
async fn commands_long_poll_returns_within_wait_plus_one() {
    let (w, key, bridge) = rig().await;
    // Nothing queued: the poll waits for its time, then answers that it timed out.
    let started = Instant::now();
    let out = bridge::commands(&w.deps, &bridge_at(&key, FIXED_NOW), query(Some(1)))
        .await
        .unwrap();
    let took = started.elapsed();
    assert!(out.commands.is_empty());
    assert!(out.timed_out);
    assert!(took >= std::time::Duration::from_millis(900), "{took:?}");
    assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    // No wait: at once.
    let started = Instant::now();
    assert!(poll(&w, &key, FIXED_NOW).await.timed_out);
    assert!(started.elapsed() < std::time::Duration::from_millis(500));

    // A command queued while the bridge waits is handed out at once, long before the wait ends.
    let deps = w.deps.clone();
    let waiting_ctx = bridge_at(&key, FIXED_NOW);
    let started = Instant::now();
    let waiting =
        tokio::spawn(async move { bridge::commands(&deps, &waiting_ctx, query(Some(5))).await });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let call = dialing(&w, bridge, "b-1").await;
    let out = waiting.await.unwrap().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(!out.timed_out);
    assert_eq!(kinds(&out), ["dial"]);
    assert_eq!(out.commands[0].call_id, call);
    assert_eq!(out.commands[0].bridge_call_id.as_deref(), Some("b-1"));
    // The bridge dials the number itself: it is the one place it is handed out.
    assert_eq!(out.commands[0].payload["to_e164"], E164);
    assert_eq!(out.commands[0].payload["plan"]["opening"], plan().opening);

    // A wait over 25 seconds is cut to 25, not refused.
    dialing(&w, bridge, "b-2").await;
    let out = bridge::commands(&w.deps, &bridge_at(&key, FIXED_NOW), query(Some(600)))
        .await
        .unwrap();
    assert_eq!(kinds(&out), ["dial"]);
    assert_eq!(bridge::MAX_WAIT_S, 25);
}

#[tokio::test]
async fn unacked_command_redelivered_after_10s() {
    let (w, key, bridge) = rig().await;
    let call = dialing(&w, bridge, "b-1").await;
    let first = poll(&w, &key, FIXED_NOW).await;
    assert_eq!(kinds(&first), ["dial"]);
    let id = first.commands[0].id;
    // Taken: not handed out again while its lease runs.
    assert!(poll(&w, &key, later(5)).await.commands.is_empty());
    assert!(poll(&w, &key, later(10)).await.commands.is_empty());
    // Not acknowledged within ten seconds: handed out again, the same command.
    let again = poll(&w, &key, later(11)).await;
    assert_eq!(again.commands.len(), 1);
    assert_eq!(again.commands[0].id, id);
    assert_eq!(again.commands[0].call_id, call);

    // Acknowledged: never again.
    let out = bridge::events(
        &w.deps,
        &bridge_at(&key, later(12)),
        batch(json!([
            { "bridge_call_id": "b-1", "bridge_seq": 1, "at": at(12), "kind": "command_done", "id": id },
        ])),
    )
    .await
    .unwrap();
    assert_eq!(out.accepted, 1);
    assert!(poll(&w, &key, later(30)).await.commands.is_empty());
    assert!(poll(&w, &key, later(300)).await.commands.is_empty());
}

#[tokio::test]
async fn events_batch_is_idempotent() {
    let (w, key, bridge) = rig().await;
    let call = dialing(&w, bridge, "b-1").await;
    assert_eq!(kinds(&poll(&w, &key, FIXED_NOW).await), ["dial"]);
    let events = json!([
        { "bridge_call_id": "b-1", "bridge_seq": 1, "at": at(2), "kind": "ringing" },
        { "bridge_call_id": "b-1", "bridge_seq": 2, "at": at(4), "kind": "answered" },
        { "bridge_call_id": "b-1", "bridge_seq": 3, "at": at(6), "kind": "utterance",
          "text": "Evet, buyurun", "is_final": true, "confidence": 0.8, "stt_ms": 180 },
        { "bridge_call_id": "b-unknown", "bridge_seq": 1, "at": at(6), "kind": "ringing" },
    ]);
    let out = bridge::events(&w.deps, &bridge_at(&key, later(7)), batch(events.clone()))
        .await
        .unwrap();
    assert_eq!(
        (out.accepted, out.duplicates, out.unmatched),
        (3, 0, 1),
        "{out:?}"
    );
    let shown = calls::get(&w.deps, &w.owner_ctx, call).await.unwrap();
    assert_eq!(shown.call["state"], "live");
    assert_eq!(shown.call["answered_at"], json!(at(4)));
    let turns: Vec<(u32, String)> = shown
        .turns
        .iter()
        .map(|t| (t.seq, t.text.clone()))
        .collect();
    assert_eq!(
        turns,
        [
            (0, String::new()),
            (1, plan().opening),
            (2, "Evet, buyurun".to_owned()),
        ]
    );
    // The answer queued the plan's opening for the bridge to play.
    let queued = poll(&w, &key, later(7)).await;
    assert_eq!(kinds(&queued), ["play"]);
    assert_eq!(queued.commands[0].payload["clip"], "opening");
    assert_eq!(queued.commands[0].payload["text"], plan().opening);

    // The same batch again changes nothing.
    let out = bridge::events(&w.deps, &bridge_at(&key, later(8)), batch(events))
        .await
        .unwrap();
    assert_eq!(
        (out.accepted, out.duplicates, out.unmatched),
        (0, 3, 1),
        "{out:?}"
    );
    let again = calls::get(&w.deps, &w.owner_ctx, call).await.unwrap();
    assert_eq!(again.turns, shown.turns);
    assert_eq!(again.call, shown.call);
    // Nothing new is queued (the dial and the opening are still leased).
    assert!(poll(&w, &key, later(9)).await.commands.is_empty());

    // A batch that repeats one event and adds one applies only the new one, whatever its order.
    let out = bridge::events(
        &w.deps,
        &bridge_at(&key, later(10)),
        batch(json!([
            { "bridge_call_id": "b-1", "bridge_seq": 4, "at": at(9), "kind": "dtmf", "digit": "5" },
            { "bridge_call_id": "b-1", "bridge_seq": 3, "at": at(6), "kind": "utterance",
              "text": "Evet, buyurun", "is_final": true },
        ])),
    )
    .await
    .unwrap();
    assert_eq!((out.accepted, out.duplicates), (1, 1), "{out:?}");
    let turns = calls::get(&w.deps, &w.owner_ctx, call).await.unwrap().turns;
    assert_eq!(turns.len(), 4);
    assert_eq!(turns[3].text, "5");

    // A malformed batch is refused whole, naming the event.
    let e = err(
        bridge::events(
            &w.deps,
            &bridge_at(&key, later(11)),
            batch(json!([
                { "bridge_call_id": "b-1", "bridge_seq": 5, "at": at(10), "kind": "silence", "ms": 6000 },
                { "bridge_call_id": "", "bridge_seq": 6, "at": at(10), "kind": "ringing" },
            ])),
        )
        .await,
    );
    assert_invalid(&e, "events[1].bridge_call_id");
    assert_eq!(
        calls::get(&w.deps, &w.owner_ctx, call)
            .await
            .unwrap()
            .turns
            .len(),
        4
    );
}

#[tokio::test]
async fn bridge_key_cannot_call_other_tools() {
    let (w, key, bridge) = rig().await;
    let ctx = bridge_at(&key, FIXED_NOW);
    assert_eq!(
        ctx.permissions,
        [jt_tenancy::Permission::CallsBridge].into()
    );
    // Not an agent: it is never an agent connection, and never counts as one checking in.
    assert!(matches!(ctx.actor, Actor::System { .. }));
    assert_eq!(ctx.agent_connection_id, None);

    // The bridge's key places no call, reads no call, no pending work and no capability.
    let place: PlaceInput = serde_json::from_value(json!({
        "phone": E164, "purpose": "service", "mode": "human", "rep_extension": "101",
    }))
    .unwrap();
    assert_forbidden(&err(calls::place(&w.deps, &ctx, place).await), "calls.work");
    assert_forbidden(
        &err(calls::list(&w.deps, &ctx, Default::default()).await),
        "calls.work",
    );
    assert_forbidden(&err(work::pending(&w.deps, &ctx).await), "workspace.read");
    assert_forbidden(
        &err(capabilities::get(&w.deps, &ctx, bridge).await),
        "workspace.read",
    );

    // And nothing but the bridge's own key is the bridge: not the owner, not an agent holding
    // every permission (calls.bridge among them).
    let agent = w.agent(&[]).await;
    assert!(
        agent
            .permissions
            .contains(&jt_tenancy::Permission::CallsBridge)
    );
    for who in [&w.owner_ctx, &agent] {
        let e = err(bridge::register(&w.deps, who, facts("101")).await);
        assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
        assert_eq!(e.details["reason"], "bridge_key_only", "{e:?}");
        let e = err(bridge::commands(&w.deps, who, query(Some(0))).await);
        assert_eq!(e.details["reason"], "bridge_key_only", "{e:?}");
        let e = err(bridge::events(&w.deps, who, batch(json!([]))).await);
        assert_eq!(e.details["reason"], "bridge_key_only", "{e:?}");
    }

    // The catalog serves the bridge's three use cases to the bridge only: no MCP tool.
    for (id, route, risk) in [
        (
            "calls.bridge.register",
            ("POST", "/api/voice/bridge/register"),
            catalog::Risk::Write,
        ),
        (
            "calls.bridge.commands",
            ("GET", "/api/voice/bridge/commands"),
            catalog::Risk::Read,
        ),
        (
            "calls.bridge.events",
            ("POST", "/api/voice/bridge/events"),
            catalog::Risk::Write,
        ),
    ] {
        let row = catalog::find(id).unwrap();
        assert!(row.panel_only && row.mcp_tool.is_none(), "{id}");
        assert_eq!(row.panel_route, Some(route), "{id}");
        assert_eq!(row.risk, risk, "{id}");
        assert_eq!(row.gate, catalog::GateMode::Exempt, "{id}");
        assert_eq!(
            row.status_exemption,
            catalog::StatusExemption::Never,
            "{id}"
        );
    }
    assert!(
        catalog::CATALOG
            .iter()
            .filter(|uc| uc.mcp_tool.is_some_and(|t| t.contains("bridge")))
            .count()
            == 0
    );
}

#[tokio::test]
async fn a_retired_bridge_is_not_declared_again() {
    let (w, key, bridge) = rig().await;
    capabilities::retire(&w.deps, &w.owner_ctx, bridge, true)
        .await
        .unwrap();
    // Its bridge still runs: its registration is refused, and no new capability appears.
    let e = err(bridge::register(&w.deps, &bridge_at(&key, later(15)), facts("101")).await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["reason"], "bridge_retired");
    assert_eq!(w.entries("capability.declare").len(), 1);
    // Until the owner declares the extension's bridge anew.
    let again = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            external_id: Some("101".into()),
            ..declaring("voice_bridge", "Yeni köprü")
        },
    )
    .await
    .unwrap();
    let out = bridge::register(&w.deps, &bridge_at(&key, later(30)), facts("101"))
        .await
        .unwrap();
    assert_eq!(out.capability_id, again.capability.id);
}

#[tokio::test]
async fn a_voice_bridge_is_verified_only_by_its_heartbeat() {
    let (w, _key, bridge) = rig().await;
    // Neither a person nor an agent verifies it by evidence.
    let e = err(capabilities::verify(
        &w.deps,
        &w.owner_ctx,
        bridge,
        Evidence {
            text: "it answered".into(),
            refs: vec![],
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    // Nor does anyone declare the facts only its registration writes.
    let e = err(capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            connector_public: json!({ "bridge": { "version": "9" } }),
            ..declaring("voice_bridge", "Sahte köprü")
        },
    )
    .await);
    assert_eq!(gap_fields(&e), ["connector_public.bridge"]);
}

#[tokio::test]
async fn a_scripted_bridge_registers_polls_and_reports_a_call() {
    let (w, key, bridge) = rig().await;
    let call = dialing(&w, bridge, "b-1").await;

    // The bridge takes the dial, reports the line ringing and the answer.
    let dial = poll(&w, &key, later(1)).await;
    assert_eq!(kinds(&dial), ["dial"]);
    let report = |events: Value, now: i64| {
        let deps = w.deps.clone();
        let ctx = bridge_at(&key, later(now));
        async move { bridge::events(&deps, &ctx, batch(events)).await.unwrap() }
    };
    report(
        json!([
            { "bridge_call_id": "b-1", "bridge_seq": 1, "at": at(1), "kind": "command_done", "id": dial.commands[0].id },
            { "bridge_call_id": "b-1", "bridge_seq": 2, "at": at(2), "kind": "ringing" },
            { "bridge_call_id": "b-1", "bridge_seq": 3, "at": at(5), "kind": "answered" },
        ]),
        5,
    )
    .await;
    // It plays the opening it is handed, and says so.
    let play = poll(&w, &key, later(5)).await;
    assert_eq!(kinds(&play), ["play"]);
    let seq = play.commands[0].payload["seq"].clone();
    report(
        json!([
            { "bridge_call_id": "b-1", "bridge_seq": 4, "at": at(6), "kind": "command_done", "id": play.commands[0].id },
            { "bridge_call_id": "b-1", "bridge_seq": 5, "at": at(9), "kind": "said", "seq": seq, "tts_ms": 320 },
            { "bridge_call_id": "b-1", "bridge_seq": 6, "at": at(12), "kind": "hangup", "cause": "normal" },
        ]),
        12,
    )
    .await;
    assert!(poll(&w, &key, later(13)).await.commands.is_empty());
    // The call ended when the person hung up, after seven seconds on the line.
    let shown = calls::get(&w.deps, &w.owner_ctx, call).await.unwrap();
    assert_eq!(shown.call["state"], "ended");
    assert_eq!(shown.call["end_cause"]["cause"], "caller_hangup");
    assert_eq!(shown.call["duration_s"], 7);
    assert_eq!(shown.call["metrics"]["tts_ms"], json!([320]));
    // Numbers never reach the ledger.
    for entry in w.ledger("") {
        assert!(
            !entry.payload.to_string().contains("5321234567"),
            "{entry:?}"
        );
    }
}
