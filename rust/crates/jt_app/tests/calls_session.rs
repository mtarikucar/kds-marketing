//! An agent-driven call (V1-T2), end to end against a scripted voice bridge: the dial is queued
//! only in the transaction that passes the fence again; the answer plays the plan's opening; the
//! agent long-polls the call (`calls.listen`, woken at once by what the bridge reports) and
//! speaks (`calls.say`); a slow, silent or disconnected agent is covered by the plan's holding
//! phrases and fallback lines and the call always ends by script; the caller's hangup, a
//! transfer and the maximum duration end it too, each settled once (journey, spend, ledger); and
//! every sentence the bridge is asked to play was authored by the plan, the policy or the agent.
//! The recorded bridge sequences under `fixtures/voice/` are replayed as contracts.
mod support;

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::budget::{self, BudgetItemInput};
use jt_app::usecases::calls::bridge::{self, BridgeCommand, CommandsQuery, RegisterInput};
use jt_app::usecases::calls::listen::{self, ListenOut, ListenQuery};
use jt_app::usecases::calls::say::{self, SayInput, TransferInput};
use jt_app::usecases::calls::{self, CallOut, EndInput, PlaceInput, PolicyInput};
use jt_app::usecases::inbox::people;
use jt_app::usecases::jobs;
use jt_calls::{CallId, CallPlan, CallPolicy, CallState};
use jt_capability::CapabilityId;
use jt_inbox::{
    Channel, Consent, ConsentId, ConsentKind, ConsentSource, EventSource, JourneyEventKind,
    PersonId, Suppression, SuppressionReason, SyncState,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

/// The number the agent calls, as stored.
const E164: &str = "+905321234567";
/// The disclosure sentence the policy asks every agent opening to contain.
const DISCLOSURE: &str = "dijital asistanıyım";

struct Rig {
    w: World,
    /// The voice bridge's key.
    key: AgentPrincipal,
    bridge: CapabilityId,
    person: PersonId,
    /// An agent, on a connection of its own.
    agent: Ctx,
    /// The bridge's numbering of the events it reports.
    seq: AtomicU32,
}

fn later(seconds: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(seconds)
}

/// `seconds` after the fixed time, as the RFC 3339 an event carries.
fn stamp(seconds: i64) -> String {
    later(seconds)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

/// The policy of these calls: the disclosure sentence, no tariff unless a test sets one.
fn policy() -> CallPolicy {
    CallPolicy {
        disclosure_sentence: DISCLOSURE.into(),
        holding_default: vec!["Bir dakika lütfen.".into()],
        recording_announcement: "Bu görüşme kalite amacıyla kaydedilmektedir.".into(),
        ..CallPolicy::default()
    }
}

/// The agent's script: two holding phrases, two fallback lines.
fn plan() -> CallPlan {
    CallPlan {
        opening: format!("Merhaba, ben Acme'nin {DISCLOSURE}. Randevunuz için arıyorum."),
        goal: "Perşembe randevusunu teyit etmek".into(),
        holding: vec![
            "Bir saniye, kontrol ediyorum.".into(),
            "Hemen bakıyorum.".into(),
        ],
        fallback: vec![
            "Bağlantıda bir gecikme var, lütfen bekleyin.".into(),
            "Sizi en kısa sürede geri arayacağız.".into(),
        ],
        closing: "Teşekkürler, iyi günler.".into(),
        max_duration_s: 300,
        language: "tr".into(),
        disclose_assistant: true,
        hotwords: Vec::new(),
    }
}

fn facts(max_calls: u8) -> RegisterInput {
    serde_json::from_value(json!({
        "extension": "101",
        "codecs": ["PCMA", "PCMU"],
        "max_calls": max_calls,
        "stt": { "engine": "vosk", "model": "vosk-model-small-tr-0.3" },
        "tts": { "engine": "piper", "voice": "tr_TR-fahrettin-medium" },
        "version": "0.1.0",
    }))
    .unwrap()
}

/// An active workspace with an approved strategy and `policy`, a person with a phone number and
/// İYS phone consent, the bridge (carrying `max_calls` lines) registered at the fixed time, and
/// an agent.
async fn rig_with(max_calls: u8, policy: CallPolicy) -> Rig {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let person = people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Ada",
            "identities": [{ "channel": "phone", "value": "05321234567" }],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: person.id,
            channel: Channel::Phone,
            kind: ConsentKind::Explicit,
            source: ConsentSource::IysSync,
            at: FIXED_NOW - Duration::days(1),
            sync_state: SyncState::Sent,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    calls::policy_set(&w.deps, &w.owner_ctx, PolicyInput(policy))
        .await
        .unwrap();
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
    let key = api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap();
    let bridge = bridge::register(
        &w.deps,
        &bridge::ctx_for_bridge(&key, FIXED_NOW),
        facts(max_calls),
    )
    .await
    .unwrap()
    .capability_id;
    let agent = w.agent(&[]).await;
    Rig {
        w,
        key,
        bridge,
        person: person.id,
        agent,
        seq: AtomicU32::new(1),
    }
}

async fn rig() -> Rig {
    rig_with(1, policy()).await
}

fn place_input(r: &Rig, plan: CallPlan) -> PlaceInput {
    serde_json::from_value(json!({
        "person_id": r.person,
        "purpose": "commercial",
        "mode": "agent",
        "plan": plan,
    }))
    .unwrap()
}

fn id_of(out: &CallOut) -> CallId {
    serde_json::from_value(out.call["id"].clone()).unwrap()
}

/// The refusal reason of a call that must be refused.
fn reason<T: std::fmt::Debug>(result: Result<T, jt_app::error::AppError>) -> String {
    let e = result.expect_err("a refusal");
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    e.details["reason"].as_str().unwrap().to_owned()
}

impl Rig {
    fn bridge_at(&self, t: i64) -> Ctx {
        bridge::ctx_for_bridge(&self.key, later(t))
    }

    fn agent_at(&self, t: i64) -> Ctx {
        at(&self.agent, later(t))
    }

    /// The bridge's heartbeat at `t`.
    async fn heartbeat(&self, t: i64) {
        bridge::register(&self.w.deps, &self.bridge_at(t), facts(self.lines()))
            .await
            .unwrap();
    }

    fn lines(&self) -> u8 {
        let snapshot = self.w.uow.snapshot();
        let c = snapshot
            .capabilities
            .iter()
            .find(|c| c.capability.id == self.bridge)
            .unwrap();
        c.capability.connector_public["bridge"]["max_calls"]
            .as_u64()
            .unwrap() as u8
    }

    /// The agent places its call at `t`.
    async fn place_at(&self, t: i64, plan: CallPlan) -> CallId {
        id_of(
            &calls::place(&self.w.deps, &self.agent_at(t), place_input(self, plan))
                .await
                .unwrap(),
        )
    }

    /// The bridge polls at `t` without waiting, and acknowledges what it took.
    async fn poll(&self, t: i64) -> Vec<BridgeCommand> {
        self.heartbeat(t).await;
        let out = bridge::commands(
            &self.w.deps,
            &self.bridge_at(t),
            CommandsQuery {
                wait_s: Some(0),
                extension: None,
            },
        )
        .await
        .unwrap();
        for c in &out.commands {
            self.report(
                t,
                c.call_id,
                json!([{ "kind": "command_done", "id": c.id }]),
            )
            .await;
        }
        out.commands
    }

    /// The bridge reports `events` of call `call` at `t`, numbered in order.
    async fn report(&self, t: i64, call: CallId, events: Value) -> bridge::EventsOut {
        let events: Vec<Value> = events
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let mut e = e.clone();
                e["bridge_call_id"] = json!(call.to_string());
                e["bridge_seq"] = json!(self.seq.fetch_add(1, Ordering::SeqCst));
                e["at"] = json!(stamp(t));
                e
            })
            .collect();
        bridge::events(
            &self.w.deps,
            &self.bridge_at(t),
            serde_json::from_value(json!({ "events": events })).unwrap(),
        )
        .await
        .unwrap()
    }

    /// The timers at `t` (the bridge's heartbeat first, as it registers every 15 seconds).
    async fn timers(&self, t: i64) -> jobs::JobReport {
        self.heartbeat(t).await;
        jobs::run_call_timers(&self.w.deps, later(t)).await
    }

    /// The bridge takes the dial at 1, the line rings at 2 and is answered at 5; the opening
    /// plays to its end at 8. The opening's turn number.
    async fn answer(&self, call: CallId) -> u32 {
        let dial = self.poll(1).await;
        assert_eq!(kinds(&dial), ["dial"]);
        self.report(2, call, json!([{ "kind": "ringing" }])).await;
        self.report(5, call, json!([{ "kind": "answered" }])).await;
        let play = self.poll(5).await;
        assert_eq!(kinds(&play), ["play"]);
        assert_eq!(play[0].payload["clip"], "opening");
        let seq = play[0].payload["seq"].as_u64().unwrap() as u32;
        self.report(
            8,
            call,
            json!([{ "kind": "said", "seq": seq, "tts_ms": 400 }]),
        )
        .await;
        seq
    }

    async fn utterance(&self, t: i64, call: CallId, text: &str) {
        self.report(
            t,
            call,
            json!([{ "kind": "utterance", "text": text, "is_final": true, "confidence": 0.9, "stt_ms": 200 }]),
        )
        .await;
    }

    async fn say_at(&self, t: i64, call: CallId, text: &str) -> say::SayOut {
        say::say(
            &self.w.deps,
            &self.agent_at(t),
            call,
            SayInput {
                text: text.into(),
                expect_reply: true,
                allow_barge_in: true,
            },
        )
        .await
        .unwrap()
    }

    async fn shown(&self, call: CallId) -> CallOut {
        calls::get(&self.w.deps, &self.w.owner_ctx, call)
            .await
            .unwrap()
    }
}

fn kinds(commands: &[BridgeCommand]) -> Vec<String> {
    commands.iter().map(|c| c.kind.clone()).collect()
}

/// A turn as `kind`, `kind:by` or `kind:name`.
fn turn_key(turn: &Value) -> String {
    let kind = &turn["kind"];
    let name = kind["kind"].as_str().unwrap();
    match (kind.get("by"), kind.get("name")) {
        (Some(by), _) => format!("{name}:{}", by.as_str().unwrap()),
        (_, Some(event)) => format!("{name}:{}", event.as_str().unwrap()),
        _ => name.to_owned(),
    }
}

fn turn_keys(out: &CallOut) -> Vec<String> {
    out.turns
        .iter()
        .map(|t| turn_key(&serde_json::to_value(t).unwrap()))
        .collect()
}

fn call_made(r: &Rig, call: CallId) -> Vec<(bool, EventSource)> {
    r.w.uow
        .snapshot()
        .inbox
        .events
        .iter()
        .filter(|e| e.idempotency_key == format!("calls:{call}"))
        .filter_map(|e| match e.kind {
            JourneyEventKind::CallMade { connected } => Some((connected, e.source)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn bridge_dial_only_after_fence() {
    // A suppression lands right after the first fence passed (the session is being made): the
    // second fence, in the transaction that would queue the dial, sees it, and the bridge is
    // never asked to dial.
    let r = rig().await;
    let (person, ws) = (r.person, r.w.ws);
    r.w.uow.after_call_insert(move |s| {
        s.inbox.suppressions.push((
            ws,
            Suppression {
                person_id: person,
                channel: Channel::Phone,
                reason: SuppressionReason::Manual,
            },
        ))
    });
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.agent, place_input(&r, plan())).await),
        "suppressed"
    );
    let snapshot = r.w.uow.snapshot();
    assert!(snapshot.calls.commands.is_empty());
    assert_eq!(snapshot.calls.sessions.len(), 1);
    assert_eq!(snapshot.calls.sessions[0].state, CallState::Ended);
    assert_eq!(
        serde_json::to_value(&snapshot.calls.sessions[0].end_cause).unwrap(),
        json!({ "cause": "refused", "detail": "suppressed" })
    );
    let refused = r.w.entries("calls.refused");
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].payload["mode"], "agent");
    assert_eq!(
        refused[0].payload["call_id"],
        json!(snapshot.calls.sessions[0].id)
    );
    assert!(r.poll(1).await.is_empty());

    // The bridge's heartbeat lapses between the two fences: no dial either.
    let r = rig().await;
    let bridge = r.bridge;
    r.w.uow.after_call_insert(move |s| {
        for c in s.capabilities.iter_mut() {
            if c.capability.id == bridge {
                c.capability.last_verified_at = Some(FIXED_NOW - Duration::minutes(2));
            }
        }
    });
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.agent, place_input(&r, plan())).await),
        "bridge_offline"
    );
    assert!(r.w.uow.snapshot().calls.commands.is_empty());

    // Both fences pass: the dial is queued, the call's own id as the bridge's call id, the number
    // handed to the bridge (and nowhere else) with the plan to pre-synthesise.
    let r = rig().await;
    let out = calls::place(&r.w.deps, &r.agent, place_input(&r, plan()))
        .await
        .unwrap();
    let call = id_of(&out);
    assert_eq!(out.call["state"], "dialing");
    assert_eq!(out.call["mode"], json!({ "kind": "agent" }));
    assert_eq!(out.call["bridge_call_id"], json!(call.to_string()));
    assert_eq!(out.call["counterpart"], "+90 5** *** ** 67");
    assert!(!out.call.to_string().contains("5321234567"));
    let dial = r.poll(1).await;
    assert_eq!(kinds(&dial), ["dial"]);
    assert_eq!(dial[0].call_id, call);
    assert_eq!(
        dial[0].bridge_call_id.as_deref(),
        Some(call.to_string().as_str())
    );
    assert_eq!(dial[0].payload["to_e164"], E164);
    assert_eq!(dial[0].payload["plan"]["opening"], plan().opening);
    let placed = r.w.entries("calls.placed");
    assert_eq!(placed.len(), 1);
    assert_eq!(
        placed[0].payload,
        json!({ "call_id": call, "purpose": "commercial", "mode": "agent", "capability_id": r.bridge })
    );
    for entry in r.w.ledger("") {
        assert!(
            !entry.payload.to_string().contains("5321234567"),
            "{entry:?}"
        );
    }

    // An opening without the disclosure sentence is refused before any session exists.
    let r = rig().await;
    let mut bare = plan();
    bare.opening = "Merhaba, Acme'den arıyorum.".into();
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.agent, place_input(&r, bare)).await),
        "disclosure_missing"
    );
    assert!(r.w.uow.snapshot().calls.sessions.is_empty());
    // A plan out of bounds names its field.
    let mut long = plan();
    long.holding.clear();
    assert_invalid(
        &err(calls::place(&r.w.deps, &r.agent, place_input(&r, long)).await),
        "plan.holding",
    );
}

#[tokio::test]
async fn answered_plays_opening() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    assert_eq!(kinds(&r.poll(1).await), ["dial"]);
    r.report(2, call, json!([{ "kind": "ringing" }])).await;
    assert_eq!(r.shown(call).await.call["state"], "ringing");
    assert!(r.w.entries("calls.answered").is_empty());
    r.report(5, call, json!([{ "kind": "answered" }])).await;
    let play = r.poll(5).await;
    assert_eq!(kinds(&play), ["play"]);
    assert_eq!(play[0].payload["clip"], "opening");
    assert_eq!(play[0].payload["text"], plan().opening);
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "live");
    assert_eq!(shown.call["answered_at"], json!(stamp(5)));
    assert_eq!(turn_keys(&shown), ["event:answered", "say:script"]);
    assert_eq!(shown.turns[1].text, plan().opening);
    assert_eq!(
        play[0].payload["seq"].as_u64(),
        Some(u64::from(shown.turns[1].seq))
    );
    let answered = r.w.entries("calls.answered");
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0].payload, json!({ "call_id": call }));
    // A second answer report plays nothing again.
    r.report(6, call, json!([{ "kind": "answered" }])).await;
    assert!(r.poll(6).await.is_empty());
    assert_eq!(r.w.entries("calls.answered").len(), 1);
}

#[tokio::test]
async fn utterance_wakes_listen_immediately() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    let after = r.shown(call).await.turns.last().unwrap().seq;
    // The agent listens with ten seconds to wait.
    let deps = r.w.deps.clone();
    let ctx = r.agent_at(9);
    let waiting = tokio::spawn(async move {
        listen::listen(
            &deps,
            &ctx,
            call,
            ListenQuery {
                after_seq: Some(after),
                wait_s: Some(10),
            },
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let spoken = Instant::now();
    r.utterance(10, call, "Evet, perşembe uygun.").await;
    let heard: ListenOut = waiting.await.unwrap().unwrap();
    // Woken by the bridge's report, well before the second's fallback read would have come.
    assert!(
        spoken.elapsed() < std::time::Duration::from_millis(600),
        "{:?}",
        spoken.elapsed()
    );
    assert!(!heard.timed_out);
    assert_eq!(heard.state, CallState::Live);
    assert_eq!(heard.events.len(), 1);
    assert_eq!(heard.events[0].text, "Evet, perşembe uygun.");
    assert_eq!(heard.events[0].seq, after + 1);
    // A waiting bridge poll is woken the same way by the agent's sentence.
    let deps = r.w.deps.clone();
    let bridge_ctx = r.bridge_at(11);
    let polling = tokio::spawn(async move {
        bridge::commands(
            &deps,
            &bridge_ctx,
            CommandsQuery {
                wait_s: Some(10),
                extension: None,
            },
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let said = Instant::now();
    r.say_at(12, call, "Harika, perşembe 14:00'te görüşürüz.")
        .await;
    let out = polling.await.unwrap().unwrap();
    assert!(
        said.elapsed() < std::time::Duration::from_millis(600),
        "{:?}",
        said.elapsed()
    );
    assert_eq!(kinds(&out.commands), ["say"]);
}

#[tokio::test]
async fn say_enqueues_tts_command_and_turn() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    // Not before the call is answered.
    let early = say::say(
        &r.w.deps,
        &r.agent_at(1),
        call,
        SayInput {
            text: "Alo?".into(),
            expect_reply: true,
            allow_barge_in: true,
        },
    )
    .await;
    let e = err(early);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "not_live");
    assert_eq!(e.details["state"], "dialing");
    r.answer(call).await;
    r.utterance(10, call, "Evet, buyurun.").await;
    let out = r
        .say_at(13, call, "Randevunuz perşembe 14:00, uygun mu?")
        .await;
    assert_eq!(out.call_id, call);
    assert_eq!(out.state, CallState::Live);
    let queued = r.poll(13).await;
    assert_eq!(kinds(&queued), ["say"]);
    assert_eq!(
        queued[0].payload,
        json!({ "seq": out.seq, "text": "Randevunuz perşembe 14:00, uygun mu?", "allow_barge_in": true })
    );
    let shown = r.shown(call).await;
    let turn = shown.turns.iter().find(|t| t.seq == out.seq).unwrap();
    assert_eq!(turn_key(&serde_json::to_value(turn).unwrap()), "say:agent");
    assert_eq!(turn.text, "Randevunuz perşembe 14:00, uygun mu?");
    // The agent took three seconds since the caller's words.
    assert_eq!(turn.meta.latency_ms, Some(3_000));
    assert_eq!(shown.call["metrics"]["agent_latency_ms"], json!([3_000]));
    // A sentence out of bounds names `text`; a turn is never ledgered.
    for bad in ["  ".to_owned(), "a".repeat(601)] {
        let e = err(say::say(
            &r.w.deps,
            &r.agent_at(14),
            call,
            SayInput {
                text: bad,
                expect_reply: true,
                allow_barge_in: true,
            },
        )
        .await);
        assert_invalid(&e, "text");
    }
    assert!(r.w.ledger("calls.say").is_empty());
    // An unknown call is not found; a reader without calls.work is refused.
    let e = err(say::say(
        &r.w.deps,
        &r.agent_at(14),
        CallId::new_v7(),
        SayInput {
            text: "Alo?".into(),
            expect_reply: true,
            allow_barge_in: true,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let reader = r.w.agent(&["workspace.read"]).await;
    assert_forbidden(
        &err(say::say(
            &r.w.deps,
            &reader,
            call,
            SayInput {
                text: "Alo?".into(),
                expect_reply: true,
                allow_barge_in: true,
            },
        )
        .await),
        "calls.work",
    );
}

#[tokio::test]
async fn agent_silence_plays_holding_then_fallback_then_closes() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    // The caller speaks at 10; the agent never answers.
    r.utterance(10, call, "Fiyatını öğrenebilir miyim?").await;
    let mut played = Vec::new();
    for t in 11..=80 {
        r.timers(t).await;
        for c in r.poll(t).await {
            played.push((
                t,
                c.kind.clone(),
                c.payload["text"].as_str().map(str::to_owned),
            ));
        }
        if r.shown(call).await.call["state"] == "ending" {
            break;
        }
    }
    let p = plan();
    let expected = [
        (14, "play", Some(p.holding[0].clone())),
        (20, "play", Some(p.holding[1].clone())),
        (30, "play", Some(p.fallback[0].clone())),
        (34, "play", Some(p.holding[0].clone())),
        (40, "play", Some(p.holding[1].clone())),
        (50, "play", Some(p.fallback[1].clone())),
        (54, "play", Some(p.holding[0].clone())),
        (60, "play", Some(p.holding[1].clone())),
        (70, "play", Some(p.closing.clone())),
        (70, "hangup", None),
    ];
    let expected: Vec<(i64, String, Option<String>)> = expected
        .into_iter()
        .map(|(t, k, x)| (t, k.to_owned(), x))
        .collect();
    assert_eq!(played, expected);
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ending");
    assert_eq!(shown.call["end_cause"]["cause"], "agent_timeout");
    assert_eq!(shown.call["metrics"]["holding_played"], 6);
    assert_eq!(shown.call["metrics"]["fallback_played"], 2);
    // The bridge plays the closing and hangs up: the call is ended, its cause kept, settled once.
    r.report(74, call, json!([{ "kind": "hangup", "cause": "normal" }]))
        .await;
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ended");
    assert_eq!(shown.call["end_cause"]["cause"], "agent_timeout");
    assert_eq!(shown.call["duration_s"], 69);
    let ended = r.w.entries("calls.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].payload["cause"], "agent_timeout");
    assert_eq!(call_made(&r, call), [(true, EventSource::System)]);
    // Nothing more is due on an ended call.
    assert_eq!(r.timers(90).await, jobs::JobReport::default());
}

#[tokio::test]
async fn agent_disconnect_ends_by_script() {
    // A plan with one fallback line: the script ends the call within
    // fallback_after_s × (1 + 1) = 40 seconds of the words the agent never answered.
    let mut short = plan();
    short.fallback.truncate(1);
    let r = rig().await;
    let call = r.place_at(0, short.clone()).await;
    r.answer(call).await;
    // The agent listened, replied once, and then its connection went away.
    let heard = listen::listen(
        &r.w.deps,
        &r.agent_at(9),
        call,
        ListenQuery {
            after_seq: None,
            wait_s: Some(0),
        },
    )
    .await
    .unwrap();
    assert!(!heard.events.is_empty());
    r.utterance(10, call, "Kimsiniz?").await;
    r.say_at(12, call, "Acme'nin dijital asistanıyım.").await;
    r.utterance(15, call, "Peki, ne istiyorsunuz?").await;
    let mut closed_at = None;
    for t in 16..=60 {
        r.timers(t).await;
        if r.shown(call).await.call["state"] == "ending" {
            closed_at = Some(t);
            break;
        }
    }
    assert_eq!(closed_at, Some(55));
    let queued: Vec<String> = r.poll(55).await.iter().map(|c| c.kind.clone()).collect();
    assert!(
        queued.ends_with(&["play".to_owned(), "hangup".to_owned()]),
        "{queued:?}"
    );
    // The bridge never reports the hangup either: the line is taken for lost once the closing's
    // grace is over, the cause kept.
    for t in 56..=114 {
        r.timers(t).await;
    }
    assert_eq!(r.shown(call).await.call["state"], "ending");
    r.timers(115).await;
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ended");
    assert_eq!(shown.call["end_cause"]["cause"], "agent_timeout");
    assert_eq!(r.w.entries("calls.ended").len(), 1);
    // The agent's connection holds no call any more: it may place the next one.
    r.place_at(120, plan()).await;
}

#[tokio::test]
async fn barge_in_marks_say_interrupted() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    assert_eq!(kinds(&r.poll(1).await), ["dial"]);
    // The caller speaks over the opening while it plays: reported with the answer.
    r.report(
        5,
        call,
        json!([
            { "kind": "answered" },
            { "kind": "said", "seq": 1, "interrupted_at_char": 7 },
            { "kind": "utterance", "text": "Alo, kim o?", "is_final": true },
        ]),
    )
    .await;
    let shown = r.shown(call).await;
    let opening = shown.turns.iter().find(|t| t.seq == 1).unwrap();
    assert_eq!(opening.text, plan().opening);
    assert_eq!(opening.meta.interrupted_at_char, Some(7));
    // The agent's sentence, cut by the caller at its twelfth character.
    let out = r
        .say_at(8, call, "Randevunuz perşembe saat on dörtte.")
        .await;
    r.report(
        10,
        call,
        json!([
            { "kind": "said", "seq": out.seq, "interrupted_at_char": 12, "tts_ms": 350 },
            { "kind": "utterance", "text": "Hayır, cuma olsun.", "is_final": true },
        ]),
    )
    .await;
    let shown = r.shown(call).await;
    let said = shown.turns.iter().find(|t| t.seq == out.seq).unwrap();
    assert_eq!(said.meta.interrupted_at_char, Some(12));
    assert_eq!(said.text, "Randevunuz perşembe saat on dörtte.");
    assert_eq!(shown.turns.last().unwrap().text, "Hayır, cuma olsun.");
    // Only that turn changed.
    assert!(
        shown
            .turns
            .iter()
            .filter(|t| t.meta.interrupted_at_char.is_some())
            .count()
            == 2
    );
}

#[tokio::test]
async fn caller_hangup_ends_session_with_call_made() {
    let r = rig_with(
        1,
        CallPolicy {
            estimated_minor_per_minute: 150,
            ..policy()
        },
    )
    .await;
    let item = budget::create_item(
        &r.w.deps,
        &r.w.owner_ctx,
        serde_json::from_value::<BudgetItemInput>(json!({
            "name": "Hat dakikaları",
            "kind": "cash",
            "unit": { "kind": "currency", "value": "TRY" },
            "cap": 100_000,
            "period": "monthly",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .item
    .id;
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    t.budget().link(r.bridge, item).await.unwrap();
    t.commit().await.unwrap();
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    r.utterance(10, call, "Evet, uygun.").await;
    r.say_at(13, call, "Harika, görüşmek üzere.").await;
    // The person hangs up at 100: 95 seconds after the answer.
    r.report(100, call, json!([{ "kind": "hangup", "cause": "normal" }]))
        .await;
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ended");
    assert_eq!(shown.call["end_cause"]["cause"], "caller_hangup");
    assert_eq!(shown.call["duration_s"], 95);
    assert_eq!(shown.call["cost_minor"], 300);
    assert_eq!(call_made(&r, call), [(true, EventSource::System)]);
    let snapshot = r.w.uow.snapshot();
    let spend: Vec<_> = snapshot
        .budget_spend
        .iter()
        .filter(|s| s.workspace_id == r.w.ws)
        .collect();
    assert_eq!(spend.len(), 1);
    assert_eq!(spend[0].amount, 300);
    assert_eq!(
        spend[0].reference.as_deref(),
        Some(format!("call:{call}").as_str())
    );
    let ended = r.w.entries("calls.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(
        ended[0].payload,
        json!({ "call_id": call, "cause": "caller_hangup", "duration_s": 95, "turns": 1 })
    );
    // A listen answers at once: the call is over. Nothing the agent says is played.
    let heard = listen::listen(
        &r.w.deps,
        &r.agent_at(101),
        call,
        ListenQuery {
            after_seq: Some(shown.turns.last().unwrap().seq),
            wait_s: Some(10),
        },
    )
    .await
    .unwrap();
    assert_eq!(heard.state, CallState::Ended);
    assert!(!heard.timed_out);
    assert_eq!(
        reason(
            say::say(
                &r.w.deps,
                &r.agent_at(101),
                call,
                SayInput {
                    text: "Alo?".into(),
                    expect_reply: true,
                    allow_barge_in: true,
                },
            )
            .await
        ),
        "not_live"
    );
    // The hangup reported again changes nothing.
    r.report(101, call, json!([{ "kind": "hangup", "cause": "normal" }]))
        .await;
    assert_eq!(r.w.entries("calls.ended").len(), 1);
    // The agent records the outcome afterwards: a note, no second call, spend or end entry.
    let out = calls::end(
        &r.w.deps,
        &r.agent_at(110),
        call,
        serde_json::from_value::<EndInput>(json!({
            "outcome": "appointment",
            "summary": "Perşembe 14:00 teyit edildi.",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(out.call["outcome"], "appointment");
    let snapshot = r.w.uow.snapshot();
    assert_eq!(call_made(&r, call).len(), 1);
    assert_eq!(
        snapshot
            .budget_spend
            .iter()
            .filter(|s| s.workspace_id == r.w.ws)
            .count(),
        1
    );
    assert!(
        snapshot
            .inbox
            .notes
            .iter()
            .any(|n| n.text == "Perşembe 14:00 teyit edildi.")
    );
    assert_eq!(r.w.entries("calls.ended").len(), 1);
    let recorded = r.w.entries("calls.outcome_recorded");
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].payload,
        json!({ "call_id": call, "outcome": "appointment" })
    );
}

#[tokio::test]
async fn max_duration_closes() {
    let mut brief = plan();
    brief.max_duration_s = 60;
    let r = rig().await;
    let call = r.place_at(0, brief).await;
    r.answer(call).await;
    // The agent keeps up: every utterance answered within the second.
    for t in (10..=58).step_by(6) {
        r.utterance(t, call, "Evet?").await;
        r.say_at(t + 1, call, "Devam ediyorum.").await;
        r.timers(t + 1).await;
    }
    r.timers(64).await;
    assert_eq!(r.shown(call).await.call["state"], "live");
    // Answered at 5: sixty seconds later the closing plays and the line is hung up.
    r.timers(65).await;
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ending");
    assert_eq!(shown.call["end_cause"]["cause"], "max_duration");
    let queued = r.poll(65).await;
    let tail: Vec<String> = queued
        .iter()
        .rev()
        .take(2)
        .map(|c| c.kind.clone())
        .collect();
    assert_eq!(tail, ["hangup", "play"]);
    assert_eq!(queued[queued.len() - 2].payload["clip"], "closing");
}

#[tokio::test]
async fn transfer_ends_agent_part() {
    let r = rig_with(
        1,
        CallPolicy {
            handoff_extension: Some("102".into()),
            ..policy()
        },
    )
    .await;
    let call = r.place_at(0, plan()).await;
    // Not before the answer.
    let e = err(say::transfer(&r.w.deps, &r.agent_at(1), call, TransferInput::default()).await);
    assert_eq!(e.details["reason"], "not_live");
    r.answer(call).await;
    r.utterance(10, call, "Bir yetkiliyle görüşmek istiyorum.")
        .await;
    assert_invalid(
        &err(say::transfer(
            &r.w.deps,
            &r.agent_at(11),
            call,
            TransferInput {
                to_extension: Some("1o2".into()),
            },
        )
        .await),
        "to_extension",
    );
    // To the policy's handoff extension when none is named.
    let out = say::transfer(&r.w.deps, &r.agent_at(12), call, TransferInput::default())
        .await
        .unwrap();
    assert_eq!(out.call["state"], "ended");
    assert_eq!(out.call["end_cause"]["cause"], "transferred");
    assert_eq!(out.call["duration_s"], 7);
    assert_eq!(turn_keys(&out).last().unwrap(), "event:transferred");
    let queued = r.poll(12).await;
    assert_eq!(kinds(&queued), ["transfer"]);
    assert_eq!(queued[0].payload, json!({ "to": "102" }));
    let transferred = r.w.entries("calls.transferred");
    assert_eq!(transferred.len(), 1);
    assert_eq!(
        transferred[0].payload,
        json!({ "call_id": call, "to_extension": "102" })
    );
    assert_eq!(
        r.w.entries("calls.ended")[0].payload["cause"],
        "transferred"
    );
    assert_eq!(call_made(&r, call), [(true, EventSource::Agent)]);
    // The line goes on with the rep: the agent's sentences and the timers no longer reach it.
    assert_eq!(
        reason(
            say::say(
                &r.w.deps,
                &r.agent_at(13),
                call,
                SayInput {
                    text: "Alo?".into(),
                    expect_reply: true,
                    allow_barge_in: true,
                },
            )
            .await
        ),
        "not_live"
    );
    assert_eq!(r.timers(60).await, jobs::JobReport::default());
    r.report(200, call, json!([{ "kind": "hangup", "cause": "normal" }]))
        .await;
    assert_eq!(r.shown(call).await.call["duration_s"], 7);
    // Without a handoff extension in the policy, the transfer names one.
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    assert_invalid(
        &err(say::transfer(&r.w.deps, &r.agent_at(9), call, TransferInput::default()).await),
        "to_extension",
    );
}

#[tokio::test]
async fn listen_times_out_within_wait_plus_one() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    let ask = |after_seq: Option<u32>, wait_s: Option<u32>| {
        let deps = r.w.deps.clone();
        let ctx = r.agent_at(1);
        async move { listen::listen(&deps, &ctx, call, ListenQuery { after_seq, wait_s }).await }
    };
    // Nothing on the line yet: the listen waits its time, then answers that it timed out.
    let started = Instant::now();
    let out = ask(None, Some(1)).await.unwrap();
    let took = started.elapsed();
    assert!(out.timed_out);
    assert!(out.events.is_empty());
    assert_eq!(out.state, CallState::Dialing);
    assert!(took >= std::time::Duration::from_millis(900), "{took:?}");
    assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    // No wait: at once.
    let started = Instant::now();
    assert!(ask(None, Some(0)).await.unwrap().timed_out);
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    // Turns after `after_seq` answer at once, whatever the wait.
    r.answer(call).await;
    let started = Instant::now();
    let out = ask(None, Some(25)).await.unwrap();
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    assert!(!out.timed_out);
    assert_eq!(out.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [0, 1]);
    let out = ask(Some(0), Some(25)).await.unwrap();
    assert_eq!(out.events.len(), 1);
    // An unknown call is not found; a reader without calls.work is refused.
    let e = err(listen::listen(
        &r.w.deps,
        &r.agent,
        CallId::new_v7(),
        ListenQuery::default(),
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let reader = r.w.agent(&["workspace.read"]).await;
    assert_forbidden(
        &err(listen::listen(&r.w.deps, &reader, call, ListenQuery::default()).await),
        "calls.work",
    );
    assert_eq!(calls::MAX_WAIT_S, 25);
}

#[tokio::test]
async fn one_live_agent_call_per_connection() {
    // The bridge carries two calls at once.
    let r = rig_with(2, policy()).await;
    let first = r.place_at(0, plan()).await;
    // The same agent connection already has a call on the line.
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.agent_at(1), place_input(&r, plan())).await),
        "bridge_busy"
    );
    // Another agent takes the second line; a third finds both taken.
    let second_agent = r.w.agent(&[]).await;
    calls::place(&r.w.deps, &second_agent, place_input(&r, plan()))
        .await
        .unwrap();
    let third_agent = r.w.agent(&[]).await;
    assert_eq!(
        reason(calls::place(&r.w.deps, &third_agent, place_input(&r, plan())).await),
        "bridge_busy"
    );
    let refused = r.w.entries("calls.refused");
    assert_eq!(refused.len(), 2);
    assert!(refused.iter().all(|e| e.payload["reason"] == "bridge_busy"));
    // Once the first call ended, its agent may place the next one.
    r.report(
        3,
        first,
        json!([{ "kind": "hangup", "cause": "no_answer" }]),
    )
    .await;
    assert_eq!(r.shown(first).await.call["end_cause"]["cause"], "no_answer");
    r.place_at(4, plan()).await;
    // A call left ringing for ninety seconds is hung up by the timers, freeing the line.
    let report = r.timers(95).await;
    assert_eq!(report.changed, 2, "{report:?}");
    calls::place(
        &r.w.deps,
        &at(&third_agent, later(96)),
        place_input(&r, plan()),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn every_played_text_is_authored() {
    let r = rig().await;
    // The bridge's line may record: the policy's announcement is played first.
    let bridge = r.bridge;
    r.w.uow.edit(|s| {
        for c in s.capabilities.iter_mut() {
            if c.capability.id == bridge {
                c.capability.connector_public["recording_allowed"] = json!(true);
            }
        }
    });
    let p = policy();
    let script = plan();
    let agent_lines = [
        "Randevunuz perşembe 14:00, uygun mu?",
        "Bir saniye, takvime bakıyorum.",
        "Perşembe 14:00 kaydedildi, görüşmek üzere.",
    ];
    let mut authored: Vec<String> = script.playable().map(str::to_owned).collect();
    authored.push(p.recording_announcement.clone());
    authored.extend(p.holding_default.iter().cloned());
    authored.extend(agent_lines.iter().map(|l| (*l).to_owned()));

    let call = r.place_at(0, script.clone()).await;
    let mut handed: Vec<BridgeCommand> = r.poll(1).await;
    r.report(5, call, json!([{ "kind": "answered" }])).await;
    handed.extend(r.poll(5).await);
    let announcement = handed
        .iter()
        .find(|c| c.payload["clip"] == "announcement")
        .map(|c| c.payload["seq"].clone())
        .expect("the announcement is played first");
    r.report(
        7,
        call,
        json!([{ "kind": "said", "seq": announcement }, { "kind": "said", "seq": announcement.as_u64().unwrap() + 1 }]),
    )
    .await;
    handed.extend(r.poll(7).await);
    r.utterance(9, call, "Evet?").await;
    r.say_at(11, call, agent_lines[0]).await;
    r.utterance(14, call, "Bir bakayım.").await;
    // The agent thinks long: holding phrases and a fallback line cover for it.
    for t in 15..=35 {
        r.timers(t).await;
        handed.extend(r.poll(t).await);
    }
    say::say(
        &r.w.deps,
        &r.agent_at(36),
        call,
        SayInput {
            text: agent_lines[1].into(),
            expect_reply: false,
            allow_barge_in: true,
        },
    )
    .await
    .unwrap();
    r.say_at(37, call, agent_lines[2]).await;
    calls::end(
        &r.w.deps,
        &r.agent_at(38),
        call,
        serde_json::from_value::<EndInput>(json!({ "outcome": "appointment" })).unwrap(),
    )
    .await
    .unwrap();
    handed.extend(r.poll(38).await);
    let kinds_handed = kinds(&handed);
    for kind in ["dial", "record", "say", "hangup"] {
        assert!(kinds_handed.contains(&kind.to_owned()), "{kinds_handed:?}");
    }
    let mut played = Vec::new();
    for c in &handed {
        if let Some(text) = c.payload.get("text").and_then(Value::as_str) {
            played.push(text.to_owned());
        }
        if c.kind == "dial" {
            let dialed: CallPlan = serde_json::from_value(c.payload["plan"].clone()).unwrap();
            assert_eq!(dialed, script);
        }
    }
    assert!(played.len() >= 9, "{played:?}");
    for text in &played {
        assert!(authored.contains(text), "the server composed {text:?}");
    }
    // The turn log holds the same sentences and no other.
    for turn in r.shown(call).await.turns {
        let key = turn_key(&serde_json::to_value(&turn).unwrap());
        if key.starts_with("say") || key == "holding" || key == "fallback" {
            assert!(
                authored.contains(&turn.text),
                "the server composed {:?}",
                turn.text
            );
        }
    }
}

#[tokio::test]
async fn erasure_takes_a_calls_commands_plan_and_bridge_notes() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    assert_eq!(kinds(&r.poll(1).await), ["dial"]);
    r.report(2, call, json!([{ "kind": "ringing" }])).await;
    // A sentence and a hangup queued, not yet taken, when the person is erased.
    r.report(5, call, json!([{ "kind": "answered" }])).await;
    let bridge_call_id = call.to_string();
    let before = r.w.uow.snapshot();
    assert!(before.calls.commands.iter().any(|c| c.call_id == call));
    assert!(
        before
            .calls
            .bridge_events
            .iter()
            .any(|(_, id, _)| *id == bridge_call_id)
    );
    jt_app::usecases::inbox::erasure::erase(
        &r.w.deps,
        &r.w.owner_ctx,
        r.person,
        jt_app::usecases::inbox::erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let after = r.w.uow.snapshot();
    // The dial (the number, the plan) and the queued sentence are gone, as are the notes of the
    // bridge's events on the call; the session keeps its times and state, not its number or plan.
    assert!(!after.calls.commands.iter().any(|c| c.call_id == call));
    assert!(
        !after
            .calls
            .bridge_events
            .iter()
            .any(|(_, id, _)| *id == bridge_call_id)
    );
    let session = after.calls.sessions.iter().find(|s| s.id == call).unwrap();
    assert!(session.counterpart_e164.is_empty());
    assert_eq!(session.plan, None);
    assert_eq!(session.state, CallState::Live);
    let wire = format!("{:?}", after.calls);
    assert!(!wire.contains("5321234567"), "{wire}");
    assert!(!wire.contains("Randevunuz için arıyorum"), "{wire}");
    // The call still on the line is ended by script all the same: without a plan, no sentence
    // is played, the line is hung up.
    r.utterance(10, call, "Alo?").await;
    for t in 11..=30 {
        r.timers(t).await;
    }
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], "ended");
    assert_eq!(shown.call["end_cause"]["cause"], "agent_timeout");
    let queued = r.poll(31).await;
    assert_eq!(kinds(&queued).last().map(String::as_str), Some("hangup"));
    for c in &queued {
        if let Some(text) = c.payload.get("text").and_then(Value::as_str) {
            assert!(policy().holding_default.iter().any(|h| h == text), "{text}");
        }
    }
}

#[tokio::test]
async fn bridge_commands_are_purged_after_seven_days() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    assert_eq!(r.w.uow.snapshot().calls.commands.len(), 1);
    let seven_days = 7 * 24 * 60 * 60;
    let report = jobs::run_purge_call_commands(&r.w.deps, later(seven_days)).await;
    assert_eq!(report, jobs::JobReport::default());
    let report = jobs::run_purge_call_commands(&r.w.deps, later(seven_days + 1)).await;
    assert_eq!((report.touched, report.changed, report.failed), (1, 1, 0));
    let snapshot = r.w.uow.snapshot();
    assert!(snapshot.calls.commands.is_empty());
    // The call and its log stay.
    assert!(snapshot.calls.sessions.iter().any(|s| s.id == call));
}

// ---------------------------------------------------------------------------------------------
// Recorded bridge sequences, replayed as contracts
// ---------------------------------------------------------------------------------------------

/// Replays `fixtures/voice/<name>.json`: the agent's actions, the bridge's polls (each command
/// acknowledged as it is taken) and reports, and the timers, each at its second; then checks the
/// call as the fixture expects it.
async fn replay(name: &str) {
    let path = format!(
        "{}/tests/fixtures/voice/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let r = rig().await;
    let plan: CallPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
    let mut call = None;
    let mut last_seq: Option<u64> = None;
    for step in fixture["script"].as_array().unwrap() {
        let t = step["t"].as_i64().unwrap();
        let note = step.to_string();
        if let Some(action) = step["agent"].as_str() {
            match action {
                "place" => call = Some(r.place_at(t, plan.clone()).await),
                "say" => {
                    say::say(
                        &r.w.deps,
                        &r.agent_at(t),
                        call.unwrap(),
                        SayInput {
                            text: step["text"].as_str().unwrap().into(),
                            expect_reply: step["expect_reply"].as_bool().unwrap_or(true),
                            allow_barge_in: true,
                        },
                    )
                    .await
                    .unwrap();
                }
                "listen" => {
                    let out = listen::listen(
                        &r.w.deps,
                        &r.agent_at(t),
                        call.unwrap(),
                        ListenQuery {
                            after_seq: step["after_seq"].as_u64().map(|s| s as u32),
                            wait_s: Some(0),
                        },
                    )
                    .await
                    .unwrap();
                    let got: Vec<String> = out
                        .events
                        .iter()
                        .map(|e| turn_key(&serde_json::to_value(e).unwrap()))
                        .collect();
                    assert_eq!(json!(got), step["expect"], "{name}: {note}");
                }
                "end" => {
                    calls::end(
                        &r.w.deps,
                        &r.agent_at(t),
                        call.unwrap(),
                        serde_json::from_value::<EndInput>(step["input"].clone()).unwrap(),
                    )
                    .await
                    .unwrap();
                }
                other => panic!("{name}: unknown agent action {other}"),
            }
        } else if let Some(action) = step["bridge"].as_str() {
            match action {
                "poll" => {
                    let taken = r.poll(t).await;
                    if let Some(seq) = taken.iter().rev().find_map(|c| c.payload["seq"].as_u64()) {
                        last_seq = Some(seq);
                    }
                    assert_eq!(json!(kinds(&taken)), step["expect"], "{name}: {note}");
                }
                "events" => {
                    let events: Vec<Value> = step["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| {
                            let mut e = e.clone();
                            if e["seq"] == "$last" {
                                e["seq"] = json!(last_seq.expect("a played command"));
                            }
                            e
                        })
                        .collect();
                    r.report(t, call.unwrap(), json!(events)).await;
                }
                other => panic!("{name}: unknown bridge action {other}"),
            }
        } else if step.get("timers").is_some() {
            let until = step["until"].as_i64().unwrap_or(t);
            for s in t..=until {
                r.timers(s).await;
            }
        } else {
            panic!("{name}: unknown step {note}");
        }
    }
    let call = call.unwrap();
    let expect = &fixture["expect"];
    let shown = r.shown(call).await;
    assert_eq!(shown.call["state"], expect["state"], "{name}");
    assert_eq!(
        shown.call["end_cause"]["cause"], expect["end_cause"],
        "{name}"
    );
    assert_eq!(shown.call["duration_s"], expect["duration_s"], "{name}");
    assert_eq!(json!(turn_keys(&shown)), expect["turns"], "{name}");
    let actions: Vec<String> =
        r.w.ledger("calls.")
            .iter()
            .map(|e| e.action.as_str().to_owned())
            .filter(|a| !a.starts_with("calls.bridge.") && a != "calls.policy_set")
            .collect();
    assert_eq!(json!(actions), expect["ledger"], "{name}");
    let made: Vec<bool> = call_made(&r, call).into_iter().map(|(c, _)| c).collect();
    assert_eq!(json!(made), expect["call_made"], "{name}");
    for entry in r.w.ledger("") {
        assert!(
            !entry.payload.to_string().contains("5321234567"),
            "{name}: {entry:?}"
        );
    }
}

#[tokio::test]
async fn replay_outbound_happy() {
    replay("outbound_happy").await;
}

#[tokio::test]
async fn replay_agent_silent() {
    replay("agent_silent").await;
}

#[tokio::test]
async fn replay_caller_hangup() {
    replay("caller_hangup").await;
}
