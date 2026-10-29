# Voice Sidecar (Free Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the connected agent on a real NetGSM phone call through a free, self-hosted voice stack on the existing Contabo host: Asterisk as the SIP edge for extension 102, a Rust talker that speaks the existing V1-T1/T2 bridge protocol, seda/Silero/Smart Turn for listening and EMA Lightning for speaking, with every turn measured.

**Architecture:** Asterisk 22.11 (`chan_websocket` + ARI, Docker, host network) owns SIP/RTP/DTMF and hands 20 ms G.711 frames to `jeeta-voice-bridge`, a new Rust workspace program in `rust/bridge/voice/`. The worker is a pure client: of Jeeta's `/api/voice/bridge/*` (loopback), of ARI, and of two network-less Python model servers on unix sockets (`jeeta-voice-listen`, `jeeta-voice-speak`). The core keeps the session's truth and authorship rules; the worker's per-call talker plays owner-approved phrases while the agent thinks, handles barge-in and closing, and reports a latency trace per turn. Core changes are additive and backward compatible (`jt_calls::wire`, policy openings and phrases, `calls.say{wait_reply_s}`).

**Tech Stack:** Rust 2024 (tokio, tokio-tungstenite 0.30, reqwest, serde, sha2), `jt_calls` domain crate; Asterisk 22.11.0 (source build, Debian bookworm, `chan_websocket`, `res_ari`, `chan_pjsip`); Python 3.12 (`sherpa-onnx==2.0.1`, `onnxruntime==1.31.1`, `silero-vad==6.2.3` model file, `transformers==5.21.0` feature extractor, `soxr==1.1.0`, `websockets==17.3`, `ema-lightning==1.1.2`, `antalia-mini==1.0.1`, CPU torch); Docker; systemd; React panel (vitest).

---

## 0. Read before starting

- Design addendum (what and why): `docs/superpowers/specs/2026-10-29-voice-sidecar-free-path-design.md`.
- Voice design (session, fence, protocol): `docs/superpowers/specs/2026-10-27-agent-voice-calls-design.md`.
- V-section of `docs/superpowers/plans/2026-10-27-cleanup-and-voice-plan.md` (V1-T1, V1-T2 are done; this plan is V1-T3; V2-T1 inbound duty stays out of scope).
- `docs/operations/voice-bridge.md` (key, routes, heartbeat; rewritten in task E4).
- The built code you extend: `rust/crates/jt_app/src/usecases/calls.rs`, `calls/{bridge,session,listen,say}.rs`, `usecases/bridges/kernel.rs`, `ports/bridges.rs`, `ports/calls.rs`, `rust/crates/domain/jt_calls/src/*`, `rust/crates/adapters/jt_panel_http/src/routes/voice_bridge.rs`, `bearer.rs`, `rust/crates/jt_app/src/catalog.rs` rows `calls.*`.
- The device bridge as the model of a workspace program that is not the server: `rust/bridge/device/` and its archtest rules in `rust/crates/jt_archtest/tests/dependency_boundaries.rs`.

Paths below are relative to the repository root unless they start with `/` (server paths).

## 1. Constraints that bind every task

1. **Free and self-hosted only.** No cloud STT/TTS, no new server, no GPU. Everything runs on the Contabo VPS (6 vCPU Broadwell 2.0 GHz AVX2, 11 GB RAM, ~29 neighbour containers). Prod Jeeta is `jeeta.service` on `127.0.0.1:8090`, staging `jeeta-staging.service` on `127.0.0.1:8091`.
2. **The server never composes a sentence.** Every text played is the plan's, the policy's (owner-approved) or the agent's. The talker selects among policy phrases; the core logs the policy text for each.
3. **The brain is unchanged.** Do not add, suggest or switch to a fast/reasoning-off model anywhere (code, tool descriptions, docs). Owner decision V-2.
4. **Never log** a phone number, transcript text, a sentence, audio, an audio path holding a number, a key or a password. Ledger and events carry only what spec §12 says.
5. **No raw audio storage.** Recording stays off. The only audio on disk is the policy-phrase cache.
6. **Hexagonal boundaries** (`rust/crates/jt_archtest`): the worker names no server crate (`jt_app`, `jt_pg`, adapters), only `jt_calls`; `reqwest` and `tokio-tungstenite` are allowed in `jeeta-voice-bridge` only (archtest + `rust/deny.toml`).
7. **Catalog discipline.** This plan adds no catalog row (`rust/crates/jt_app/tests/catalog.rs` keeps `assert_eq!(CATALOG.len(), 160)`). If a task ever needs a row, the catalog row, handler, permission, status-gate expectation in `catalog_is_the_release_table`, `jt_archtest/tests/{gate_rule,m4_productisation,twin_rule}.rs` and the count pin change in the same commit.
8. **Migrations.** None are needed: every new field lives in tolerant JSON (`workspace_policies.calls`, `call_sessions.data`, `call_commands.payload`) and new event kinds fit `call_bridge_events.kind` (`char_length 1..32`). If one becomes necessary it follows `rust/migrations/0016_voice_bridge.*`: repeatable guarded statements, ENABLE + FORCE RLS with the `0008` policy on any tenant table, a down that refuses unsafe states.
9. **Panel copy**: Turkish and English keys together (`rust/panel/src/i18n/{tr,en}.json`); the panel's i18n parity test must pass.
10. **No push, no PR, no deploy from a worker.** Deploy tasks (the server steps of B1–B3, B7, B8, D3, E1–E3) are run by the coordinator in the main session, with the owner's OK where marked. Workers implement and commit code tasks only.
11. **Prod deploy** of the core follows `/root/upgrade.sh` (backup → compat check → swap → readyz); staging first, with `sudo -u postgres pg_dump -p 5437 -Fc jeeta > /var/backups/jeeta-staging/pre-<sha8>-<stamp>.dump` before `staging-upgrade.sh`.

## 2. Where things run

| What | Windows dev machine | Linux CI (`.github/workflows/rust.yml`) | Contabo host |
|---|---|---|---|
| `cargo fmt --all -- --check` | yes | yes | — |
| `cargo test -p jt_calls` (pure domain) | **yes** | yes | — |
| `cargo test -p jeeta-voice-bridge` (all but the `cfg(unix)` socket transport) | **yes** | yes | — |
| `cargo clippy -p jeeta-voice-bridge --all-targets -- -D warnings` | yes | yes | — |
| `jt_app`, `jt_mcp`, `jt_panel_http`, `jt_archtest` tests (pull `jt_pg` through `jt_testkit`, unix only) | **no** | yes (`rust-test`, ~15 min) | — |
| `cargo clippy --locked -p jt_app --lib --features tokio/time -- -D warnings` | yes | — | — |
| `pnpm --dir rust/panel test` / `typecheck` | yes | yes | — |
| Python unit tests without models (`pytest -m "not models"`) | yes (Python 3.12) | yes (new job) | yes |
| Model-backed tests (`pytest -m models`), Docker images, Asterisk | no | no | **yes** |
| Real calls | no | no | yes, **owner's phone** |

When a step says "CI", push nothing yourself: the coordinator pushes the branch and reads the run. When a test cannot run locally, write it, run what compiles (`cargo check -p jt_app --tests` does not build on Windows either; rely on CI), and note it in the commit body.

## 3. Owner involvement (marked **[OWNER]** in tasks)

- **B7** the vertical-slice call to the owner's mobile (≈ 3 min of package).
- **B8** optional: route 0850 → 102 in the Netsantral portal (OTP login) and call 0850 once (≈ 2 min). Non-blocking.
- **E1** OK to upgrade staging (and later prod) with the Phase C release.
- **E3** the end-to-end acceptance calls (≈ 2 × 4 min).
- Open questions: the transcript notice text (lawyer), the staging workspace that hosts test calls (proposed: "Test Atölye", never "Jeeta Demo"), extra brand respellings.
- About 95 minutes of the NetGSM package remain (valid to 28.11.2026). This plan budgets ≈ 15.

## 4. The wire as it is today (quoted from the code at `a9c22b99`)

The worker must speak exactly this. Server-side envelope types, `rust/crates/jt_app/src/usecases/calls/bridge.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechToText { pub engine: String, pub model: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextToSpeech { pub engine: String, pub voice: String }

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterInput {
    pub extension: String,
    #[serde(default)]
    pub codecs: Vec<String>,
    pub max_calls: u8,
    pub stt: SpeechToText,
    pub tts: TextToSpeech,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RegisterOut { pub capability_id: CapabilityId, pub status: EffectiveStatus, pub heartbeat_s: u32 }

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsQuery {
    #[serde(default)] pub wait_s: Option<u32>,
    #[serde(default)] pub extension: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BridgeCommand {
    pub id: CallCommandId,
    pub call_id: CallId,
    pub bridge_call_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CommandsOut { pub commands: Vec<BridgeCommand>, pub timed_out: bool }

#[derive(Clone, Debug, Deserialize)]
pub struct EventIn {
    pub bridge_call_id: String,
    pub bridge_seq: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    #[serde(flatten)]
    pub event: BridgeEvent,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsInput { pub events: Vec<EventIn> }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct EventsOut { pub accepted: u32, pub duplicates: u32, pub unmatched: u32 }
```

Payload types, `rust/crates/domain/jt_calls/src/session.rs` and `plan.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeEvent {
    Inbound { from_e164: String, to_e164: String },
    Ringing,
    Answered,
    Utterance { text: String, is_final: bool,
        #[serde(default)] confidence: Option<f32>, #[serde(default)] stt_ms: Option<u32> },
    Dtmf { digit: String },
    Said { seq: u32, #[serde(default)] interrupted_at_char: Option<u32>, #[serde(default)] tts_ms: Option<u32> },
    Silence { ms: u32 },
    Recording { file_ref: String },
    Hangup { cause: String },
    Error { failure_line: String },
    CommandDone { id: CallCommandId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayKind { Opening, Holding, Fallback, Closing, Announcement }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Answer { greeting_text: String, then_record: bool },
    Dial { to_e164: String, plan: CallPlan },
    Say { seq: u32, text: String, allow_barge_in: bool },
    Play { seq: u32, clip: PlayKind, index: u8, text: String },
    Record { start: bool },
    Transfer { to: String },
    Hangup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallPlan {
    pub opening: String, pub goal: String, pub holding: Vec<String>,
    #[serde(default)] pub fallback: Vec<String>,
    pub closing: String, pub max_duration_s: u16,
    #[serde(default = "turkish")] pub language: String,
    #[serde(default = "yes")] pub disclose_assistant: bool,
}
```

The HTTP surface (`docs/operations/voice-bridge.md` §3): `POST /api/voice/bridge/register` every 15 s; `GET /api/voice/bridge/commands?wait_s=25&extension=102` (≤ 25 s long-poll, commands leased, re-delivered after 10 s unless acknowledged by an event `command_done{id}`); `POST /api/voice/bridge/events` (≤ 100 events, idempotent by `(bridge_call_id, bridge_seq)`, answer `{accepted, duplicates, unmatched}`). `Authorization: Bearer <calls.bridge key>` on all; `X-Requested-With: jeeta-panel` on POSTs. For an agent's call the session's `bridge_call_id` is its call id (`place_agent` sets `bridge_call_id: Some(id.to_string())`). The kernel wakes a parked poll on commit (`ports/bridges.rs` `BridgeSignals`) with a 1 s fallback tick (`kernel::FALLBACK_TICK`).

## 5. File structure

**Domain (`rust/crates/domain/jt_calls/`)**
- Create `src/wire.rs` — the bridge's HTTP envelopes (moved from `jt_app`), both directions serialisable, plus `BridgeCommand::{of, command}`.
- Create `src/trace.rs` — `TurnTrace`, `EndpointBy`, `Percentiles`, `LatencySummary`, `summarize`, alert thresholds.
- Create `src/opening.rs` — `genitive`, `outbound_opening`, `inbound_greeting`, `disclosure`, `TRANSCRIPT_NOTICE`, `CLOSING`.
- Create `src/phrases.rs` — `BridgePhrases` (owner-approved defaults), `PhraseSet`.
- Modify `src/policy.rs` — `opening_outbound`, `transcript_notice`, `closing`, `phrases`, `with_workspace`, `spoken_opening`.
- Modify `src/plan.rs` — `hotwords`; `closing` optional (empty: the policy's closing plays).
- Modify `src/session.rs` — `DialScript`, `Command::Dial{script}`, `BridgeEvent::{Phrase, Trace}`, `CallMetrics.traces`, `CallSession.phrases` (the phrases dialled with the call), reducer.
- Modify `src/lib.rs`, `Cargo.toml` (`serde_json` becomes a normal dependency).
- Tests: create `tests/wire.rs`, `tests/trace.rs`, `tests/opening.rs`, `tests/phrases.rs`, `tests/bridge_additions.rs`, `tests/policy_opening.rs`; modify `tests/support/mod.rs`.

**Core (`rust/crates/jt_app/`, adapters, panel)**
- Modify `src/usecases/calls/bridge.rs` (re-export the wire, `kind_of`), `src/usecases/calls.rs` (`policy_of`, disclosure over the spoken opening, dial script, latency in the view), `src/usecases/calls/session.rs`, `src/usecases/calls/listen.rs` (`wait_turns`), `src/usecases/calls/say.rs` (`wait_reply_s`).
- Tests: modify `tests/calls_session.rs`, `tests/calls_bridge.rs`.
- Modify `rust/crates/adapters/jt_mcp/src/tools/calls.rs` (schemas, descriptions); test `rust/crates/adapters/jt_mcp/tests/calls_mcp.rs`.
- Modify `rust/panel/src/api/calls.ts`, `pages/CallsPolicy.tsx`, `pages/CallDetail.tsx`, `i18n/{tr,en}.json`; tests `pages/CallsPolicy.test.tsx`, `pages/CallDetail.test.tsx`.
- Modify `rust/crates/jt_archtest/tests/dependency_boundaries.rs`, `rust/deny.toml`, `rust/Cargo.toml` (member + workspace deps).

**Worker (`rust/bridge/voice/`, package `jeeta-voice-bridge`)**
- `Cargo.toml`
- `src/main.rs` — `run` | `slice` | `report` | `check`.
- `src/lib.rs` — module map and the logging rule.
- `src/config.rs` — environment configuration.
- `src/g711.rs` — A-law/μ-law.
- `src/text.rs` — sentence split with character offsets; backchannel words.
- `src/netgsm.rs` — E.164 → NetGSM dial string; Q.850 → hangup cause word.
- `src/talker.rs` — the pure per-call state machine.
- `src/trace.rs` — the per-turn trace builder (monotonic) and the JSONL writer.
- `src/cache.rs` — phrase cache (disk for policy texts, memory per call).
- `src/ari.rs` — ARI REST client and event parser.
- `src/media.rs` — `chan_websocket` control parser and command builder.
- `src/speech.rs` — socket endpoints, listen/speak message types and clients.
- `src/call.rs` — one call's task: ARI, media, listener, speaker, talker, reports.
- `src/jeeta.rs` — the core client (register, commands, events).
- `src/run_loop.rs` — heartbeat, poll loop, call registry.
- `src/slice.rs` — the standalone vertical slice.
- Tests: `tests/g711.rs`, `tests/text.rs`, `tests/netgsm.rs`, `tests/talker.rs`, `tests/logging.rs`, `tests/adapters.rs`, `tests/call.rs`, `tests/jeeta_client.rs`, `tests/run_loop.rs`, `tests/support/mod.rs`.
- Speech services: `speech/listen/{jeeta_listen.py,endpoint.py,hotwords.py,features.py,vad.py,turn.py,asr.py,listen_pins.py,models.lock,requirements.txt,constraints.txt,wheels.sha256,requirements.lock,Dockerfile,.dockerignore}`, `speech/listen/tests/{test_listen_endpoint.py,test_listen_hotwords.py,test_listen_features.py,test_listen_session.py,test_listen_protocol.py,test_listen_pins.py,test_listen_image.py,test_listen_models.py,listen_audio.py,make_fixtures.py,probe_socket.py}`, `speech/listen/tests/fixtures/{yarin,pause,digits,names}.alaw`, `fixtures.json`, `whisper_features.json`; `speech/speak/{jeeta_speak.py,respell.py,respell.json,pins.py,weights.lock,requirements.txt,constraints.txt,wheels.sha256,torch.lock,requirements.lock,Dockerfile,.dockerignore}`, `speech/speak/tests/{test_speak_respell.py,test_speak_session.py,test_speak_mouth.py,test_speak_pins.py,test_speak_image.py,test_speak_models.py}`; `speech/pytest.ini`.
- Asterisk: `asterisk/Dockerfile`, `asterisk/etc/{asterisk.conf,modules.conf,logger.conf,cdr.conf,cel.conf,pjsip.conf,extensions.conf,http.conf,ari.conf,rtp.conf}`, `asterisk/test_configs.py`, `asterisk/test_target.py`.
- Deploy: `deploy/{jeeta-asterisk.service,jeeta-voice-listen.service,jeeta-voice-speak.service,jeeta-voice-bridge.service,jeeta-voice.tmpfiles,bridge.env.example,images.env.example,jeeta-voice-target}`.
- CI: modify `.github/workflows/rust.yml` (Python unit tests and the Linux worker artifact).
- Docs: rewrite `docs/operations/voice-bridge.md` (E4).

## 6. Phases

| Phase | Tasks | Produces |
|---|---|---|
| **A — pure foundations** | A1 wire home, A2 trace, A3 opening/genitive, A4 phrases, A5 the wire's additions in the domain (dial script, hotwords, phrase and trace events) | Shared types the worker and the core compile against; all testable on Windows |
| **B — the vertical slice (riskiest first)** | B1 Asterisk + ext 102, B2 speak service, B3 listen service, B4 worker crate and its pure modules (codec, text, NetGSM, talker), B5 worker adapters (config, cache, trace, ARI, media, speech), B6 the call task and `slice`, **B7 [OWNER] slice call**, B8 inbound investigation | Real audio through Asterisk to and from the engines: register 102, call the owner, play the cached opening, transcribe one turn, play an EMA reply, print the trace. Go/no-go before any polishing |
| **C — core protocol additions** | C1 the workspace opening and notice come first, C2 the core fills the dial script (and MCP hotwords), C3 phrases and traces reach the turn log and the call view, C4 `say{wait_reply_s}` + tool texts, C5 panel | The core plays the approved opening, logs bridge phrases, keeps traces, merges say+listen |
| **D — the talker against the core** | D1 Jeeta client, D2 run loop, D3 deploy the worker on staging | The worker is the workspace's line |
| **E — release and acceptance** | E1 release core to staging (then prod), E2 environment switch, **E3 [OWNER] e2e acceptance**, E4 docs | A measured agent call to the owner's mobile |


Every commit in this plan ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (shown once per commit step as a second `-m`).

---

## Phase A — pure foundations (Windows-testable)

### Task A1: The bridge's wire moves into `jt_calls::wire`

**Files:**
- Create: `rust/crates/domain/jt_calls/src/wire.rs`
- Create: `rust/crates/domain/jt_calls/tests/wire.rs`
- Modify: `rust/crates/domain/jt_calls/src/lib.rs`
- Modify: `rust/crates/domain/jt_calls/Cargo.toml`
- Modify: `rust/crates/jt_app/src/usecases/calls/bridge.rs` (the struct definitions between `// Register` and `// Events` sections, and `impl From<QueuedCommand> for BridgeCommand`)

- [ ] **Step 1: Write the failing test**

`rust/crates/domain/jt_calls/tests/wire.rs`:

```rust
//! The voice bridge's HTTP bodies read and write the same in the server and the bridge program.
use jt_calls::wire::{
    BridgeCommand, CommandsQuery, EventsInput, RegisterInput, RegisterOut,
};
use jt_calls::{BridgeEvent, CallCommandId, CallId, CallPlan, Command, PlayKind};
use serde_json::json;
use uuid::Uuid;

fn plan() -> CallPlan {
    serde_json::from_value(json!({
        "opening": "Ahmet Bey ile mi görüşüyorum?",
        "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."],
        "closing": "Görüşmek üzere, iyi günler.",
        "max_duration_s": 300,
    }))
    .unwrap()
}

#[test]
fn every_command_kind_round_trips_through_the_wire() {
    let commands = vec![
        Command::Answer { greeting_text: "Merhaba.".into(), then_record: false },
        Command::Dial { to_e164: "+905321234567".into(), plan: plan() },
        Command::Say { seq: 3, text: "Tamam.".into(), allow_barge_in: true },
        Command::Play { seq: 4, clip: PlayKind::Closing, index: 0, text: "İyi günler.".into() },
        Command::Record { start: false },
        Command::Transfer { to: "101".into() },
        Command::Hangup,
    ];
    for c in commands {
        let wire = BridgeCommand::of(
            CallCommandId(Uuid::nil()),
            CallId(Uuid::nil()),
            Some("c-1".into()),
            &c,
        );
        let text = serde_json::to_string(&wire).unwrap();
        let back: BridgeCommand = serde_json::from_str(&text).unwrap();
        assert_eq!(back, wire, "{text}");
        assert!(back.payload.get("kind").is_none(), "{text}");
        assert_eq!(back.command().unwrap(), c, "{text}");
    }
}

#[test]
fn events_input_reads_the_documented_batch_and_writes_it_back() {
    let batch = json!({ "events": [
        { "bridge_call_id": "c-1", "bridge_seq": 1, "at": "2026-10-28T09:00:01Z", "kind": "ringing" },
        { "bridge_call_id": "c-1", "bridge_seq": 2, "at": "2026-10-28T09:00:04Z", "kind": "command_done",
          "id": "00000000-0000-0000-0000-000000000000" },
        { "bridge_call_id": "c-1", "bridge_seq": 3, "at": "2026-10-28T09:00:06Z", "kind": "utterance",
          "text": "evet", "is_final": true, "confidence": 0.5, "stt_ms": 80 }
    ]});
    let read: EventsInput = serde_json::from_value(batch).unwrap();
    assert_eq!(read.events.len(), 3);
    assert!(matches!(read.events[2].event, BridgeEvent::Utterance { is_final: true, .. }));
    let again: EventsInput = serde_json::from_value(serde_json::to_value(&read).unwrap()).unwrap();
    assert_eq!(again.events[1].bridge_seq, 2);
    assert!(matches!(again.events[1].event, BridgeEvent::CommandDone { .. }));
}

#[test]
fn register_input_refuses_unknown_fields() {
    let body = json!({
        "extension": "102", "codecs": ["PCMA"], "max_calls": 1,
        "stt": { "engine": "seda", "model": "seda-v0.1" },
        "tts": { "engine": "ema", "voice": "ema-lightning-1.1.2" },
        "version": "0.1.0", "extra": 1,
    });
    assert!(serde_json::from_value::<RegisterInput>(body).is_err());
}

#[test]
fn commands_query_writes_only_what_is_set() {
    let q = CommandsQuery { wait_s: Some(25), extension: None };
    assert_eq!(serde_json::to_value(&q).unwrap(), json!({ "wait_s": 25 }));
}

#[test]
fn register_out_reads_the_servers_answer() {
    let out: RegisterOut = serde_json::from_value(json!({
        "capability_id": "00000000-0000-0000-0000-000000000000",
        "status": "verified",
        "heartbeat_s": 15,
    }))
    .unwrap();
    assert_eq!(out.heartbeat_s, 15);
}
```

- [ ] **Step 2: Run it to see it fail**

Run (from `rust/`): `cargo test -p jt_calls --test wire`
Expected: FAIL to compile with `unresolved import jt_calls::wire`.

- [ ] **Step 3: Write `wire.rs`**

`rust/crates/domain/jt_calls/src/wire.rs`:

```rust
//! The voice bridge's HTTP bodies (spec `2026-10-27-agent-voice-calls-design.md` §10, routes
//! `/api/voice/bridge/*`), shared by the server (`jt_app::usecases::calls::bridge`, which re-exports
//! them under these names) and the bridge program (`jeeta-voice-bridge`), so that the two cannot
//! drift. Each type reads and writes both ways: the server reads what the bridge writes and the
//! bridge reads what the server writes. The limits are the server's; these types carry shapes only.

use jt_capability::{CapabilityId, EffectiveStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;

use crate::session::{BridgeEvent, Command};
use crate::{CallCommandId, CallId};

/// The bridge's speech-to-text engine and its model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechToText {
    pub engine: String,
    pub model: String,
}

/// The bridge's text-to-speech engine and its voice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextToSpeech {
    pub engine: String,
    pub voice: String,
}

/// `calls.bridge.register`: what the bridge reports of itself. `extension` is its PBX extension
/// (1 to 16 digits), `codecs` at most 8 names (`[A-Za-z0-9._-]`, 1 to 16 characters each),
/// `max_calls` how many calls it carries at once (1 to 8), the engines' names 1 to 32 characters
/// of `[a-z0-9_-]`, the model, voice and version 1 to 128 characters without control characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterInput {
    pub extension: String,
    #[serde(default)]
    pub codecs: Vec<String>,
    pub max_calls: u8,
    pub stt: SpeechToText,
    pub tts: TextToSpeech,
    pub version: String,
}

/// What a registration answers: the bridge's capability, its status now, and how often to
/// register again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterOut {
    pub capability_id: CapabilityId,
    pub status: EffectiveStatus,
    pub heartbeat_s: u32,
}

/// `calls.bridge.commands`: how long to wait for a command (at most 25 seconds, which is also
/// what an absent `wait_s` waits), and which bridge is asking (its extension; the workspace's only
/// bridge when left out).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_s: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
}

/// A command as the bridge takes it: `kind` names it (`dial`, `play`, `say`, `hangup`, ...) and
/// `payload` carries the rest of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeCommand {
    pub id: CallCommandId,
    pub call_id: CallId,
    pub bridge_call_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

impl BridgeCommand {
    /// Command `command` (id `id`, of call `call_id`, which the bridge knows as `bridge_call_id`)
    /// as a poll hands it out: its `kind` apart, its other fields in `payload`.
    pub fn of(
        id: CallCommandId,
        call_id: CallId,
        bridge_call_id: Option<String>,
        command: &Command,
    ) -> BridgeCommand {
        let mut payload =
            serde_json::to_value(command).unwrap_or_else(|_| Value::Object(Map::new()));
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("kind");
        }
        BridgeCommand {
            id,
            call_id,
            bridge_call_id,
            kind,
            payload,
        }
    }

    /// The command, read back from its kind and fields; an error for a kind or a field this build
    /// does not know.
    pub fn command(&self) -> Result<Command, serde_json::Error> {
        let mut fields = match &self.payload {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        fields.insert("kind".to_owned(), Value::String(self.kind.clone()));
        serde_json::from_value(Value::Object(fields))
    }
}

/// What a poll answers: the commands now the bridge's, oldest first, and whether it waited its
/// whole time for none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandsOut {
    pub commands: Vec<BridgeCommand>,
    pub timed_out: bool,
}

/// One event the bridge reports: its id of the call, the event's number in that call (the bridge
/// counts up from 1), when it happened, and what it is (`kind` and its fields, as [`BridgeEvent`]
/// reads them).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventIn {
    pub bridge_call_id: String,
    pub bridge_seq: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    #[serde(flatten)]
    pub event: BridgeEvent,
}

/// `calls.bridge.events`: at most 100 events, of any of the bridge's calls.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsInput {
    pub events: Vec<EventIn>,
}

/// What a batch did: the events applied now, those applied before (a retry), and those of a call
/// the bridge has no session for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventsOut {
    pub accepted: u32,
    pub duplicates: u32,
    pub unmatched: u32,
}
```

In `rust/crates/domain/jt_calls/src/lib.rs` add after `mod timers;`:

```rust
pub mod wire;
```

In `rust/crates/domain/jt_calls/Cargo.toml` move `serde_json.workspace = true` from `[dev-dependencies]` to `[dependencies]` (the dev section keeps nothing else; delete the empty `[dev-dependencies]` header). `serde_json` is on the domain allowlist (`DOMAIN_ALLOW` in `jt_archtest/tests/dependency_boundaries.rs`).

- [ ] **Step 4: Run the new test**

Run: `cargo test -p jt_calls --test wire`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 5: Point the server at the shared types**

In `rust/crates/jt_app/src/usecases/calls/bridge.rs`, delete the definitions of `SpeechToText`, `TextToSpeech`, `RegisterInput`, `RegisterOut`, `CommandsQuery`, `BridgeCommand`, `CommandsOut`, `EventIn`, `EventsInput`, `EventsOut` (their doc comments now live in `wire.rs`) and replace the body of `impl From<QueuedCommand> for BridgeCommand` so the block reads:

```rust
pub use jt_calls::wire::{
    BridgeCommand, CommandsOut, CommandsQuery, EventIn, EventsInput, EventsOut, RegisterInput,
    RegisterOut, SpeechToText, TextToSpeech,
};

impl From<QueuedCommand> for BridgeCommand {
    fn from(q: QueuedCommand) -> Self {
        BridgeCommand::of(q.id, q.call_id, q.bridge_call_id, &q.command)
    }
}
```

Delete the imports clippy then reports unused in `bridge.rs` (`Deserialize`, `Serialize` and `OffsetDateTime` may be among them).

- [ ] **Step 6: Check the server still compiles and lints**

Run (Windows works): `cargo clippy --locked -p jt_app --lib --features tokio/time -- -D warnings`
Expected: no warnings. Run `cargo fmt --all -- --check`: no diff.
CI (Linux) runs `cargo test --locked --workspace`; expected: every existing `calls_bridge` and `calls_session` test passes unchanged (the types and their JSON are identical).

- [ ] **Step 7: Commit**

```bash
git add rust/crates/domain/jt_calls rust/crates/jt_app/src/usecases/calls/bridge.rs
git commit -m "refactor(calls): the voice bridge's wire types live in jt_calls::wire" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A2: The per-turn latency trace and its p50/p95

**Files:**
- Create: `rust/crates/domain/jt_calls/src/trace.rs`
- Create: `rust/crates/domain/jt_calls/tests/trace.rs`
- Modify: `rust/crates/domain/jt_calls/src/lib.rs`

- [ ] **Step 1: Write the failing test**

`rust/crates/domain/jt_calls/tests/trace.rs`:

```rust
//! A caller turn's timings and their percentiles (design addendum §7).
use jt_calls::{
    AgentReply, BARGE_IN_P95_ALERT_MS, CONTENT_P95_ALERT_MS, EndpointBy, PERCEIVED_P95_ALERT_MS,
    TurnTrace, percentiles, summarize,
};

fn turn(ack: Option<u32>, first_audio: Option<u32>) -> TurnTrace {
    TurnTrace {
        endpoint_ms: 260,
        endpoint_by: Some(EndpointBy::SmartTurn),
        stt_final_ms: 310,
        delivered_ms: Some(340),
        say_ms: Some(4_340),
        tts_first_ms: Some(4_700),
        first_audio_ms: first_audio,
        ack_ms: ack,
        barge_in_stop_ms: None,
        backchannel_cut: false,
        reply_seq: None,
    }
}

#[test]
fn nearest_rank_percentiles() {
    let p = percentiles([400, 100, 300, 200]);
    assert_eq!((p.n, p.p50, p.p95), (4, Some(200), Some(400)));
    let p = percentiles(1..=100);
    assert_eq!((p.n, p.p50, p.p95), (100, Some(50), Some(95)));
    let p = percentiles([7]);
    assert_eq!((p.p50, p.p95), (Some(7), Some(7)));
    let p = percentiles(std::iter::empty());
    assert_eq!((p.n, p.p50, p.p95), (0, None, None));
}

#[test]
fn perceived_is_the_first_sound_and_content_the_reply() {
    let t = turn(Some(620), Some(4_760));
    assert_eq!(t.perceived_ms(), Some(620));
    assert_eq!(t.core_round_ms(), Some(4_000));
    assert_eq!(turn(None, Some(900)).perceived_ms(), Some(900));
    assert_eq!(turn(None, None).perceived_ms(), None);
}

#[test]
fn summary_alerts_on_the_reports_thresholds() {
    let traces = vec![turn(Some(620), Some(4_760)), turn(Some(640), Some(3_900))];
    let s = summarize(&traces, &[4_100, 3_200], &[]);
    assert_eq!(s.turns, 2);
    assert_eq!(s.perceived.p95, Some(640));
    assert_eq!(s.content.p95, Some(4_760));
    assert_eq!(s.agent.p50, Some(3_200));
    assert!(s.content.p95.unwrap() > CONTENT_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["content_p95_over_3s".to_owned()]);
    let slow = vec![turn(Some(1_200), Some(1_500))];
    let s = summarize(&slow, &[], &[]);
    assert!(s.perceived.p95.unwrap() > PERCEIVED_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["perceived_p95_over_1s".to_owned()]);
    let mut cut = turn(Some(600), Some(900));
    cut.barge_in_stop_ms = Some(BARGE_IN_P95_ALERT_MS + 50);
    assert_eq!(
        summarize(&[cut], &[], &[]).alerts,
        vec!["barge_in_p95_over_300ms".to_owned()]
    );
    assert!(summarize(&[], &[], &[]).alerts.is_empty());
}

#[test]
fn a_trace_reads_tolerantly() {
    let t: TurnTrace = serde_json::from_value(serde_json::json!({
        "endpoint_ms": 250, "stt_final_ms": 300
    }))
    .unwrap();
    assert_eq!(t.endpoint_by, None);
    assert_eq!(t.first_audio_ms, None);
    assert_eq!(t.reply_seq, None);
    let t: TurnTrace = serde_json::from_value(serde_json::json!({ "reply_seq": 7 })).unwrap();
    assert_eq!(t.reply_seq, Some(7));
}

// Added in the A2 fix-up: the thresholds are strict (a p95 exactly at the limit is no alert).

#[test]
fn a_p95_exactly_at_a_limit_raises_no_alert_and_one_millisecond_over_does() {
    assert_eq!(
        (
            PERCEIVED_P95_ALERT_MS,
            CONTENT_P95_ALERT_MS,
            BARGE_IN_P95_ALERT_MS
        ),
        (1_000, 3_000, 300)
    );
    let mut at = turn(Some(1_000), Some(3_000));
    at.barge_in_stop_ms = Some(300);
    let s = summarize(&[at], &[], &[]);
    assert_eq!(s.perceived.p95, Some(1_000));
    assert_eq!(s.content.p95, Some(3_000));
    assert_eq!(s.barge_in_stop.p95, Some(300));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);

    let mut over = turn(Some(1_001), Some(3_001));
    over.barge_in_stop_ms = Some(301);
    assert_eq!(
        summarize(&[over], &[], &[]).alerts,
        [
            "perceived_p95_over_1s",
            "content_p95_over_3s",
            "barge_in_p95_over_300ms"
        ]
    );
}

#[test]
fn each_alert_is_raised_on_its_own_measure_only() {
    // Perceived is the smaller of the acknowledgement and the reply, so a slow reply behind a
    // quick acknowledgement alerts on content alone.
    let quick_ack_slow_reply = turn(Some(500), Some(3_500));
    assert_eq!(
        summarize(&[quick_ack_slow_reply], &[], &[]).alerts,
        ["content_p95_over_3s"]
    );
    // A turn with no sound at all alerts on nothing: there is nothing to measure.
    assert!(summarize(&[turn(None, None)], &[], &[]).alerts.is_empty());
}

#[test]
fn the_p95_of_twenty_turns_ignores_only_the_worst_one() {
    let slow = |ms| turn(Some(ms), Some(ms));
    let mut traces = vec![slow(600); 19];
    traces.push(slow(5_000));
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.perceived.p95, Some(600));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);
    traces[18] = slow(5_000);
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.perceived.p95, Some(5_000));
    assert_eq!(s.alerts, ["perceived_p95_over_1s", "content_p95_over_3s"]);
}

#[test]
fn nearest_rank_is_the_smallest_rank_covering_the_share_for_every_size() {
    // Pinned against the definition itself (the smallest k with k / n >= q), not against a
    // formula: no rounding of a float product may move a rank by one.
    for n in 1..=400_u32 {
        let p = percentiles(1..=n);
        let smallest = |num: u32, den: u32| (1..=n).find(|k| k * den >= num * n).unwrap();
        assert_eq!(p.n, n);
        assert_eq!(p.p50, Some(smallest(50, 100)), "n = {n}");
        assert_eq!(p.p95, Some(smallest(95, 100)), "n = {n}");
    }
    assert_eq!(percentiles(1..=20).p95, Some(19));
    assert_eq!(percentiles(1..=40).p95, Some(38));
    assert_eq!(percentiles(1..=21).p95, Some(20));
}

#[test]
fn percentiles_ignore_input_order_and_keep_duplicates() {
    let p = percentiles([5, 1, 5, 5, 1, 9]);
    assert_eq!((p.n, p.p50, p.p95), (6, Some(5), Some(9)));
}

// Added in the third A2 fix-up: the transport overhead, matched by the reply's seq.

/// A turn the core answered: its trace names the agent `say` (`reply_seq`) that arrived `say_ms`
/// after speech end, the core having answered the utterance `delivered_ms` after it.
fn answered(reply_seq: u32, delivered_ms: u32, say_ms: u32) -> TurnTrace {
    TurnTrace {
        delivered_ms: Some(delivered_ms),
        say_ms: Some(say_ms),
        reply_seq: Some(reply_seq),
        ..TurnTrace::default()
    }
}

/// The last turn of a call, which the agent never answered: a trace with no reply.
fn unanswered() -> TurnTrace {
    TurnTrace {
        delivered_ms: Some(300),
        ..TurnTrace::default()
    }
}

fn reply(seq: u32, latency_ms: u32) -> AgentReply {
    AgentReply { seq, latency_ms }
}

#[test]
fn transport_is_the_core_round_less_the_latency_of_the_named_reply() {
    // The replies are listed in the other order: the match is by seq, not by position.
    let traces = [answered(3, 340, 4_340), answered(7, 100, 3_100)];
    let replies = [reply(7, 2_950), reply(3, 3_900)];
    let s = summarize(&traces, &[3_900, 2_950], &replies);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (2, Some(50), Some(100))
    );
    // The measures that do not need the pairing are unchanged.
    assert_eq!(s.core_round.n, 2);
    assert_eq!(s.agent.n, 2);
}

#[test]
fn a_trace_without_a_reply_seq_is_left_out_of_transport() {
    let mut no_key = answered(3, 340, 4_340);
    no_key.reply_seq = None;
    let s = summarize(&[no_key, unanswered()], &[3_900], &[reply(3, 3_900)]);
    assert_eq!(s.transport, Default::default());
    // A trace whose say came before the core answered has no core round either.
    let backwards = answered(3, 500, 400);
    let s = summarize(&[backwards], &[3_900], &[reply(3, 3_900)]);
    assert_eq!(s.transport.n, 0);
}

#[test]
fn a_seq_with_no_latency_is_left_out_of_transport() {
    // The agent spoke when nothing was owed (no latency recorded), or the seq is a core `play`.
    let traces = [answered(3, 340, 4_340), answered(9, 100, 3_100)];
    let s = summarize(&traces, &[3_900], &[reply(3, 3_900)]);
    assert_eq!((s.transport.n, s.transport.p95), (1, Some(100)));
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.transport, Default::default());
}

#[test]
fn transport_saturates_at_zero_when_the_two_windows_differ_by_the_post_tail() {
    // The core's wait began when it took the utterance; the bridge's round began when its POST was
    // answered, a little later: the core's latency can exceed the bridge's round.
    let s = summarize(&[answered(3, 400, 4_300)], &[3_950], &[reply(3, 3_950)]);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (1, Some(0), Some(0))
    );
}

#[test]
fn the_e3_scripts_shapes_pair_what_they_can() {
    // Three caller turns, the last unanswered, two replies: two pairs.
    let traces = [
        answered(2, 300, 2_300),
        answered(4, 300, 3_300),
        unanswered(),
    ];
    let s = summarize(
        &traces,
        &[2_000, 3_000],
        &[reply(2, 2_000), reply(4, 3_000)],
    );
    assert_eq!(s.turns, 3);
    assert_eq!((s.transport.n, s.transport.p95), (2, Some(0)));
    // Two caller turns, the last unanswered, one reply: one pair.
    let traces = [answered(2, 300, 2_380), unanswered()];
    let s = summarize(&traces, &[2_000], &[reply(2, 2_000)]);
    assert_eq!((s.transport.n, s.transport.p95), (1, Some(80)));
    // A latency no trace names (a key press the agent answered, a say after a fallback line) is
    // simply not used, and the counts need not agree.
    let traces = [answered(2, 300, 2_300), answered(4, 300, 3_340)];
    let replies = [
        reply(2, 2_000),
        reply(4, 3_000),
        reply(6, 1_200),
        reply(8, 900),
    ];
    let s = summarize(&traces, &[2_000, 3_000, 1_200, 900], &replies);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (2, Some(0), Some(40))
    );
}

#[test]
fn the_first_latency_of_a_seq_is_the_one_used() {
    let s = summarize(
        &[answered(3, 340, 4_340)],
        &[3_900, 1_000],
        &[reply(3, 3_900), reply(3, 1_000)],
    );
    assert_eq!(s.transport.p95, Some(100));
}

#[test]
fn transport_is_not_an_alert() {
    let s = summarize(&[answered(3, 100, 5_100)], &[1_000], &[reply(3, 1_000)]);
    assert_eq!(s.transport.p95, Some(4_000));
    assert!(
        !s.alerts.iter().any(|a| a.contains("transport")),
        "{:?}",
        s.alerts
    );
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p jt_calls --test trace`
Expected: FAIL to compile (`TurnTrace` not found in `jt_calls`).

- [ ] **Step 3: Write `trace.rs`**

`rust/crates/domain/jt_calls/src/trace.rs`:

```rust
//! What one caller turn took, as the voice bridge measured it (design addendum
//! `2026-10-29-voice-sidecar-free-path-design.md` §7), and the percentiles of a call's turns. Every
//! field is an offset in milliseconds from the caller's end of speech (the last voiced 20 ms
//! frame), on the bridge's monotonic clock, except `barge_in_stop_ms`, a duration from the caller's
//! onset (the first voiced frame of the interruption) to the agent's voice stopping, and
//! `reply_seq`, the number of the agent's `say` that `say_ms` timed. Numbers only: a trace never
//! carries a word or a number dialled.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The first sound the caller hears after speaking (perceived latency): alert above this p95.
pub const PERCEIVED_P95_ALERT_MS: u32 = 1_000;
/// The first sound of the agent's real reply (content latency): alert above this p95.
pub const CONTENT_P95_ALERT_MS: u32 = 3_000;
/// The caller's onset to the agent's voice stopping when the caller cuts in: alert above this p95.
pub const BARGE_IN_P95_ALERT_MS: u32 = 300;
/// The most traces one call keeps.
pub const MAX_TRACES: usize = 200;

/// What decided that the caller's turn had ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointBy {
    /// The turn model judged it complete after a short pause.
    SmartTurn,
    /// The silence ran past the fallback.
    Fallback,
}

/// The timings of one caller turn (offsets from the end of speech, bar `barge_in_stop_ms` and the
/// `reply_seq` key).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TurnTrace {
    /// The end of the turn was decided.
    pub endpoint_ms: u32,
    pub endpoint_by: Option<EndpointBy>,
    /// The final transcript was ready.
    pub stt_final_ms: u32,
    /// The core answered the utterance's report.
    pub delivered_ms: Option<u32>,
    /// The reply's first sentence (`say` or `play`) reached the bridge.
    pub say_ms: Option<u32>,
    /// The reply's first synthesised audio was ready.
    pub tts_first_ms: Option<u32>,
    /// The reply's first frame was written to the line.
    pub first_audio_ms: Option<u32>,
    /// The first frame of a phrase the bridge played on its own (acknowledgement, filler).
    pub ack_ms: Option<u32>,
    /// When the caller cut the reply: a duration from the caller's onset (not from the end of
    /// speech) to the agent's voice stopping.
    pub barge_in_stop_ms: Option<u32>,
    /// The caller cut the reply with words that were only acknowledgement ("hı hı", "evet").
    pub backchannel_cut: bool,
    /// The `seq` of the agent `say` whose arrival `say_ms` timed: the key that pairs this turn with
    /// the core's own latency for that sentence ([`AgentReply`]). `None` when no `say` arrived.
    pub reply_seq: Option<u32>,
}

impl TurnTrace {
    /// The first sound the caller heard after speaking: a local phrase or the reply.
    pub fn perceived_ms(&self) -> Option<u32> {
        match (self.ack_ms, self.first_audio_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// From the core taking the caller's words to the reply reaching the bridge: the agent's think
    /// time plus both hops.
    pub fn core_round_ms(&self) -> Option<u32> {
        self.say_ms?.checked_sub(self.delivered_ms?)
    }
}

/// What the core measured for one agent `say`: its turn `seq` (the number a bridge trace carries
/// as `reply_seq`) and the wait the sentence ended, in milliseconds from the moment the agent owed
/// one (the caller's final words, a key press, a fallback line) to the `say`. One per `say` that
/// ended a wait, so the list can be longer or shorter than the call's traces: the match is by `seq`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReply {
    pub seq: u32,
    pub latency_ms: u32,
}

/// How many values, and their nearest-rank median and 95th percentile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Percentiles {
    pub n: u32,
    pub p50: Option<u32>,
    pub p95: Option<u32>,
}

/// The nearest-rank percentiles of `values`: the value at rank `ceil(q * n)`, worked out in
/// integers so that no rounding of a float product can move a rank by one.
pub fn percentiles(values: impl IntoIterator<Item = u32>) -> Percentiles {
    let mut v: Vec<u32> = values.into_iter().collect();
    v.sort_unstable();
    let rank = |percent: usize| -> Option<u32> {
        if v.is_empty() {
            return None;
        }
        let k = (percent * v.len()).div_ceil(100);
        v.get(k.clamp(1, v.len()) - 1).copied()
    };
    Percentiles {
        n: u32::try_from(v.len()).unwrap_or(u32::MAX),
        p50: rank(50),
        p95: rank(95),
    }
}

/// A call's latency: each measure's percentiles over its turns, and the alerts the thresholds
/// raise (`perceived_p95_over_1s`, `content_p95_over_3s`, `barge_in_p95_over_300ms`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatencySummary {
    pub turns: u32,
    pub perceived: Percentiles,
    pub content: Percentiles,
    pub endpoint: Percentiles,
    pub stt_final: Percentiles,
    pub core_round: Percentiles,
    /// The agent's reply time as the core measured it (`CallMetrics::agent_latency_ms`).
    pub agent: Percentiles,
    pub barge_in_stop: Percentiles,
    /// What the bridge-to-core hops added, per turn: `core_round_ms` less the core's latency for the
    /// reply the trace names, saturating at 0 (the two windows differ by the tail of the utterance
    /// POST). Only the turns whose reply has both a `reply_seq` and a recorded latency count. A
    /// reply that followed a fallback line has its latency counted from the fallback, so it
    /// overstates the hop. Reported, never an alert (the acceptance gate is p95 ≤ 100 ms).
    pub transport: Percentiles,
    pub backchannel_cuts: u32,
    pub alerts: Vec<String>,
}

/// The summary of `traces`, the core's own `agent_latency_ms`, and its `agent_replies` (the same
/// latencies keyed by the `say`'s `seq`, which is how a trace finds its own).
pub fn summarize(
    traces: &[TurnTrace],
    agent_latency_ms: &[u32],
    agent_replies: &[AgentReply],
) -> LatencySummary {
    let mut latency_of = BTreeMap::new();
    for r in agent_replies {
        latency_of.entry(r.seq).or_insert(r.latency_ms);
    }
    let s = LatencySummary {
        turns: u32::try_from(traces.len()).unwrap_or(u32::MAX),
        perceived: percentiles(traces.iter().filter_map(TurnTrace::perceived_ms)),
        content: percentiles(traces.iter().filter_map(|t| t.first_audio_ms)),
        endpoint: percentiles(traces.iter().map(|t| t.endpoint_ms)),
        stt_final: percentiles(traces.iter().map(|t| t.stt_final_ms)),
        core_round: percentiles(traces.iter().filter_map(TurnTrace::core_round_ms)),
        agent: percentiles(agent_latency_ms.iter().copied()),
        barge_in_stop: percentiles(traces.iter().filter_map(|t| t.barge_in_stop_ms)),
        transport: percentiles(traces.iter().filter_map(|t| {
            let latency = latency_of.get(&t.reply_seq?)?;
            Some(t.core_round_ms()?.saturating_sub(*latency))
        })),
        backchannel_cuts: u32::try_from(traces.iter().filter(|t| t.backchannel_cut).count())
            .unwrap_or(u32::MAX),
        alerts: Vec::new(),
    };
    let over = |p: Percentiles, limit: u32| p.p95.is_some_and(|v| v > limit);
    let mut alerts = Vec::new();
    if over(s.perceived, PERCEIVED_P95_ALERT_MS) {
        alerts.push("perceived_p95_over_1s".to_owned());
    }
    if over(s.content, CONTENT_P95_ALERT_MS) {
        alerts.push("content_p95_over_3s".to_owned());
    }
    if over(s.barge_in_stop, BARGE_IN_P95_ALERT_MS) {
        alerts.push("barge_in_p95_over_300ms".to_owned());
    }
    LatencySummary { alerts, ..s }
}
```

In `lib.rs` add `mod trace;` beside the other modules and:

```rust
pub use trace::{
    AgentReply, BARGE_IN_P95_ALERT_MS, CONTENT_P95_ALERT_MS, EndpointBy, LatencySummary,
    MAX_TRACES, PERCEIVED_P95_ALERT_MS, Percentiles, TurnTrace, percentiles, summarize,
};
```

- [ ] **Step 4: Run the test**

Run: `cargo test -p jt_calls --test trace`
Expected: `test result: ok. 16 passed`.

- [ ] **Step 5: Commit**

```bash
git add rust/crates/domain/jt_calls
git commit -m "feat(calls): a caller turn's latency trace and its p50/p95 with the report's alerts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A3: The workspace opening and its genitive suffix

**Files:**
- Create: `rust/crates/domain/jt_calls/src/opening.rs`
- Create: `rust/crates/domain/jt_calls/tests/opening.rs`
- Modify: `rust/crates/domain/jt_calls/src/lib.rs`

- [ ] **Step 1: Write the failing test**

`rust/crates/domain/jt_calls/tests/opening.rs`:

```rust
//! The approved opening with the business's name, its suffix fitted (owner decision 2026-10-29).
use jt_calls::{
    CLOSING, TRANSCRIPT_NOTICE, disclosure, genitive, inbound_greeting, outbound_opening,
};

#[test]
fn genitive_follows_vowel_harmony_and_the_buffer_n() {
    for (name, want) in [
        ("Jeeta", "Jeeta'nın"),
        ("Figurunica", "Figurunica'nın"),
        ("Atölye", "Atölye'nin"),
        ("Ahmet", "Ahmet'in"),
        ("Test Atölye", "Test Atölye'nin"),
        ("Acme", "Acme'nin"),
        ("Kuzu", "Kuzu'nun"),
        ("Ütü", "Ütü'nün"),
        ("Gül", "Gül'ün"),
        ("Ayşe", "Ayşe'nin"),
        ("Kitap", "Kitap'ın"),
        ("Sırçalı", "Sırçalı'nın"),
        ("Oto", "Oto'nun"),
        ("Doğruluk", "Doğruluk'un"),
        ("Ahmet Usta", "Ahmet Usta'nın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn capitals_are_lowered_the_turkish_way() {
    assert_eq!(genitive("İSTANBUL"), "İSTANBUL'un");
    assert_eq!(genitive("ISPARTA"), "ISPARTA'nın");
    assert_eq!(genitive("KIRIKKALE"), "KIRIKKALE'nin");
}

#[test]
fn vowelless_words_are_read_by_their_letters() {
    assert_eq!(genitive("THY"), "THY'nin");
    assert_eq!(genitive("KDS"), "KDS'nin");
    assert_eq!(genitive("BMW"), "BMW'nin");
}

#[test]
fn trailing_numbers_are_read_aloud() {
    for (name, want) in [
        ("Studio 54", "Studio 54'ün"),
        ("Kahve 10", "Kahve 10'un"),
        ("Bina 100", "Bina 100'ün"),
        ("Lokanta 2000", "Lokanta 2000'in"),
        ("Oda 6", "Oda 6'nın"),
        ("Ofis 3", "Ofis 3'ün"),
        ("Kat 0", "Kat 0'ın"),
        ("Cafe 7", "Cafe 7'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn blank_names_give_no_opening() {
    assert_eq!(genitive("  "), "");
    assert_eq!(outbound_opening(""), None);
    assert_eq!(disclosure("\t"), None);
}

#[test]
fn the_approved_sentences() {
    assert_eq!(
        outbound_opening("Jeeta").unwrap(),
        "Merhaba, ben Jeeta'nın dijital asistanıyım."
    );
    assert_eq!(
        inbound_greeting("Atölye").unwrap(),
        "Merhaba, ben Atölye'nin dijital asistanıyım. Size nasıl yardımcı olabilirim?"
    );
    let d = disclosure("Figurunica").unwrap();
    assert_eq!(d, "ben Figurunica'nın dijital asistanıyım");
    assert!(outbound_opening("Figurunica").unwrap().contains(&d));
    assert!(inbound_greeting("Figurunica").unwrap().contains(&d));
    assert_eq!(
        TRANSCRIPT_NOTICE,
        "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."
    );
}

// Added beyond the plan's tests: the owner's checklist of names, and the edges of the rules.

#[test]
fn every_vowel_class_with_and_without_the_buffer_n() {
    for (name, want) in [
        ("Zeytin", "Zeytin'in"),
        ("Okul", "Okul'un"),
        ("Göz", "Göz'ün"),
        ("Arı", "Arı'nın"),
        ("Kapı", "Kapı'nın"),
        ("Bahçe", "Bahçe'nin"),
        ("Kulüp", "Kulüp'ün"),
        ("Gözlük", "Gözlük'ün"),
        ("Ev", "Ev'in"),
        ("O", "O'nun"),
        ("Ömer", "Ömer'in"),
        ("Kâr", "Kâr'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn capital_dotted_and_dotless_i_decide_the_suffix_wherever_they_stand() {
    for (name, want) in [
        ("İzmir", "İzmir'in"),
        ("Işık", "Işık'ın"),
        ("Iğdır", "Iğdır'ın"),
        ("ALİ", "ALİ'nin"),
        ("TAKSİ", "TAKSİ'nin"),
        ("ISI", "ISI'nın"),
        ("KIZILIRMAK", "KIZILIRMAK'ın"),
        ("ÇİÇEK", "ÇİÇEK'in"),
        ("DİKİLİ", "DİKİLİ'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn a_number_glued_to_the_name_or_inside_it_is_read_the_same_way() {
    for (name, want) in [
        ("Studio54", "Studio54'ün"),
        ("B2B", "B2B'nin"),
        ("7Eleven", "7Eleven'in"),
        ("3 Kardeşler", "3 Kardeşler'in"),
        ("Hotel 40", "Hotel 40'ın"),
        ("Hotel 20", "Hotel 20'nin"),
        ("Hotel 30", "Hotel 30'un"),
        ("Kat 11", "Kat 11'in"),
        ("Kat 5", "Kat 5'in"),
        ("Plaza 1000000", "Plaza 1000000'un"),
        ("Plaza 1100", "Plaza 1100'ün"),
        ("Plaza 12", "Plaza 12'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn an_absurdly_long_number_does_not_panic() {
    let name = format!("Hat {}", "9".repeat(40));
    assert!(genitive(&name).starts_with("Hat 99"));
}

#[test]
fn a_name_of_nothing_but_punctuation_gives_no_opening() {
    assert_eq!(genitive("..."), "");
    assert_eq!(outbound_opening("- -"), None);
    assert_eq!(inbound_greeting("   "), None);
}

#[test]
fn the_name_is_trimmed_but_otherwise_kept_as_written() {
    assert_eq!(genitive("  Atölye\t"), "Atölye'nin");
    assert_eq!(
        outbound_opening("  Test Atölye ").unwrap(),
        "Merhaba, ben Test Atölye'nin dijital asistanıyım."
    );
}

// Added in the A3 fix-up: words whose suffix is front although their last vowel is back.

#[test]
fn soft_l_loanwords_and_the_front_table_take_the_front_suffix() {
    for (name, want) in [
        ("Kemal", "Kemal'in"),
        ("Saat", "Saat'in"),
        ("Hal", "Hal'in"),
        ("Kalp", "Kalp'in"),
        ("Kontrol", "Kontrol'ün"),
        ("Petrol", "Petrol'ün"),
        ("İstiklâl", "İstiklâl'in"),
        ("Kuzey Petrol", "Kuzey Petrol'ün"),
        // Every word of the table, once.
        ("Alkol", "Alkol'ün"),
        ("Bilal", "Bilal'in"),
        ("Celal", "Celal'in"),
        ("Cemal", "Cemal'in"),
        ("Dikkat", "Dikkat'in"),
        ("Gol", "Gol'ün"),
        ("Hakikat", "Hakikat'in"),
        ("Harf", "Harf'in"),
        ("Hayal", "Hayal'in"),
        ("Hilal", "Hilal'in"),
        ("Kabul", "Kabul'ün"),
        ("Nihal", "Nihal'in"),
        ("Protokol", "Protokol'ün"),
        ("Rol", "Rol'ün"),
        ("Sembol", "Sembol'ün"),
        ("Usul", "Usul'ün"),
        // Any word ending in "âl".
        ("Kemâl", "Kemâl'in"),
        ("Hilâl", "Hilâl'in"),
        ("Celâl", "Celâl'in"),
        ("İSTİKLÂL", "İSTİKLÂL'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn the_front_table_is_matched_on_the_turkish_lowercased_whole_word() {
    for (name, want) in [
        ("KONTROL", "KONTROL'ün"),
        ("HAL", "HAL'in"),
        ("ROL", "ROL'ün"),
        ("DİKKAT", "DİKKAT'in"),
        ("BİLAL", "BİLAL'in"),
        ("HİLAL", "HİLAL'in"),
        ("NİHAL", "NİHAL'in"),
        ("HAKİKAT", "HAKİKAT'in"),
        ("kalp", "kalp'in"),
        ("Petrol.", "Petrol.'ün"),
        // Only a whole word: these merely begin with a table word, or are plain back words.
        ("Sanat", "Sanat'ın"),
        ("Okul", "Okul'un"),
        ("Halk", "Halk'ın"),
        ("Kalpak", "Kalpak'ın"),
        ("Kemalpaşa", "Kemalpaşa'nın"),
        ("Petrolcü", "Petrolcü'nün"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn the_front_table_is_not_applied_to_a_trailing_number() {
    assert_eq!(genitive("Hal 7"), "Hal 7'nin");
    assert_eq!(genitive("Rol 4"), "Rol 4'ün");
}

// Added in the A3 fix-up: a trailing word of symbols, and whitespace inside the name.

#[test]
fn a_trailing_word_of_symbols_is_dropped_and_the_last_real_word_decides() {
    for (name, want) in [
        ("Kafe ☕", "Kafe'nin"),
        ("Acme -", "Acme'nin"),
        ("Acme .", "Acme'nin"),
        ("Acme - ☕ .", "Acme'nin"),
        ("Atölye &", "Atölye'nin"),
        ("Studio 54 ★", "Studio 54'ün"),
        ("☕ Kafe", "☕ Kafe'nin"),
        ("Test & Atölye", "Test & Atölye'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
    assert_eq!(
        outbound_opening("Kafe ☕").unwrap(),
        "Merhaba, ben Kafe'nin dijital asistanıyım."
    );
    assert_eq!(
        disclosure("Acme .").unwrap(),
        "ben Acme'nin dijital asistanıyım"
    );
    assert_eq!(outbound_opening("☕ -"), None);
}

#[test]
fn words_are_joined_by_single_spaces_so_no_newline_reaches_the_sentence() {
    assert_eq!(genitive("Test\nAtölye"), "Test Atölye'nin");
    assert_eq!(genitive("  Test \t\r\n  Atölye \n"), "Test Atölye'nin");
    for text in [
        outbound_opening("Test\nAtölye").unwrap(),
        inbound_greeting("Test\r\nAtölye").unwrap(),
        disclosure("Test\u{a0}\u{a0}Atölye").unwrap(),
    ] {
        assert!(!text.contains(['\n', '\r', '\t']), "{text:?}");
        assert!(!text.contains("  "), "{text:?}");
        assert!(text.contains("Test Atölye'nin"), "{text:?}");
    }
}

// Added in the A3 fix-up: numbers of a trillion and more.

#[test]
fn round_numbers_up_to_a_trillion_and_more_are_read_by_their_unit() {
    for (name, want) in [
        ("Plaza 1000000000", "Plaza 1000000000'ın"),
        ("Plaza 1000000000000", "Plaza 1000000000000'un"),
        ("Plaza 5000000000000", "Plaza 5000000000000'un"),
        ("Plaza 1000000000000000", "Plaza 1000000000000000'un"),
        ("Plaza 100000000000000000", "Plaza 100000000000000000'un"),
        ("Plaza 1500000000000", "Plaza 1500000000000'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

// Added in the A3 fix-up: dotted acronyms are spelled out by their last letter.

#[test]
fn a_dotted_acronym_is_read_by_the_name_of_its_last_letter() {
    for (name, want) in [
        ("A.Ş.", "A.Ş.'nin"),
        ("Acme A.Ş.", "Acme A.Ş.'nin"),
        ("Acme A.Ş", "Acme A.Ş'nin"),
        ("T.C.", "T.C.'nin"),
        ("A.B.D.", "A.B.D.'nin"),
        ("I.B.M.", "I.B.M.'nin"),
        ("S.A.", "S.A.'nın"),
        ("A.O.", "A.O.'nun"),
        ("Ö.Ü.", "Ö.Ü.'nün"),
        ("T.İ.", "T.İ.'nin"),
        ("Y.Ğ.", "Y.Ğ.'nin"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn dots_that_do_not_spell_an_acronym_change_nothing() {
    for (name, want) in [
        ("Ltd.", "Ltd.'nin"),
        ("Ahmet A.", "Ahmet A.'nın"),
        ("St.Anne", "St.Anne'nin"),
        ("Dr.", "Dr.'nin"),
        ("v1.2", "v1.2'nin"),
        ("3.5", "3.5'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn an_acronym_with_vowels_and_no_dots_is_read_as_a_word() {
    // The documented limit: ABD is spoken "A-Be-De" but its spelling has a vowel, so it follows
    // the spelling. An owner whose name is read otherwise writes the opening by hand.
    assert_eq!(genitive("ABD"), "ABD'ın");
    assert_eq!(genitive("AVM"), "AVM'ın");
    assert_eq!(genitive("IBM"), "IBM'ın");
    // Without a vowel the same names are spelled out.
    assert_eq!(genitive("BMW"), "BMW'nin");
}

#[test]
fn the_approved_closing_is_a_pinned_constant() {
    assert_eq!(CLOSING, "Görüşmek üzere, iyi günler.");
    assert_ne!(CLOSING, TRANSCRIPT_NOTICE);
}

// Added in the second A3 fix-up: words checked against TDK's Güncel Türkçe Sözlük (sozluk.gov.tr),
// which shows each entry's suffixed ending: a front vowel after a back-vowel stem (-li, -lü, -ti)
// is the mark of a front suffix.

#[test]
fn words_the_dictionary_marks_with_a_front_suffix_take_it() {
    for (name, want) in [
        ("Metal", "Metal'in"),
        ("Kristal", "Kristal'in"),
        ("Lokal", "Lokal'in"),
        ("Final", "Final'in"),
        ("Sinyal", "Sinyal'in"),
        ("İkbal", "İkbal'in"),
        ("İKBAL", "İKBAL'in"),
        ("Ankara Metal", "Ankara Metal'in"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn words_the_dictionary_marks_with_a_back_suffix_stay_back() {
    // "emlak" is listed with the ending -kı (emlakı): back, though it looks like a soft-k word.
    for (name, want) in [
        ("Emlak", "Emlak'ın"),
        ("Ahlak", "Ahlak'ın"),
        ("Kitap", "Kitap'ın"),
        ("Kalpak", "Kalpak'ın"),
    ] {
        assert_eq!(genitive(name), want, "{name}");
    }
}

#[test]
fn words_outside_the_table_follow_the_spelling_whatever_their_pronunciation() {
    // The documented limits: a compound of a table word, a word the dictionary does not list
    // (İclal), and one it lists without a front mark (global).
    assert_eq!(genitive("Akpetrol"), "Akpetrol'un");
    assert_eq!(genitive("İclal"), "İclal'ın");
    assert_eq!(genitive("Global"), "Global'ın");
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p jt_calls --test opening`
Expected: FAIL to compile (`genitive` not found).

- [ ] **Step 3: Write `opening.rs`**

`rust/crates/domain/jt_calls/src/opening.rs`:

```rust
//! The workspace's own opening of an agent's call (owner decision 2026-10-29): the approved
//! sentences with the business's name in them, its genitive suffix fitted by Turkish vowel harmony.
//! The sentences are the owner's; the server only puts the workspace's own name in them.

/// Played after the opening on every agent call (owner-approved 2026-10-29).
pub const TRANSCRIPT_NOTICE: &str = "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.";

/// Played before an agent's call is hung up when its plan brings none (owner-approved 2026-10-29;
/// the policy's `closing` by default, task C1).
pub const CLOSING: &str = "Görüşmek üzere, iyi günler.";

const VOWELS: &str = "aeıioöuüâîû";

/// Words whose suffix is front although their last vowel is back: "Kemal'in", "Saat'in",
/// "Kontrol'ün". Each is listed in TDK's Güncel Türkçe Sözlük with an ending that has a front vowel
/// after the back-vowel stem (kemal -li, saat -ti, kalp -bi, petrol -lü; checked 2026-10-29), except
/// `bilal` and `nihal`: first names the dictionary does not list, which inflect the same way as
/// `hilal` and `kemal`. Matched whole, on the Turkish-lowercased last word of a name, so a
/// compound ("Akpetrol") follows the spelling. Words ending in "âl" are covered by a rule
/// ([`takes_front_suffix`]), whether or not they are listed. Not listed, on purpose: `global` (the
/// dictionary shows no front mark), `emlak` (its ending is -kı: back) and `iclal` (no entry).
const FRONT_SUFFIX_WORDS: [&str; 28] = [
    "alkol", "bilal", "celal", "cemal", "dikkat", "final", "gol", "hakikat", "hal", "harf",
    "hayal", "hilal", "ikbal", "kabul", "kalp", "kemal", "kontrol", "kristal", "lokal", "metal",
    "nihal", "petrol", "protokol", "rol", "saat", "sembol", "sinyal", "usul",
];

fn is_vowel(c: char) -> bool {
    VOWELS.contains(c)
}

/// `c` lowercased the Turkish way (`I` → `ı`, `İ` → `i`).
fn lower_tr(c: char) -> char {
    match c {
        'I' => 'ı',
        'İ' => 'i',
        _ => c.to_lowercase().next().unwrap_or(c),
    }
}

/// How a letter is read when a word is spelled out (a vowel letter is read as itself).
fn letter_name(c: char) -> &'static str {
    match c {
        'a' => "a",
        'b' => "be",
        'c' => "ce",
        'ç' => "çe",
        'd' => "de",
        'e' => "e",
        'f' => "fe",
        'g' => "ge",
        'ğ' => "yumuşak ge",
        'h' => "he",
        'ı' => "ı",
        'i' => "i",
        'j' => "je",
        'k' => "ke",
        'l' => "le",
        'm' => "me",
        'n' => "ne",
        'o' => "o",
        'ö' => "ö",
        'p' => "pe",
        'q' => "kü",
        'r' => "re",
        's' => "se",
        'ş' => "şe",
        't' => "te",
        'u' => "u",
        'ü' => "ü",
        'v' | 'w' => "ve",
        'x' => "iks",
        'y' => "ye",
        'z' => "ze",
        _ => "",
    }
}

/// The last word of a number's Turkish reading (`54` → `dört`, `100` → `yüz`, `10^12` → `trilyon`).
/// Only the last 18 digits are read: a longer number is not supported.
fn number_tail(digits: &str) -> &'static str {
    const ONES: [&str; 10] = [
        "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz",
    ];
    const TENS: [&str; 10] = [
        "", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan",
    ];
    let tail = &digits[digits.len().saturating_sub(18)..];
    let n: u64 = tail.parse().unwrap_or(0);
    if n == 0 {
        "sıfır"
    } else if !n.is_multiple_of(10) {
        ONES[(n % 10) as usize]
    } else if !n.is_multiple_of(100) {
        TENS[((n / 10) % 10) as usize]
    } else if !n.is_multiple_of(1_000) {
        "yüz"
    } else if !n.is_multiple_of(1_000_000) {
        "bin"
    } else if !n.is_multiple_of(1_000_000_000) {
        "milyon"
    } else if !n.is_multiple_of(1_000_000_000_000) {
        "milyar"
    } else {
        "trilyon"
    }
}

/// Whether the last word `lower` (Turkish-lowercased, letters and digits only) takes the front
/// suffix although its last vowel is back: a word of [`FRONT_SUFFIX_WORDS`], or any word ending in
/// "âl" (İstiklâl'in, Hilâl'in).
fn takes_front_suffix(lower: &str) -> bool {
    FRONT_SUFFIX_WORDS.contains(&lower) || lower.ends_with("âl")
}

/// The last letter of a dotted acronym (`A.Ş.`, `T.C.`, `A.B.D.`; the last dot is optional): two or
/// more single letters, each followed by a dot. Anything else is not one.
fn dotted_acronym_last_letter(word: &str) -> Option<char> {
    let parts: Vec<&str> = word.trim_end_matches('.').split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let mut last = None;
    for part in parts {
        let mut chars = part.chars();
        let (Some(c), None) = (chars.next(), chars.next()) else {
            return None;
        };
        if !c.is_alphabetic() {
            return None;
        }
        last = Some(c);
    }
    last
}

/// How the end of `word` (a name's last word, which has a letter or a digit) is read aloud, and
/// whether its suffix is front although its last vowel is back: a dotted acronym by its last
/// letter's name, a trailing number by its reading, a word without vowels by its last letter's
/// name, any other word as written.
fn spoken_tail(word: &str) -> (String, bool) {
    if let Some(letter) = dotted_acronym_last_letter(word) {
        return (letter_name(lower_tr(letter)).to_owned(), false);
    }
    let core: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
    let digits: Vec<char> = core
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    if !digits.is_empty() {
        let digits: String = digits.into_iter().rev().collect();
        return (number_tail(&digits).to_owned(), false);
    }
    let lower: String = core.chars().map(lower_tr).collect();
    if lower.chars().any(is_vowel) {
        let front = takes_front_suffix(&lower);
        return (lower, front);
    }
    let spelled = lower
        .chars()
        .last()
        .map(letter_name)
        .unwrap_or_default()
        .to_owned();
    (spelled, false)
}

/// The genitive suffix of a word read as `spoken`: the last vowel picks it (a ı → ın, e i → in,
/// o u → un, ö ü → ün; `front` turns a ı → in and o u → ün), and a final vowel takes the buffer `n`.
fn genitive_suffix(spoken: &str, front: bool) -> &'static str {
    let ends_in_vowel = spoken.chars().last().is_some_and(is_vowel);
    let (bare, buffered) = match (spoken.chars().rev().find(|c| is_vowel(*c)), front) {
        (Some('a' | 'ı' | 'â'), false) => ("ın", "nın"),
        (Some('o' | 'u' | 'û'), false) => ("un", "nun"),
        (Some('ö' | 'ü'), _) | (Some('o' | 'u' | 'û'), true) => ("ün", "nün"),
        _ => ("in", "nin"),
    };
    if ends_in_vowel { buffered } else { bare }
}

/// `name` with its genitive suffix after an apostrophe: `Jeeta'nın`, `Atölye'nin`, `Ahmet'in`,
/// `THY'nin`, `A.Ş.'nin`, `Studio 54'ün`, `Kontrol'ün`. Blank → blank.
///
/// The name is its words joined by single spaces (so a newline inside it never reaches the spoken
/// sentence), up to its last word that holds a letter or a digit: a trailing word of symbols only
/// ("☕", "-", ".") is dropped. The suffix follows that last word as it is *spelled*:
///
/// - The last vowel decides (a ı → ın, e i → in, o u → un, ö ü → ün), a final vowel takes the buffer
///   `n`; capital `I` and `İ` are lowered the Turkish way.
/// - A short table of words that TDK's dictionary marks with a front suffix after a back vowel
///   (Kemal, Saat, Hal, Kalp, Kontrol, Petrol, Metal, Final, ...), matched whole, and any word
///   ending in "âl" take the front suffix: `Kemal'in`, `Kontrol'ün`, `İstiklâl'in`.
/// - A word without vowels is read by its last letter's name (`THY'nin`), a dotted acronym by the
///   name of its last letter (`A.Ş.'nin`, `T.C.'nin`), a trailing number by its Turkish reading
///   (`Studio 54'ün`, `Bina 100'ün`). A number of more than 18 digits is not supported (only its
///   last 18 digits are read).
///
/// Limits. An acronym that holds a vowel but has no dots (ABD, AKP, AVM, IBM) is read as a word, so
/// it gets `ABD'ın` where it is spoken "A-Be-De'nin"; a foreign or invented name pronounced
/// otherwise than spelled ("Apple") has the same problem. So has a word the table lacks: a compound
/// of a table word (Akpetrol), `İclal` (not in the dictionary) and `global` (listed without a front
/// mark) get `'ın`. An owner whose name is read otherwise writes the opening by hand in the call
/// policy.
pub fn genitive(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let Some(end) = words
        .iter()
        .rposition(|w| w.chars().any(char::is_alphanumeric))
    else {
        return String::new();
    };
    let shown = words[..=end].join(" ");
    let (spoken, front) = spoken_tail(words[end]);
    format!("{shown}'{}", genitive_suffix(&spoken, front))
}

/// The approved outbound opening: "Merhaba, ben {İşletme}'nın dijital asistanıyım."; `None` for a
/// blank name.
pub fn outbound_opening(business: &str) -> Option<String> {
    let g = genitive(business);
    (!g.is_empty()).then(|| format!("Merhaba, ben {g} dijital asistanıyım."))
}

/// The approved inbound greeting: the opening, then "Size nasıl yardımcı olabilirim?".
pub fn inbound_greeting(business: &str) -> Option<String> {
    outbound_opening(business).map(|o| format!("{o} Size nasıl yardımcı olabilirim?"))
}

/// The disclosure sentence both openings contain: "ben {İşletme}'nın dijital asistanıyım".
pub fn disclosure(business: &str) -> Option<String> {
    let g = genitive(business);
    (!g.is_empty()).then(|| format!("ben {g} dijital asistanıyım"))
}
```

In `lib.rs` add `mod opening;` and `pub use opening::{CLOSING, TRANSCRIPT_NOTICE, disclosure, genitive, inbound_greeting, outbound_opening};`.

- [ ] **Step 4: Run the test**

Run: `cargo test -p jt_calls --test opening`
Expected: `test result: ok. 25 passed`.

- [ ] **Step 5: Commit**

```bash
git add rust/crates/domain/jt_calls
git commit -m "feat(calls): the approved workspace opening with its genitive suffix fitted" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A4: The owner-approved phrase set

**Files:**
- Create: `rust/crates/domain/jt_calls/src/phrases.rs`
- Create: `rust/crates/domain/jt_calls/tests/phrases.rs`
- Modify: `rust/crates/domain/jt_calls/src/lib.rs`

- [ ] **Step 1: Write the failing test**

`rust/crates/domain/jt_calls/tests/phrases.rs`:

```rust
//! The phrases the bridge may play on its own: exactly the set the owner approved on 2026-10-29.
use jt_calls::{BridgePhrases, PhraseSet};
use serde_json::json;

#[test]
fn the_defaults_are_the_approved_set() {
    let p = BridgePhrases::default();
    assert_eq!(
        p.acknowledgements,
        ["Hı hı.", "Anladım.", "Tamam.", "Peki."]
    );
    assert_eq!(
        p.fillers,
        [
            "Bir saniye, hemen bakıyorum.",
            "Kontrol ediyorum, kısa bir an."
        ]
    );
    assert_eq!(
        p.long_wait,
        ["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]
    );
    assert_eq!(p.not_heard, ["Sizi tam duyamadım, tekrar eder misiniz?"]);
    assert_eq!(p.still_there, ["Hâlâ orada mısınız?"]);
    assert_eq!(
        p.fault,
        ["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."]
    );
    assert_eq!(p.all().count(), 10);
}

#[test]
fn a_phrase_is_found_by_its_set_and_index() {
    let p = BridgePhrases::default();
    assert_eq!(
        p.text(PhraseSet::Filler, 1),
        Some("Kontrol ediyorum, kısa bir an.")
    );
    assert_eq!(p.text(PhraseSet::LongWait, 1), None);
    assert_eq!(p.set(PhraseSet::Acknowledgement).len(), 4);
}

#[test]
fn sets_read_and_write_snake_case_and_missing_sets_keep_their_defaults() {
    assert_eq!(
        serde_json::to_value(PhraseSet::LongWait).unwrap(),
        json!("long_wait")
    );
    assert_eq!(
        serde_json::to_value(PhraseSet::StillThere).unwrap(),
        json!("still_there")
    );
    let p: BridgePhrases = serde_json::from_value(json!({ "fillers": ["Bir dakika."] })).unwrap();
    assert_eq!(p.fillers, ["Bir dakika."]);
    assert_eq!(
        p.acknowledgements,
        BridgePhrases::default().acknowledgements
    );
}

// Added beyond the plan's tests: the owner's approved texts, pinned character for character.

/// Every text the owner approved on 2026-10-29 that the domain holds, set by set, in the order
/// `BridgePhrases::all` yields them.
const APPROVED: [(PhraseSet, &[&str]); 6] = [
    (
        PhraseSet::Acknowledgement,
        &["Hı hı.", "Anladım.", "Tamam.", "Peki."],
    ),
    (
        PhraseSet::Filler,
        &[
            "Bir saniye, hemen bakıyorum.",
            "Kontrol ediyorum, kısa bir an.",
        ],
    ),
    (
        PhraseSet::LongWait,
        &["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."],
    ),
    (
        PhraseSet::NotHeard,
        &["Sizi tam duyamadım, tekrar eder misiniz?"],
    ),
    (PhraseSet::StillThere, &["Hâlâ orada mısınız?"]),
    (
        PhraseSet::Fault,
        &["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."],
    ),
];

#[test]
fn the_approved_texts_are_pinned_set_by_set() {
    let p = BridgePhrases::default();
    for (set, texts) in APPROVED {
        let have: Vec<&str> = p.set(set).iter().map(String::as_str).collect();
        assert_eq!(have, texts, "{set:?}");
    }
    let flat: Vec<&str> = APPROVED
        .iter()
        .flat_map(|(_, t)| t.iter().copied())
        .collect();
    assert_eq!(p.all().collect::<Vec<_>>(), flat);
    assert_eq!(
        jt_calls::TRANSCRIPT_NOTICE,
        "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."
    );
    // Not a bridge phrase (the core plays it at the scripted ending), but approved with them.
    assert_eq!(jt_calls::CLOSING, "Görüşmek üzere, iyi günler.");
}

#[test]
fn the_approved_texts_use_the_precomposed_turkish_letters() {
    // "Hı hı." has the dotless ı (U+0131) and "Hâlâ" the precomposed â (U+00E2), never an i or an
    // a followed by a combining mark: the speech engine and the phrase cache key on the bytes.
    let p = BridgePhrases::default();
    assert!(p.acknowledgements[0].contains('\u{131}'));
    assert!(!p.acknowledgements[0].contains('i'));
    assert!(p.still_there[0].contains('\u{e2}'));
    for text in p
        .all()
        .chain([jt_calls::TRANSCRIPT_NOTICE, jt_calls::CLOSING])
    {
        assert!(
            !text.chars().any(|c| ('\u{300}'..='\u{36f}').contains(&c)),
            "{text}"
        );
        assert_eq!(text, text.trim(), "{text}");
        assert!(text.ends_with(['.', '?']), "{text}");
    }
}

#[test]
fn sets_have_stable_positions_and_a_cleared_set_is_never_played() {
    for (i, set) in PhraseSet::ALL.into_iter().enumerate() {
        assert_eq!(set.position(), i, "{set:?}");
    }
    let p: BridgePhrases = serde_json::from_value(json!({ "fillers": [] })).unwrap();
    assert!(p.set(PhraseSet::Filler).is_empty());
    assert_eq!(p.text(PhraseSet::Filler, 0), None);
    assert_eq!(p.all().count(), 8);
    assert_eq!(
        BridgePhrases::default().text(PhraseSet::Fault, u8::MAX),
        None
    );
}

#[test]
fn the_defaults_survive_a_trip_through_json() {
    let p = BridgePhrases::default();
    let back: BridgePhrases = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    assert_eq!(back, p);
    let empty: BridgePhrases = serde_json::from_value(json!({})).unwrap();
    assert_eq!(empty, p);
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p jt_calls --test phrases`
Expected: FAIL to compile (`BridgePhrases` not found).

- [ ] **Step 3: Write `phrases.rs`**

`rust/crates/domain/jt_calls/src/phrases.rs`:

```rust
//! The phrases the voice bridge may play on its own while the agent thinks or the line needs a word
//! (owner decisions V-4 and the approved set of 2026-10-29): acknowledgements, fillers, the long
//! wait, "not heard", "still there" and the fault sentence. They are the policy's text: the bridge
//! picks one by set and index and reports which, and the core logs the policy's text for it. A set
//! left empty is never played.
//!
//! The closing is not a bridge phrase: the core plays it at the scripted ending (`CallPlan.closing`,
//! by default the policy's `closing`).

use serde::{Deserialize, Serialize};

/// Which kind of phrase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhraseSet {
    /// Right after the caller's turn, when no reply is queued yet (about 0.6 s).
    Acknowledgement,
    /// The reply is late (about 2.7 s).
    Filler,
    /// The reply is very late (about 8 s).
    LongWait,
    /// The caller spoke but no words were recognised.
    NotHeard,
    /// The caller stayed silent after the agent spoke.
    StillThere,
    /// The bridge lost the core during a call; played before it hangs up.
    Fault,
}

impl PhraseSet {
    pub const ALL: [PhraseSet; 6] = [
        PhraseSet::Acknowledgement,
        PhraseSet::Filler,
        PhraseSet::LongWait,
        PhraseSet::NotHeard,
        PhraseSet::StillThere,
        PhraseSet::Fault,
    ];

    /// The set's position in [`PhraseSet::ALL`].
    pub fn position(self) -> usize {
        PhraseSet::ALL
            .iter()
            .position(|s| *s == self)
            .unwrap_or_default()
    }
}

/// The policy's phrases, one list per set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgePhrases {
    pub acknowledgements: Vec<String>,
    pub fillers: Vec<String>,
    pub long_wait: Vec<String>,
    pub not_heard: Vec<String>,
    pub still_there: Vec<String>,
    pub fault: Vec<String>,
}

fn lines(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|t| (*t).to_owned()).collect()
}

impl Default for BridgePhrases {
    /// The set the owner approved on 2026-10-29.
    fn default() -> Self {
        BridgePhrases {
            acknowledgements: lines(&["Hı hı.", "Anladım.", "Tamam.", "Peki."]),
            fillers: lines(&[
                "Bir saniye, hemen bakıyorum.",
                "Kontrol ediyorum, kısa bir an.",
            ]),
            long_wait: lines(&["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]),
            not_heard: lines(&["Sizi tam duyamadım, tekrar eder misiniz?"]),
            still_there: lines(&["Hâlâ orada mısınız?"]),
            fault: lines(&[
                "Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.",
            ]),
        }
    }
}

impl BridgePhrases {
    /// The phrases of `set`.
    pub fn set(&self, set: PhraseSet) -> &[String] {
        match set {
            PhraseSet::Acknowledgement => &self.acknowledgements,
            PhraseSet::Filler => &self.fillers,
            PhraseSet::LongWait => &self.long_wait,
            PhraseSet::NotHeard => &self.not_heard,
            PhraseSet::StillThere => &self.still_there,
            PhraseSet::Fault => &self.fault,
        }
    }

    /// Phrase `index` of `set`, if there is one.
    pub fn text(&self, set: PhraseSet, index: u8) -> Option<&str> {
        self.set(set).get(usize::from(index)).map(String::as_str)
    }

    /// Every phrase, set by set.
    pub fn all(&self) -> impl Iterator<Item = &str> {
        PhraseSet::ALL
            .into_iter()
            .flat_map(move |s| self.set(s).iter().map(String::as_str))
    }
}
```

In `lib.rs` add `mod phrases;` and `pub use phrases::{BridgePhrases, PhraseSet};`.

- [ ] **Step 4: Run the whole crate**

Run: `cargo test -p jt_calls`
Expected: every test passes (the existing `fence`, `session`, `timers` and the four new files).

- [ ] **Step 5: Commit**

```bash
git add rust/crates/domain/jt_calls
git commit -m "feat(calls): the owner-approved phrase set the bridge may play on its own" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A5: The wire's additions in the domain (dial script, hotwords, phrase and trace events)

**Files:**
- Modify: `rust/crates/domain/jt_calls/src/session.rs` (`CallSession.phrases`, `CallMetrics`, `Command::Dial`, `BridgeEvent`, `reduce`; new `DialScript`)
- Modify: `rust/crates/domain/jt_calls/src/plan.rs` (`hotwords`, `PlanError::Hotwords`, `call_hotwords`)
- Modify: `rust/crates/domain/jt_calls/src/policy.rs` (`phrases` field only; its validation is C1)
- Modify: `rust/crates/domain/jt_calls/src/lib.rs`
- Create: `rust/crates/domain/jt_calls/tests/bridge_additions.rs`
- Modify (struct literals that must name the new fields): `rust/crates/domain/jt_calls/tests/support/mod.rs:21`, `rust/crates/domain/jt_calls/tests/wire.rs`, `rust/crates/jt_app/tests/calls_bridge.rs:84,138`, `rust/crates/jt_app/tests/calls_session.rs:76`, `rust/crates/adapters/jt_pg/tests/calls_storage.rs:401,560`; and, for `CallSession.phrases`, every `CallSession { … }` literal (find them with `grep -rn "CallSession {" rust/crates --include=*.rs`; a literal that ends in `..other` needs nothing): `rust/crates/domain/jt_calls/tests/support/mod.rs:49`, `rust/crates/jt_app/src/usecases/calls.rs` (`place_human`, `place_agent`), `rust/crates/jt_app/tests/calls_bridge.rs:99`, `rust/crates/jt_app/tests/inbox_consumer.rs:1494`, `rust/crates/adapters/jt_pg/tests/calls_storage.rs` (six)
- Modify: `rust/crates/jt_app/src/usecases/calls.rs:942` (the `Command::Dial` it builds), `rust/crates/jt_app/src/usecases/calls/bridge.rs` (`kind_of`)

- [ ] **Step 1: Write the failing tests**

`rust/crates/domain/jt_calls/tests/bridge_additions.rs`:

```rust
//! What the free-path bridge adds to the protocol (design addendum §4): the dial's script, the
//! plan's hotwords, the bridge's own phrases in the turn log, and the turns' traces.
mod support;

use jt_calls::{
    AgentReply, BridgeEvent, BridgePhrases, Command, DialScript, MAX_TRACES, PhraseSet, PlanError,
    TimerAction, TurnKind, TurnTrace, call_hotwords, next_timer, reduce, say,
};
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};

fn at(ms: i64) -> OffsetDateTime {
    T0 + Duration::milliseconds(ms)
}

fn utterance() -> BridgeEvent {
    BridgeEvent::Utterance { text: "evet".into(), is_final: true, confidence: None, stt_ms: Some(40) }
}

#[test]
fn a_bridge_filler_is_logged_with_the_dialled_text_and_counts_as_this_waits_holding() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::Filler, index: 0 }, at(7_700), &p);
    assert_eq!(step.turns.len(), 1);
    assert_eq!(step.turns[0].kind, TurnKind::Holding);
    assert_eq!(step.turns[0].text, s.phrases.fillers[0]);
    assert!(step.commands.is_empty());
    // The core's own first holding phrase (4 s after the words) is covered already.
    assert_eq!(next_timer(&s, at(9_000), &p), TimerAction::None);
    reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::LongWait, index: 0 }, at(13_000), &p);
    assert_eq!(next_timer(&s, at(15_000), &p), TimerAction::None);
    // The plan's fallback line still comes at 20 s.
    assert_eq!(next_timer(&s, at(25_000), &p), TimerAction::PlayFallback);
}

#[test]
fn a_phrase_the_dial_lacks_logs_no_text() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(1_000), &p);
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::Filler, index: 9 }, at(3_700), &p);
    assert!(step.turns.is_empty());
    assert_eq!(s.clock.holding_in_turn, 1);
}

#[test]
fn a_phrase_is_logged_with_the_text_dialled_for_this_call_not_the_policys_current_one() {
    // The call was dialled with the approved phrases; the owner then rewrites the fillers.
    let mut p = policy();
    p.phrases.fillers = vec!["Hemen dönüyorum.".into()];
    let mut s = agent_session();
    assert_eq!(s.phrases, BridgePhrases::default());
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::Filler, index: 0 }, at(7_700), &p);
    assert_eq!(step.turns[0].text, "Bir saniye, hemen bakıyorum.");
    // Index 1 is in the dialled set but no longer in the policy's: still the dialled text.
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::Filler, index: 1 }, at(8_000), &p);
    assert_eq!(step.turns[0].text, "Kontrol ediyorum, kısa bir an.");
    // A phrase the dial carried none of logs nothing, whatever the policy has now.
    s.phrases.long_wait.clear();
    p.phrases.long_wait = vec!["Çok sürdü.".into()];
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::LongWait, index: 0 }, at(9_000), &p);
    assert!(step.turns.is_empty());
}

#[test]
fn a_session_stored_without_dialled_phrases_reads_the_approved_set() {
    let mut value = serde_json::to_value(agent_session()).unwrap();
    value.as_object_mut().unwrap().remove("phrases");
    let back: jt_calls::CallSession = serde_json::from_value(value).unwrap();
    assert_eq!(back.phrases, BridgePhrases::default());
}

#[test]
fn an_acknowledgement_is_logged_but_covers_nothing() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(1_000), &p);
    let step = reduce(&mut s, &BridgeEvent::Phrase { set: PhraseSet::Acknowledgement, index: 1 }, at(1_600), &p);
    assert_eq!(step.turns[0].text, "Anladım.");
    assert_eq!(s.clock.holding_in_turn, 0);
}

#[test]
fn traces_are_kept_up_to_the_limit() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    for i in 0..(MAX_TRACES + 5) {
        let trace = TurnTrace { endpoint_ms: i as u32, ..TurnTrace::default() };
        reduce(&mut s, &BridgeEvent::Trace { trace }, at(1_000), &p);
    }
    assert_eq!(s.metrics.traces.len(), MAX_TRACES);
    assert_eq!(s.metrics.traces[0].endpoint_ms, 0);
}

#[test]
fn an_agents_say_records_its_seq_with_its_latency_up_to_the_limit() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = say(&mut s, "Perşembe uygun.", true, true, at(8_000)).unwrap();
    let Command::Say { seq, .. } = step.commands[0] else { panic!("a say") };
    assert_eq!(s.metrics.agent_replies, [AgentReply { seq, latency_ms: 3_000 }]);
    assert_eq!(s.metrics.agent_latency_ms, [3_000]);
    // A sentence said when nothing was owed ends no wait: no latency, so no reply either.
    say(&mut s, "Devam ediyorum.", true, true, at(9_000)).unwrap();
    assert_eq!(s.metrics.agent_replies.len(), 1);
    // The list is capped like the traces, keeping the first ones.
    for i in 0..(MAX_TRACES + 5) as i64 {
        reduce(&mut s, &utterance(), at(10_000 + i * 10), &p);
        say(&mut s, "Tamam.", true, true, at(10_005 + i * 10)).unwrap();
    }
    assert_eq!(s.metrics.agent_replies.len(), MAX_TRACES);
    assert_eq!(s.metrics.agent_replies[0].seq, seq);
}

#[test]
fn a_dial_without_a_script_reads_the_approved_phrases() {
    let dial: Command = serde_json::from_value(json!({
        "kind": "dial",
        "to_e164": "+905321234567",
        "plan": serde_json::to_value(plan()).unwrap(),
    }))
    .unwrap();
    let Command::Dial { script, .. } = dial else { panic!("a dial") };
    assert_eq!(script, DialScript::default());
    assert_eq!(script.phrases, BridgePhrases::default());
}

#[test]
fn the_new_events_read_from_the_wire() {
    let phrase: BridgeEvent = serde_json::from_value(json!({ "kind": "phrase", "set": "filler", "index": 1 })).unwrap();
    assert_eq!(phrase, BridgeEvent::Phrase { set: PhraseSet::Filler, index: 1 });
    let trace: BridgeEvent =
        serde_json::from_value(json!({ "kind": "trace", "trace": { "endpoint_ms": 250, "stt_final_ms": 300 } })).unwrap();
    assert!(matches!(trace, BridgeEvent::Trace { trace } if trace.endpoint_ms == 250));
}

#[test]
fn plan_hotwords_are_bounded_and_the_workspace_name_joins_them() {
    let mut p = plan();
    p.hotwords = (0..20).map(|i| format!("ürün{i}")).collect();
    assert_eq!(p.validate(), Ok(()));
    p.hotwords.push("bir fazla".into());
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["   ".into()];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["x".repeat(41)];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    assert_eq!(
        call_hotwords(&["Ada".into(), "ada".into(), " Figurunica ".into()], "Figurunica"),
        ["Ada", "Figurunica"]
    );
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p jt_calls --test bridge_additions`
Expected: FAIL to compile (`DialScript`, `call_hotwords`, `BridgeEvent::Phrase` not found).

- [ ] **Step 3: Implement the domain changes**

`plan.rs`: add the constants, the field, the error and the helper:

```rust
/// The most hotwords a plan carries, and the longest.
pub const MAX_HOTWORDS: usize = 20;
pub const MAX_HOTWORD_CHARS: usize = 40;
```

In `CallPlan`, after `disclose_assistant`:

```rust
    /// Words the call's speech-to-text is biased toward (names, products, from the agent's
    /// context): at most 20, each 1 to 40 characters.
    #[serde(default)]
    pub hotwords: Vec<String>,
```

In `PlanError`:

```rust
    #[error("a plan has at most 20 hotwords of 1 to 40 characters")]
    Hotwords,
```

and in `PlanError::field`: `PlanError::Hotwords => "plan.hotwords",`. At the end of `CallPlan::validate`, before `Ok(())`:

```rust
        let bad_hotword = |h: &String| {
            let n = h.trim().chars().count();
            n == 0 || n > MAX_HOTWORD_CHARS || h.chars().any(char::is_control)
        };
        if self.hotwords.len() > MAX_HOTWORDS || self.hotwords.iter().any(bad_hotword) {
            return Err(PlanError::Hotwords);
        }
```

and the helper after the `impl CallPlan` block:

```rust
/// The hotwords of a call: the plan's, then the workspace's name, trimmed, each once whatever its
/// case, at most [`MAX_HOTWORDS`].
pub fn call_hotwords(plan: &[String], business: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    plan.iter()
        .map(String::as_str)
        .chain(std::iter::once(business))
        .map(str::trim)
        .filter(|w| !w.is_empty() && seen.insert(w.to_lowercase()))
        .take(MAX_HOTWORDS)
        .map(str::to_owned)
        .collect()
}
```

`policy.rs`: add `use crate::phrases::BridgePhrases;`, the field after `estimated_minor_per_minute`:

```rust
    /// The phrases the voice bridge plays on its own (the owner-approved set by default).
    pub phrases: BridgePhrases,
```

and `phrases: BridgePhrases::default(),` in `Default for CallPolicy`.

`session.rs`: add the imports

```rust
use crate::phrases::{BridgePhrases, PhraseSet};
use crate::trace::{AgentReply, MAX_TRACES, TurnTrace};
```

add to `CallSession`, after `clock`:

```rust
    /// The phrases dialled with this call (the dial's `DialScript.phrases`): what a `phrase` event
    /// is logged with, whatever the policy says by the time the event arrives, so an owner who edits
    /// the phrases during a live call cannot make the log record a sentence that was never played.
    /// The approved set in a session stored without one.
    #[serde(default)]
    pub phrases: BridgePhrases,
```

add to `CallMetrics`, after `fallback_played`:

```rust
    /// The bridge's timings of the call's turns (at most [`MAX_TRACES`]).
    pub traces: Vec<TurnTrace>,
    /// Each agent `say` that ended a wait, by its `seq`, with that wait (at most [`MAX_TRACES`]):
    /// what `summarize` matches a trace's `reply_seq` against to measure the transport overhead.
    pub agent_replies: Vec<AgentReply>,
```

and, in `say` (same file), right after `let turn = session.turn(…);`, record the pair beside the existing `agent_latency_ms` push:

```rust
    if let Some(latency_ms) = latency
        && session.metrics.agent_replies.len() < MAX_TRACES
    {
        session.metrics.agent_replies.push(AgentReply { seq: turn.seq, latency_ms });
    }
```

add before `pub enum Command`:

```rust
/// What the voice bridge is told of a dialled call besides its plan: the policy's sentences the
/// core may queue on it (the workspace opening, the transcript notice), the phrases it may play on
/// its own, and the words its speech-to-text is biased toward. Absent from an older dial: the
/// approved phrases, nothing else.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DialScript {
    pub lines: Vec<String>,
    pub phrases: BridgePhrases,
    pub hotwords: Vec<String>,
}
```

change `Command::Dial` to:

```rust
    Dial {
        to_e164: String,
        plan: CallPlan,
        #[serde(default)]
        script: DialScript,
    },
```

and put `#[expect(clippy::large_enum_variant, reason = "commands are few and short-lived")]` above `pub enum Command`. With the script the dial is at least 392 bytes against 30 for the next variant, and `clippy -D warnings` refuses the enum. A command is built, queued and sent, never held in bulk, so its size costs nothing, while boxing the script would change every consumer. `expect` (not `allow`) so that the build says when the attribute stops being needed.

add to `BridgeEvent`, before `CommandDone`:

```rust
    /// The bridge played phrase `index` of `set` of the policy on its own.
    Phrase { set: PhraseSet, index: u8 },
    /// What one of the caller's turns took, as the bridge measured it.
    Trace { trace: TurnTrace },
```

and in `reduce`, before `BridgeEvent::CommandDone { .. } => {}`:

```rust
        BridgeEvent::Phrase { set, index } => {
            // The text dialled with this call is logged, not the policy as it stands now (the owner
            // may have edited it since); the bridge sends none.
            if let Some(text) = session.phrases.text(*set, *index).map(str::to_owned) {
                step.turns
                    .push(session.turn(now, TurnKind::Holding, text, TurnMeta::default()));
            }
            // A filler or the long wait is this wait's holding phrase: the core does not play its
            // own over it.
            let covers = match set {
                PhraseSet::Filler => 1,
                PhraseSet::LongWait => 2,
                _ => 0,
            };
            if covers > 0 && session.clock.owed_since.is_some() {
                session.clock.holding_in_turn = session.clock.holding_in_turn.max(covers);
                session.metrics.holding_played = session.metrics.holding_played.saturating_add(1);
            }
        }
        BridgeEvent::Trace { trace } => {
            if session.metrics.traces.len() < MAX_TRACES {
                session.metrics.traces.push(trace.clone());
            }
        }
```

`lib.rs`: export `DialScript` from `session` and `MAX_HOTWORDS, MAX_HOTWORD_CHARS, call_hotwords` from `plan`.

- [ ] **Step 4: Name the new fields at every struct literal**

Add `hotwords: Vec::new(),` to the `CallPlan { … }` literals in `rust/crates/domain/jt_calls/tests/support/mod.rs`, `rust/crates/jt_app/tests/calls_bridge.rs`, `rust/crates/jt_app/tests/calls_session.rs`, `rust/crates/adapters/jt_pg/tests/calls_storage.rs`; add `script: Default::default(),` to the `Command::Dial { … }` literals in `rust/crates/domain/jt_calls/tests/wire.rs`, `rust/crates/jt_app/tests/calls_bridge.rs`, `rust/crates/adapters/jt_pg/tests/calls_storage.rs`; in `rust/crates/jt_app/src/usecases/calls.rs` change the dial to

```rust
    let script = DialScript::default();
    // The phrases the bridge is told are the phrases the log will show: keep them with the call.
    session.phrases = script.phrases.clone();
    r.calls().update(session.clone(), ctx.now).await?;
    let dial = Command::Dial {
        to_e164: session.counterpart_e164.clone(),
        plan,
        script,
    };
```

(Task C2 fills the script from the policy and snapshots its phrases the same way) and import `DialScript` in its `use jt_calls::{…}`. Add `phrases: Default::default(),` to every `CallSession { … }` literal listed above. In `rust/crates/jt_app/src/usecases/calls/bridge.rs` `kind_of`, add:

```rust
        BridgeEvent::Phrase { .. } => "phrase",
        BridgeEvent::Trace { .. } => "trace",
```

Find any other literal with: `grep -rn "Command::Dial {\|CallPlan {" rust/crates --include=*.rs` (Expected: only the sites above and the definitions).

- [ ] **Step 5: Run the tests**

Run: `cargo test -p jt_calls` and `cargo clippy --locked -p jt_app --lib --features tokio/time -- -D warnings`
Expected: `bridge_additions` 10 passed and every earlier `jt_calls` test passing; `jt_app` lib clean. CI: `jt_app`, `jt_pg` tests unchanged in behaviour.

- [ ] **Step 6: Commit**

```bash
git add rust/crates
git commit -m "feat(calls): the dial's script, plan hotwords, and the bridge's phrase and trace events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [x] **Step 7: Review revisions (PR #382, commit `87299316`)**. Where they differ from the code above, these win:
  - `reduce` keeps a `BridgeEvent::Trace` **before** the ended-session guard. The bridge reports the last turn's trace after the hangup, and the core may have ended the call first (`close`, or `end` and then the line's hangup). On an ended session a trace changes nothing else. Tests: `a_trace_reported_after_the_callers_hangup_is_kept`, `a_trace_reported_after_the_core_ended_the_call_is_kept`.
  - `CallPlan.hotwords` is `#[serde(default, deserialize_with = "trimmed", skip_serializing_if = "Vec::is_empty")]`:
    - It is written only when non-empty, so a plan without hotwords still reads in 047da0cd, which reads plans with `deny_unknown_fields`. C1 removes that strictness from the stored type.
    - It is read trimmed, so what is stored is what was length-checked.
  - A plan carries at most `MAX_PLAN_HOTWORDS` = 19, and `PlanError::Hotwords` says 19. `call_hotwords` takes at most 19 of the plan's words, then the workspace's name, which always keeps its slot (at most `MAX_HOTWORDS` = 20 in total).
  - Words are deduplicated after Turkish lowercasing with `opening::lower_tr` (now `pub(crate)`), so `IŞIK` and `ışık` are one word.


---

## Phase B — the vertical slice (riskiest first)

Phase B proves real audio end to end before any core change: Asterisk registers 102, the worker dials the owner's mobile through ARI, plays a cached EMA opening, transcribes one caller turn with seda, plays an EMA reply (with the bridge's own acknowledgement and filler in between) and prints the turn trace. If B7 fails, stop and report before Phase C.

Server conventions for every server step: run as `root` on the Contabo host (the coordinator's SSH method is in its own notes; never paste a password into a command or a file in the repo). Sources reach the host as a `git archive` of the reviewed commit:

```bash
# on the dev machine, from the repository root, at the commit to deploy
git -c core.autocrlf=false archive --format=tar HEAD rust/bridge/voice | ssh root@38.242.233.166 \
  'rm -rf /root/jeeta-voice-src && mkdir -p /root/jeeta-voice-src && tar -x -C /root/jeeta-voice-src'
```

On the Windows dev machine (`core.autocrlf=true`) a plain `git archive` writes CRLF line endings (checked 2026-10-29 on `rust/Cargo.toml`). `rust/bridge/voice/.gitattributes` (`* text=auto eol=lf`, B1) makes the archive of that tree LF on its own; `-c core.autocrlf=false` keeps any other path LF too.

### Task B1: Asterisk 22.11 as extension 102

**Files:**
- Create: `rust/bridge/voice/asterisk/Dockerfile`
- Create: `rust/bridge/voice/asterisk/etc/{asterisk.conf,modules.conf,logger.conf,cdr.conf,cel.conf,pjsip.conf,extensions.conf,http.conf,ari.conf,rtp.conf,manager.conf,chan_websocket.conf,pjproject.conf,websocket_client.conf}`
- Create: `rust/bridge/voice/asterisk/test_configs.py`
- Create: `rust/bridge/voice/asterisk/.dockerignore` (`*`: the image copies nothing from its context)
- Create: `rust/bridge/voice/asterisk/sip_probe.py` and `test_sip_probe.py` (Step 9's OPTIONS probe)
- Create: `rust/bridge/voice/deploy/jeeta-asterisk.service`
- Create: `rust/bridge/voice/deploy/jeeta-voice.tmpfiles`
- Create: `rust/bridge/voice/deploy/jeeta-voice.sysctl` (reserves the RTP range, Step 8)
- Create: `rust/bridge/voice/speech/pytest.ini`
- Create: `rust/bridge/voice/.gitattributes` (`* text=auto eol=lf`: the archive the host receives keeps LF, see the section intro)
- Create: `rust/bridge/voice/.gitignore` (`__pycache__/`: the repository ignores no Python cache, and `git add rust/bridge/voice/asterisk` after a test run would take it; and `asterisk/etc/secrets/`)
- Modify: `docs/operations/voice-bridge.md` (alert when the registration reads `Rejected`)

**Review revisions (PR #382, B1 review, 2026-10-29).** These are in the code below:
- The endpoint is identified by address only (`identify_by=ip`, `allow_transfer=no`, `match=sip5.netsantral.com,185.88.7.227`).
- A 403 stops the registration (`forbidden_retry_interval=0`).
- There is no persistent volume: astdb is on the run tmpfs, and `[directories]` is applied.
- AMI is off in an explicit `manager.conf`.
- The image checks each required module and runs `asterisk -V`.
- The container is hardened (`--cap-drop ALL`, `no-new-privileges`, `--pids-limit 256`, capped json-file logs, `noexec,nosuid,nodev` tmpfs, `Restart=always`, `--init`).
- The config test guards each invariant, and 56 of 56 mutations fail it.
- Steps 7–9 gate on the firewall, reserve the RTP range and probe the identification.

**Security check (2026-10-29).** This decision is needed before Step 9.
- **Asterisk 22.11.0: no open advisory.** The newest advisories in `asterisk/asterisk` were published on 2026-06-25 (20 of them). Each is patched in 22.10.1, and 22.11.0's ChangeLog diffs from 22.10.1, so 22.11.0 carries those fixes.
- **pjproject 2.17 (bundled): 40 advisories have been published since its release (2026-04-22), and none has a patched release.** Neither Asterisk's 22.12.0-rc3 nor `master` bumps pjproject (still 2.17) or adds a patch for them (`third-party/pjproject/patches` holds only build fixes).
- Most of them are in parts Asterisk does not use: pjmedia audio and video, pjsua/pjsua2, ICE/TURN/STUN, TLS/DTLS, the HTTP client, the telnet CLI, UPnP, AVI and H.263.
- These touch the code Asterisk runs:
  - the SIP parser: GHSA-pjx6-7vrm-3w6f (high, pre-auth over-read via an empty multipart body) and GHSA-277r-3q2j-mxcw;
  - the SDP parser and negotiator: GHSA-rfwg-w9gq-9mw2 (high, OOB write), GHSA-m9g3-jcj8-qjfm (high, a=crypto), GHSA-wf9x-v65x-5qh3 (high) and GHSA-966q-2r4w-549m (high, RED);
  - the registration client: GHSA-xc62-j9h2-mp84 (high, Service-Route in a registration response) and GHSA-3659-543c-qm3g;
  - dialog routing: GHSA-j4c2-253v-jgxw (high);
  - the PIDF/XML/NOTIFY bodies: GHSA-9vx3-qvj7-65c7, GHSA-cgmx-7mqj-77qp and GHSA-jw49-x2jp-8m4v.
- Here they are reachable only from NetGSM's signalling path. ufw denies incoming (Step 7 gate), and the only SIP admitted is conntrack's replies from `sip5.netsantral.com:5060` to 5070. A blind attacker would have to spoof that exact UDP 4-tuple.
- Options for the coordinator:
  1. Deploy 22.11.0 for the B7 slice with that exposure, and rebuild when Asterisk ships pjproject fixes (watch `asterisk/asterisk` `third-party/pjproject` and pjproject 2.18).
  2. Build the bundled pjproject from a pjproject `master` commit that holds the fixes. This is not tried here, and Asterisk's patches may not apply.
- **Decided (coordinator, 2026-10-29): option 1 for the test phase**, with the mitigations recorded under "Steps 7–9 as run" below.

**Version check (2026-10-29).** `asterisk-22.11.0.tar.gz` is the newest 22.x release on downloads.asterisk.org (22.12.0 is at rc3). Its published `asterisk-22.11.0.sha256` reads `3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94`, and the tarball fetched from both `…/asterisk/` and `…/asterisk/releases/` hashes to that value. The Dockerfile fetches from `releases/`, because the top directory keeps only the current release and drops 22.11.0 once 22.12.0 ships. The bundled pjproject is 2.17. Configure fetches it from `raw.githubusercontent.com/asterisk/third-party` and checks it against the MD5 inside the verified tarball.

- [ ] **Step 1: Write the failing config test**

`rust/bridge/voice/speech/pytest.ini` (shared by every Python test under `rust/bridge/voice`):

```ini
[pytest]
markers =
    models: needs the real model files (run on the Contabo host inside the images)
addopts = -q
```

`rust/bridge/voice/asterisk/test_configs.py`:

```python
"""The Asterisk configuration shipped in the repository, and the container it runs in.

Invariants: no secret in the repository; control (ARI) on loopback only and no AMI; no verbose
console (dialplan lines carry phone numbers); one UDP transport and one endpoint, NetGSM's,
identified by its address only; a dialplan that can only hand a call to the bridge or hang it up;
state on tmpfs; a read-only, unprivileged container; every module the bridge needs built and
never disabled."""
import pathlib
import re

HERE = pathlib.Path(__file__).parent
ETC = HERE / "etc"
UNIT = HERE.parent / "deploy" / "jeeta-asterisk.service"
DOCKERFILE = HERE / "Dockerfile"

NETGSM_HOST = "sip5.netsantral.com"
CREDENTIAL_KEYS = {"password", "secret", "md5_cred", "password_digest", "oauth_secret", "refresh_token"}
ALLOWED_DIRECTIVES = {
    "pjsip.conf": ["#include secrets/pjsip_auth.conf"],
    "ari.conf": ["#include secrets/ari_users.conf"],
}
DIALPLAN_APPS = {"stasis", "hangup"}
# The modules the bridge cannot work without (B1 review); the Dockerfile checks each is built. The
# last three no module requires, but the configuration relies on them: the 401 challenge to an
# unidentified request, the endpoint's NAT options, and extensions.conf itself.
REQUIRED_MODULES = [
    "chan_websocket", "chan_pjsip", "res_pjsip", "res_pjsip_session", "res_pjsip_sdp_rtp",
    "res_pjsip_outbound_registration", "res_pjsip_outbound_authenticator_digest",
    "res_pjsip_endpoint_identifier_ip", "res_rtp_asterisk", "res_http_websocket",
    "res_websocket_client", "res_ari", "res_ari_asterisk", "res_ari_channels", "res_ari_bridges",
    "res_ari_events", "res_stasis", "app_stasis", "bridge_simple", "bridge_softmix",
    "res_timing_timerfd", "codec_alaw", "codec_ulaw",
    "res_pjsip_authenticator_digest", "res_pjsip_nat", "pbx_config",
]
# Files the loaded modules read, shipped so none logs a load error at start (B1 Step 9 run).
MODULE_CONFIGS = ["chan_websocket.conf", "pjproject.conf", "websocket_client.conf"]


def read(name: str) -> str:
    return (ETC / name).read_text(encoding="utf-8")


def strip_comment(raw: str) -> str:
    return raw.split(";", 1)[0].strip()


def sections(name: str) -> list[tuple[str, str | None, list[tuple[str, str]]]]:
    """The file's sections in order: (name, template suffix or None, [(key lowercased, value)])."""
    out: list[tuple[str, str | None, list[tuple[str, str]]]] = []
    for raw in read(name).splitlines():
        line = strip_comment(raw)
        if not line or line.startswith("#"):
            continue
        header = re.match(r"^\[([^\]]+)\]\s*(\(.*\))?$", line)
        if header:
            out.append((header.group(1).strip(), header.group(2), []))
            continue
        key, sep, value = line.partition("=")
        assert sep, f"{name}: not a key = value line: {line}"
        assert out, f"{name}: a setting before the first section: {line}"
        value = value[1:] if value.startswith(">") else value
        out[-1][2].append((key.strip().lower(), value.strip()))
    return out


def values(items: list[tuple[str, str]], key: str) -> list[str]:
    return [v for k, v in items if k == key]


def pjsip_of_type(kind: str) -> list[tuple[str, list[tuple[str, str]]]]:
    return [
        (name, items)
        for name, _, items in sections("pjsip.conf")
        if kind in [v.lower() for v in values(items, "type")]
    ]


def test_no_secret_lives_in_the_repository():
    for path in sorted(ETC.glob("*.conf")):
        for name, _, items in sections(path.name):
            for key, _ in items:
                assert key not in CREDENTIAL_KEYS, f"{path.name} [{name}] sets {key}"
        directives = [
            strip_comment(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip().startswith("#")
        ]
        assert directives == ALLOWED_DIRECTIVES.get(path.name, []), f"{path.name}: {directives}"


def test_control_binds_loopback_only_and_ami_is_off():
    http = sections("http.conf")
    assert [n for n, _, _ in http] == ["general"]
    general = http[0][2]
    assert values(general, "bindaddr") == ["127.0.0.1"]
    assert values(general, "bindport") == ["8188"]
    assert not [k for k, _ in general if k.startswith("tls")], "http.conf must not enable TLS"
    manager = sections("manager.conf")
    assert [n for n, _, _ in manager] == ["general"], "manager.conf holds no AMI user"
    assert values(manager[0][2], "enabled") == ["no"]


def test_console_logs_warnings_and_errors_only():
    assert re.search(r"^console\s*=>\s*warning,error\s*$", read("logger.conf"), re.M)
    assert re.search(r"^verbose\s*=\s*0\s*$", read("asterisk.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cdr.conf"), re.M)
    assert re.search(r"^enable\s*=\s*no\s*$", read("cel.conf"), re.M)


def test_state_lives_on_the_run_tmpfs():
    directories = [(mark, items) for name, mark, items in sections("asterisk.conf") if name == "directories"]
    assert len(directories) == 1, "asterisk.conf has one [directories]"
    mark, items = directories[0]
    assert mark is None, f"[directories]{mark} is a template, which Asterisk does not apply"
    assert values(items, "astdbdir") == ["/var/run/asterisk"]
    assert values(items, "astrundir") == ["/var/run/asterisk"]


def test_extension_102_registers_over_one_udp_transport():
    for name, mark, items in sections("pjsip.conf"):
        assert mark is None, f"pjsip.conf [{name}] uses a template: {mark}"
        assert len(values(items, "type")) == 1, f"pjsip.conf [{name}] needs exactly one type"
    transports = pjsip_of_type("transport")
    assert len(transports) == 1, f"one transport, not {len(transports)}"
    _, transport = transports[0]
    assert values(transport, "protocol") == ["udp"]
    assert values(transport, "bind") == ["0.0.0.0:5070"]
    registrations = pjsip_of_type("registration")
    assert len(registrations) == 1
    _, reg = registrations[0]
    assert values(reg, "client_uri") == [f"sip:102-8508407303@{NETGSM_HOST}"]
    assert values(reg, "server_uri") == [f"sip:{NETGSM_HOST}"]
    # A 403 stops for good; timeouts and 5xx are retried for days, not stopped after ten tries.
    assert values(reg, "forbidden_retry_interval") == ["0"]
    assert values(reg, "max_retries") == ["10000"]
    assert values(reg, "auth_rejection_permanent") in ([], ["yes"])
    rtp = read("rtp.conf")
    assert "rtpstart=40000" in rtp and "rtpend=40099" in rtp


def test_the_only_endpoint_is_netgsm_identified_by_its_address():
    names = [name.lower() for name, _, _ in sections("pjsip.conf")]
    assert "anonymous" not in names, "an [anonymous] endpoint would take unidentified requests"
    endpoints = pjsip_of_type("endpoint")
    assert [name for name, _ in endpoints] == ["netgsm"], f"endpoints: {[n for n, _ in endpoints]}"
    _, endpoint = endpoints[0]
    assert values(endpoint, "identify_by") == ["ip"]
    assert values(endpoint, "allow_transfer") == ["no"]
    assert values(endpoint, "context") == ["jeeta-in"]
    assert not values(endpoint, "auth"), "no inbound auth object: identification is by address"
    keys = [k for k, _ in endpoint]
    assert values(endpoint, "disallow") == ["all"]
    assert keys.index("disallow") < keys.index("allow"), "disallow=all must come before allow"
    every_allow = [v for _, _, items in sections("pjsip.conf") for v in values(items, "allow")]
    assert every_allow == ["alaw,ulaw"], f"allow: {every_allow}"
    identifies = pjsip_of_type("identify")
    assert len(identifies) == 1
    _, identify = identifies[0]
    assert values(identify, "endpoint") == ["netgsm"]
    (match,) = values(identify, "match")
    entries = [e.strip() for e in match.split(",")]
    assert entries[0] == NETGSM_HOST, f"match starts with {entries[0]}"
    for entry in entries[1:]:
        address = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})(?:/(\d{1,2}))?", entry)
        assert address, f"match entry {entry}: a host address or a /24-/32 network only"
        assert int(address.group(2) or 32) >= 24, f"match entry {entry} is too wide"


def test_inbound_calls_can_only_enter_the_bridge_application():
    plan = sections("extensions.conf")
    assert [name for name, _, _ in plan] == ["general", "jeeta-in"]
    apps = []
    for key, value in plan[1][2]:
        assert key in {"exten", "same"}, f"extensions.conf: {key} => {value}"
        fields = value.split(",", 2 if key == "exten" else 1)
        app = re.match(r"\s*([A-Za-z_]+)", fields[-1])
        assert app, f"extensions.conf: no application in {value}"
        apps.append(app.group(1).lower())
    assert set(apps) <= DIALPLAN_APPS, f"applications: {sorted(set(apps))}"
    assert "stasis" in apps
    assert "Stasis(jeeta-voice,in)" in read("extensions.conf")


def test_the_container_runs_read_only_and_unprivileged():
    unit = UNIT.read_text(encoding="utf-8")
    for flag in [
        "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256",
        "--network host", "--user 1500:1500", "--init",
    ]:
        assert flag in unit, f"jeeta-asterisk.service lacks {flag}"
    assert "/var/lib/asterisk" not in unit, "no persistent volume: state lives on tmpfs"
    tmpfs = re.findall(r"--tmpfs (\S+)", unit)
    assert len(tmpfs) == 3
    for mount in tmpfs:
        options = mount.split(":", 1)[1].split(",")
        assert {"noexec", "nosuid", "nodev"} <= set(options), f"{mount}"
    assert "/etc/jeeta-voice/asterisk:/etc/asterisk:ro" in unit
    assert re.search(r"^Restart=always$", unit, re.M)


def test_every_module_the_bridge_needs_is_built_and_never_disabled():
    modules = sections("modules.conf")
    noload = {v.removesuffix(".so") for _, _, items in modules for v in values(items, "noload")}
    assert not noload & set(REQUIRED_MODULES), f"disabled: {sorted(noload & set(REQUIRED_MODULES))}"
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    checked = re.search(r"for m in ([^;]+);", dockerfile)
    assert checked, "the Dockerfile checks the required modules in a `for m in ...;` loop"
    assert [t for t in checked.group(1).split() if t != "\\"] == REQUIRED_MODULES
    for name in MODULE_CONFIGS:
        assert (ETC / name).is_file(), f"{name} is missing: its module logs a load error"
    websocket = sections("chan_websocket.conf")
    assert [(n, values(items, "control_message_format")) for n, _, items in websocket] == [
        ("global", ["json"])
    ]


def test_the_base_images_are_pinned_by_digest():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE.read_text(encoding="utf-8"), re.M)
    assert len(froms) == 2, froms
    for image in froms:
        assert re.fullmatch(r"debian:bookworm-slim@sha256:[0-9a-f]{64}", image), image
```

`rust/bridge/voice/asterisk/test_sip_probe.py` (the probe of Step 9, below):

```python
"""The SIP OPTIONS probe of B1 Step 9: one well-formed request, and only the status line back."""
import socket
import threading

from sip_probe import options, probe


def test_the_request_is_one_well_formed_options():
    raw = options("203.0.113.7", 5070, "netgsm", ("198.51.100.2", 40123), "abc123").decode("ascii")
    lines = raw.split("\r\n")
    assert lines[0] == "OPTIONS sip:203.0.113.7:5070 SIP/2.0"
    assert "Via: SIP/2.0/UDP 198.51.100.2:40123;branch=z9hG4bKabc123;rport" in lines
    assert "From: <sip:netgsm@probe.invalid>;tag=abc123" in lines
    assert "CSeq: 1 OPTIONS" in lines
    assert raw.endswith("Content-Length: 0\r\n\r\n")


def answer_once(reply: bytes) -> tuple[int, threading.Thread]:
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("127.0.0.1", 0))
    server.settimeout(5)

    def run():
        with server:
            request, peer = server.recvfrom(65535)
            assert request.startswith(b"OPTIONS ")
            server.sendto(b"SIP/2.0 100 Trying\r\n\r\n", peer)
            server.sendto(reply, peer)

    thread = threading.Thread(target=run)
    thread.start()
    return server.getsockname()[1], thread


def test_the_probe_prints_the_final_status_line_and_nothing_else():
    reply = (
        b"SIP/2.0 401 Unauthorized\r\n"
        b"From: <sip:05321234567@probe.invalid>;tag=x\r\n"
        b'WWW-Authenticate: Digest realm="asterisk",nonce="n"\r\n\r\n'
    )
    port, thread = answer_once(reply)
    assert probe("127.0.0.1", port, "netgsm") == "SIP/2.0 401 Unauthorized"
    thread.join()


def test_silence_reads_no_answer():
    closed = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    with closed:  # bound but never answering
        assert probe("127.0.0.1", port, "netgsm", timeout_s=0.3) == "no answer"
```

- [ ] **Step 2: Run it to see it fail**

Run (Windows or Linux, from `rust/bridge/voice`, Python 3.12 with `pip install pytest==8.4.2`): `python -I -m pytest -c speech/pytest.ini asterisk`
Expected: FAIL (`FileNotFoundError` for the configs, `ModuleNotFoundError: sip_probe`).

- [ ] **Step 3: Write the configuration**

`rust/bridge/voice/asterisk/etc/asterisk.conf`:

```ini
; Applied as written (no "(!)" template mark). The image is read-only: the database lives on the
; run directory's tmpfs, so nothing persists between starts.
[directories]
astetcdir => /etc/asterisk
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => /var/lib/asterisk
astdbdir => /var/run/asterisk
astkeydir => /var/lib/asterisk
astdatadir => /var/lib/asterisk
astagidir => /var/lib/asterisk/agi-bin
astspooldir => /var/spool/asterisk
astrundir => /var/run/asterisk
astlogdir => /var/log/asterisk
astsbindir => /usr/sbin

[options]
verbose = 0
debug = 0
; Silence while a channel waits (Wait, Record, ...). It has no effect on a channel in a bridge: the
; websocket media channel sends nothing unless the worker writes frames (B5/B6 pacer).
transmit_silence = yes
```

`rust/bridge/voice/asterisk/etc/modules.conf`:

```ini
[modules]
autoload = yes
noload = chan_iax2.so
noload = chan_unistim.so
noload = chan_mgcp.so
noload = chan_skinny.so
noload = cdr_csv.so
noload = cdr_custom.so
noload = cdr_manager.so
noload = cel_custom.so
noload = cel_manager.so
noload = pbx_ael.so
noload = pbx_lua.so
noload = res_phoneprov.so
noload = res_pjsip_phoneprov_provider.so
```

`rust/bridge/voice/asterisk/etc/logger.conf`:

```ini
[general]

[logfiles]
console => warning,error
```

`rust/bridge/voice/asterisk/etc/cdr.conf`:

```ini
[general]
enable = no
```

`rust/bridge/voice/asterisk/etc/cel.conf`:

```ini
[general]
enable = no
```

`rust/bridge/voice/asterisk/etc/pjsip.conf`:

```ini
; NetGSM Netsantral extension 102 ("jeetases"): UDP, registered from this host only. The secret
; lives in secrets/pjsip_auth.conf (0600, uid 1500), never in the repository.
[global]
type=global
user_agent=jeeta-voice
endpoint_identifier_order=ip,username

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5070

#include secrets/pjsip_auth.conf

; What a registrar's answer does (Asterisk 22.11, res_pjsip_outbound_registration):
; - 401/407 to the authenticated REGISTER (a wrong secret): stops for good, until a restart
;   (auth_rejection_permanent defaults to yes).
; - 403: stops for good (forbidden_retry_interval=0); retrying would only hammer NetGSM.
; - 408 (no answer, also DNS or network failure) and 500/502/503/504: retried every
;   retry_interval (30 s), at most max_retries times in a row (about 83 hours), then it stops.
; - Any stop reads "Rejected" in `pjsip show registrations`: alert on it (docs/operations/voice-bridge.md).
[netgsm-reg]
type=registration
transport=transport-udp
outbound_auth=netgsm-auth
server_uri=sip:sip5.netsantral.com
client_uri=sip:102-8508407303@sip5.netsantral.com
contact_user=102-8508407303
retry_interval=30
forbidden_retry_interval=0
max_retries=10000
expiration=120
line=yes
endpoint=netgsm

; Kept at 20 s: NetGSM answers OPTIONS with 200 (B1 Step 9, 2026-10-29), so the keep-alive costs
; one round trip and holds the conntrack entry the inbound INVITEs need.
[netgsm]
type=aor
contact=sip:sip5.netsantral.com
qualify_frequency=20

; The only endpoint. No inbound auth: it is identified by NetGSM's source address only
; (identify_by=ip; the default username,ip would let any From: <sip:netgsm@...> in), or by the
; random line token Asterisk puts in its registration Contact (line=yes above).
[netgsm]
type=endpoint
transport=transport-udp
context=jeeta-in
identify_by=ip
disallow=all
allow=alaw,ulaw
outbound_auth=netgsm-auth
aors=netgsm
from_user=102-8508407303
from_domain=sip5.netsantral.com
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc4733
trust_id_inbound=no
send_pai=no
allow_transfer=no

; The hostname is resolved when the configuration loads; the literal address keeps the match when
; DNS fails at start-up. If NetGSM's address changes: update it here, then `pjsip reload`.
[netgsm]
type=identify
endpoint=netgsm
match=sip5.netsantral.com,185.88.7.227
```

`rust/bridge/voice/asterisk/etc/extensions.conf`:

```ini
[general]
static=yes
writeprotect=yes

; Every inbound call goes to the voice bridge's application; it answers or refuses it.
[jeeta-in]
exten => _X.,1,Stasis(jeeta-voice,in)
 same => n,Hangup(17)
exten => _+X.,1,Stasis(jeeta-voice,in)
 same => n,Hangup(17)
exten => s,1,Stasis(jeeta-voice,in)
 same => n,Hangup(17)
exten => i,1,Stasis(jeeta-voice,in)
 same => n,Hangup(17)
```

`rust/bridge/voice/asterisk/etc/http.conf`:

```ini
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8188
```

`rust/bridge/voice/asterisk/etc/ari.conf`:

```ini
[general]
enabled=yes
pretty=no

#include secrets/ari_users.conf
```

`rust/bridge/voice/asterisk/etc/rtp.conf`:

```ini
[general]
rtpstart=40000
rtpend=40099
```

`rust/bridge/voice/asterisk/etc/manager.conf`:

```ini
; No AMI: the voice bridge drives Asterisk through ARI only (http.conf, loopback).
[general]
enabled = no
webenabled = no
```

`rust/bridge/voice/asterisk/etc/chan_websocket.conf`:

```ini
; chan_websocket's global options (Asterisk >= 22.8). The bridge asks for JSON control messages on
; each channel (ARI externalMedia transport_data f(json)); this makes JSON the default as well, and
; gives the module its file (without one, every start logs a load error).
[global]
type=global
control_message_format=json
```

`rust/bridge/voice/asterisk/etc/pjproject.conf`:

```ini
; res_pjproject's file, present so the module loads without an error; its defaults apply.
```

`rust/bridge/voice/asterisk/etc/websocket_client.conf`:

```ini
; No outbound WebSocket client: the bridge connects to Asterisk (chan_websocket in server mode,
; /media/<connection id> on http.conf's loopback port). The file exists so the module loads
; without an error.
```

- [ ] **Step 4: Run the config test**

Run: `python -I -m pytest -c speech/pytest.ini asterisk`
Expected: `13 passed` (10 config, 3 probe). The probe module must exist for this run, so write `sip_probe.py` (Step 5) before it.

The config test was mutation-tested. Each of 56 edits fails at least one assertion. The edits include: `Dial`/`System`/`Exec`/`Originate`/`include` in the dialplan; an `[anonymous]` or second endpoint; a template; http `tls*` or `bindaddr=0.0.0.0`; `g722`; `disallow=all` removed or moved after `allow`; `match=0.0.0.0/0` (also `/0.0.0.0` or `/8`); `Password`/`md5_cred`/`secret`/`password_digest`; `#exec`; an extra transport or TCP; `identify_by` removed or `username,ip`; `allow_transfer` removed; inbound `auth`; a 403 retry; `max_retries` removed; AMI on, or `manager.conf` deleted; `(!)` back; astdb off the tmpfs; the volume back; `--cap-drop`/`no-new-privileges`/`--read-only` removed; exec allowed on a tmpfs; `Restart=on-failure`; a required module noloaded or dropped from the Dockerfile check.

- [ ] **Step 5: Write the image and the units**

`rust/bridge/voice/asterisk/Dockerfile`:

```dockerfile
# Asterisk 22.11.0 (>= 22.8: chan_websocket with JSON control and ARI externalMedia websocket),
# built from the verified release tarball. Runs as uid/gid 1500 with the host network.
# The tarball is fetched from releases/, where every version stays; the top directory keeps only
# the current one. The sha256 is the one downloads.asterisk.org publishes (asterisk-22.11.0.sha256),
# checked against the tarball itself on 2026-10-29. The bundled pjproject (2.17) is fetched during
# configure and checked against the MD5 that this verified tarball ships.
# Both base images are pinned by digest: debian:bookworm-slim as pulled for the first good build
# (B1 Step 9, 2026-10-29). Move the pin with a reviewed commit, never by a floating tag.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS build
ARG ASTERISK_VERSION=22.11.0
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
# Parallel compile jobs: 2 of the host's 6 shared vCPUs, so the neighbours keep theirs.
ARG MAKE_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget bzip2 patch file pkg-config python3 \
      libedit-dev libjansson-dev libssl-dev libsqlite3-dev libxml2-dev uuid-dev libcurl4-openssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl --proto =https --tlsv1.2 -fsSLo asterisk.tar.gz \
      "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum -c - \
 && tar -xzf asterisk.tar.gz --strip-components=1 && rm asterisk.tar.gz
# make install creates a real /out/var/run; in the runtime image /var/run is a symlink to /run, and
# the COPY below would collide with it, so it is dropped here and made through the symlink there.
# Headers and man pages are not needed at run time.
RUN ./configure --with-pjproject-bundled --without-x11 --without-gtk2 \
 && make menuselect.makeopts \
 && menuselect/menuselect --disable BUILD_NATIVE --enable chan_websocket --enable chan_pjsip \
      --enable res_pjsip_outbound_registration --enable res_ari --enable res_ari_channels \
      --enable res_ari_bridges --enable res_stasis --enable app_stasis --enable codec_alaw \
      --enable codec_ulaw --disable-category MENUSELECT_CORE_SOUNDS \
      --disable-category MENUSELECT_MOH --disable-category MENUSELECT_EXTRA_SOUNDS \
      menuselect.makeopts \
 && make -j"${MAKE_JOBS}" && make install DESTDIR=/out \
 && rm -rf /out/var/run /out/usr/include /out/usr/share/man

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libedit2 libjansson4 libssl3 libsqlite3-0 libxml2 libuuid1 libcurl4 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1500 asterisk && useradd --uid 1500 --gid 1500 --home-dir /var/lib/asterisk \
      --shell /usr/sbin/nologin asterisk
# Root-owned and read-only at run time: nothing is chowned. The only writable paths are the three
# tmpfs mounts of the unit (run, log, spool), owned 1500 by their mount options; their empty mount
# points are made here so the image also starts without them.
COPY --from=build /out/ /
# Fail the build, not the first call: every module the bridge needs is built (the list is
# asterisk/test_configs.py's REQUIRED_MODULES), no module lacks a library, and the binary runs.
RUN ldconfig \
 && for m in chan_websocket chan_pjsip res_pjsip res_pjsip_session res_pjsip_sdp_rtp \
      res_pjsip_outbound_registration res_pjsip_outbound_authenticator_digest \
      res_pjsip_endpoint_identifier_ip res_rtp_asterisk res_http_websocket res_websocket_client \
      res_ari res_ari_asterisk res_ari_channels res_ari_bridges res_ari_events res_stasis app_stasis \
      bridge_simple bridge_softmix res_timing_timerfd codec_alaw codec_ulaw \
      res_pjsip_authenticator_digest res_pjsip_nat pbx_config; do \
      test -f "/usr/lib/asterisk/modules/$m.so" || { echo "module $m was not built"; exit 1; }; \
    done \
 && ! { ldd /usr/sbin/asterisk /usr/lib/libasterisk*.so* /usr/lib/asterisk/modules/*.so 2>&1 \
        | grep -F 'not found'; } \
 && /usr/sbin/asterisk -V \
 && install -d -o 1500 -g 1500 -m 0750 /var/run/asterisk /var/log/asterisk /var/spool/asterisk
USER 1500:1500
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/usr/sbin/asterisk", "-rx", "core waitfullybooted"]
CMD ["/usr/sbin/asterisk", "-f"]
```

`rust/bridge/voice/asterisk/.dockerignore`:

```
# The image downloads its sources and copies nothing from the build context; the configs are
# mounted at run time, so neither they nor the tests are sent to the daemon.
*
```

`rust/bridge/voice/deploy/jeeta-asterisk.service`:

```ini
[Unit]
Description=Jeeta voice edge (Asterisk, NetGSM extension 102)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

# Read-only and unprivileged: no capability is needed (SIP 5070, RTP 40000-40099 and ARI 8188 are
# above 1024; Asterisk runs without -p, so no realtime scheduling). Nothing persists between starts:
# the database is on the run tmpfs (asterisk.conf astdbdir).
[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f jeeta-asterisk
ExecStart=/usr/bin/docker run --rm --name jeeta-asterisk --init --network host --user 1500:1500 \
  --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
  --cpus 1 --memory 512m \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --tmpfs /var/run/asterisk:uid=1500,gid=1500,mode=0750,size=16m,noexec,nosuid,nodev \
  --tmpfs /var/log/asterisk:uid=1500,gid=1500,mode=0750,size=16m,noexec,nosuid,nodev \
  --tmpfs /var/spool/asterisk:uid=1500,gid=1500,mode=0750,size=16m,noexec,nosuid,nodev \
  -v /etc/jeeta-voice/asterisk:/etc/asterisk:ro \
  jeeta-asterisk:22.11.0
ExecStop=/usr/bin/docker stop -t 10 jeeta-asterisk
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

`rust/bridge/voice/deploy/jeeta-voice.tmpfiles` (installed as `/etc/tmpfiles.d/jeeta-voice.conf`):

```
d /run/jeeta-voice 1770 root jeeta-voice -
```

`rust/bridge/voice/deploy/jeeta-voice.sysctl` (installed as `/etc/sysctl.d/60-jeeta-voice.conf` in Step 8):

```
# Installed as /etc/sysctl.d/60-jeeta-voice.conf. Asterisk's RTP range (asterisk/etc/rtp.conf) is
# inside the kernel's ephemeral range (32768-60999): reserved, no outgoing connection takes one of
# its ports. This value replaces the whole list: merge it with any existing reservation first.
net.ipv4.ip_local_reserved_ports = 40000-40099
```

`rust/bridge/voice/asterisk/sip_probe.py` (one OPTIONS, only the status line printed; used in Step 9):

```python
"""One SIP OPTIONS to host:port; prints only the answer's status line (never a header, which
could carry a number), or `no answer` after the timeout. Standard library only (B1 Step 9).

    python3 sip_probe.py <host> <port> <from-user>
"""
import secrets
import socket
import sys


def options(host: str, port: int, from_user: str, local: tuple[str, int], tag: str) -> bytes:
    """An OPTIONS from <sip:from_user@probe.invalid>, answered to `local` (rport)."""
    local_host, local_port = local[0], local[1]
    return (
        f"OPTIONS sip:{host}:{port} SIP/2.0\r\n"
        f"Via: SIP/2.0/UDP {local_host}:{local_port};branch=z9hG4bK{tag};rport\r\n"
        "Max-Forwards: 70\r\n"
        f"From: <sip:{from_user}@probe.invalid>;tag={tag}\r\n"
        f"To: <sip:{host}:{port}>\r\n"
        f"Call-ID: {tag}@probe.invalid\r\n"
        "CSeq: 1 OPTIONS\r\n"
        "User-Agent: jeeta-sip-probe\r\n"
        "Content-Length: 0\r\n"
        "\r\n"
    ).encode("ascii")


def status_line(reply: bytes) -> str:
    """The reply's first line when it is a SIP answer; nothing else of it."""
    first = reply.split(b"\r\n", 1)[0].decode("ascii", "replace")
    return first if first.startswith("SIP/2.0 ") else "not a SIP answer"


def probe(host: str, port: int, from_user: str, timeout_s: float = 3.0) -> str:
    """The final answer's status line (a provisional 1xx is skipped), or `no answer`."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout_s)
        s.connect((host, port))
        s.send(options(host, port, from_user, s.getsockname(), secrets.token_hex(8)))
        for _ in range(3):
            try:
                line = status_line(s.recv(65535))
            except OSError:  # timeout, or an ICMP port unreachable
                return "no answer"
            if not line.startswith("SIP/2.0 1"):
                return line
        return "no answer"


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: sip_probe.py <host> <port> <from-user>")
    print(probe(sys.argv[1], int(sys.argv[2]), sys.argv[3]))
```

- [ ] **Step 6: Commit**

```bash
git add rust/bridge/voice/.gitattributes rust/bridge/voice/.gitignore rust/bridge/voice/asterisk rust/bridge/voice/deploy rust/bridge/voice/speech/pytest.ini docs/operations/voice-bridge.md
git commit -m "feat(voice): Asterisk 22.11 image and config for extension 102" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: [COORDINATOR, server] Preconditions and the firewall gate**

Copy the sources (section intro), then on the host:

```bash
# The gate: SIP and RTP rely on conntrack; 5070 and 40000-40099 are never opened to the internet.
{ ufw status verbose | grep -qx 'Status: active' \
    && ufw status verbose | grep -q '^Default: deny (incoming)' && echo "FIREWALL OK (ufw)"; } \
  || { iptables -S INPUT | grep -qx -- '-P INPUT DROP' && echo "FIREWALL OK (iptables INPUT policy DROP)"; } \
  || echo "STOP: no default-deny firewall"
ufw status | grep -E '\b(5070|400[0-9]{2})\b' && echo "STOP: a rule opens 5070 or the RTP range" \
  || echo "no rule opens 5070 or 40000-40099"
docker ps --format '{{.Image}} {{.Names}}' | grep -i voicegate || echo "no Gate V1 rig running"
ss -lunp | grep -E ':(5062|5070)\b' || echo "5062/udp and 5070/udp free"
ss -Hlunp '( sport >= :40000 and sport <= :40099 )' | grep . || echo "40000-40099/udp free"
docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':400[0-9]{2}' || echo "no container publishes 40000-40099"
ss -ltnp | grep -E ':8188\b' || echo "8188/tcp free"
sysctl -n net.ipv4.ip_local_reserved_ports
getent passwd 1500 1501; getent group 1500 1501 || true
command -v docker python3
docker info --format '{{.InitBinary}}'; ls -l /usr/libexec/docker/docker-init
```

Expected:
- The gate prints `FIREWALL OK`. **If it prints `STOP: no default-deny firewall`, stop B1.** Do not open 5070 or the RTP range to make it pass: the design relies on conntrack for SIP and RTP.
- `no rule opens 5070 or 40000-40099`.
- `no Gate V1 rig running`. A baresip still registered as 102 would fight the registration. Gate V1's baresip listened on 5062. If one is listed, stop it with `docker rm -f <name>`.
- 5070/udp, the RTP range and 8188/tcp are free. Asterisk owns the RTP range on the host network.
- `ip_local_reserved_ports` is empty; Step 8 sets it.
- uid/gid 1500 and 1501 are unused. If one is taken, change the uid in the Dockerfile, in the units and in every `1500`/`1501` below together.
- `/usr/bin/docker` (the unit's path) and `python3` (Step 9's probe) exist.
- `docker info` names `docker-init` as the init binary, and `/usr/libexec/docker/docker-init` exists, for `--init`. On this host docker-ce keeps it outside `PATH`, so `command -v docker-init` finds nothing.

- [ ] **Step 8: [COORDINATOR, server] Users, directories, secrets and the RTP reservation**

One script with `set -eu`, so the first failure stops it without closing your shell:

```bash
bash -eu <<'STEP8'
[ -s /root/voicegate/p102 ] || { echo "STOP: /root/voicegate/p102 is missing or empty"; exit 1; }
# Asterisk reads ";" as the start of a comment and trims spaces: such a secret would be cut.
if tr -d '\r\n' < /root/voicegate/p102 | grep -q '[;\\[:space:]]'; then
  echo "STOP: the secret holds ; \\ or a space"; exit 1
fi
getent group jeeta-voice >/dev/null || groupadd --system --gid 1501 jeeta-voice
getent passwd jeeta-voice-svc >/dev/null \
  || useradd --system --uid 1501 --gid jeeta-voice --no-create-home --shell /usr/sbin/nologin jeeta-voice-svc
getent passwd jeeta-voice-bridge >/dev/null \
  || useradd --system --user-group --home-dir /var/lib/jeeta-voice --shell /usr/sbin/nologin jeeta-voice-bridge
usermod -aG jeeta-voice jeeta-voice-bridge
install -d -m 0750 /etc/jeeta-voice
install -d -m 0755 /etc/jeeta-voice/asterisk
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/asterisk/etc/*.conf /etc/jeeta-voice/asterisk/
install -d -m 0700 -o 1500 -g 1500 /etc/jeeta-voice/asterisk/secrets
umask 077
{ printf '[netgsm-auth]\ntype=auth\nauth_type=digest\nusername=102-8508407303\nrealm=asterisk\npassword='
  tr -d '\r\n' < /root/voicegate/p102; printf '\n'; } > /etc/jeeta-voice/asterisk/secrets/pjsip_auth.conf
ARI_PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
printf '[jeeta-voice]\ntype=user\nread_only=no\npassword_format=plain\npassword=%s\n' "$ARI_PW" \
  > /etc/jeeta-voice/asterisk/secrets/ari_users.conf
printf 'ARI_PASSWORD=%s\n' "$ARI_PW" > /etc/jeeta-voice/ari.env
unset ARI_PW
chown 1500:1500 /etc/jeeta-voice/asterisk/secrets/*.conf
chmod 0600 /etc/jeeta-voice/asterisk/secrets/*.conf /etc/jeeta-voice/ari.env
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice.tmpfiles /etc/tmpfiles.d/jeeta-voice.conf
systemd-tmpfiles --create /etc/tmpfiles.d/jeeta-voice.conf
reserved="$(sysctl -n net.ipv4.ip_local_reserved_ports)"
if [ -n "$reserved" ] && [ "$reserved" != "40000-40099" ]; then
  echo "STOP: $reserved is already reserved; merge it into jeeta-voice.sysctl before installing"; exit 1
fi
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice.sysctl /etc/sysctl.d/60-jeeta-voice.conf
sysctl -p /etc/sysctl.d/60-jeeta-voice.conf
ls -l /etc/jeeta-voice/asterisk/secrets /etc/jeeta-voice/ari.env
ls -ld /run/jeeta-voice
STEP8
```

Expected:
- No `STOP` line.
- Both secret files are `-rw------- 1500 1500`, and `ari.env` is `-rw------- root root`.
- `/run/jeeta-voice` is `drwxrwx--T root jeeta-voice` (1770, sticky).
- `net.ipv4.ip_local_reserved_ports = 40000-40099`.
- Nothing printed contains the secret.

Notes:
- `auth_type=digest` replaces `userpass`, which Asterisk 22 documents as deprecated.
- `realm=asterisk` is the realm Gate V1's REGISTER saw.
- A second run writes a new ARI password. Restart `jeeta-asterisk` (and later the bridge) after it.
- `useradd` warns that `jeeta-voice-svc`'s uid 1501 is greater than `SYS_UID_MAX` 999. This is harmless: the fixed uid is deliberate, so the container's user maps to it.

- [ ] **Step 9: [COORDINATOR, server] Build, start, and check**

```bash
cd /root/jeeta-voice-src/rust/bridge/voice/asterisk
docker pull -q debian:bookworm-slim && docker image inspect --format '{{index .RepoDigests 0}}' debian:bookworm-slim
time docker build -t jeeta-asterisk:22.11.0 .
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-asterisk.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/jeeta-asterisk.service
systemctl daemon-reload && systemctl enable --now jeeta-asterisk
sleep 20
docker ps --filter name=jeeta-asterisk --format '{{.Names}} {{.Status}}'
docker exec jeeta-asterisk asterisk -rx 'pjsip show registrations'
docker exec jeeta-asterisk asterisk -rx 'pjsip show contacts'
docker exec jeeta-asterisk asterisk -rx 'pjsip show identifies'
for m in chan_websocket chan_pjsip res_pjsip res_pjsip_session res_pjsip_sdp_rtp res_pjsip_outbound_registration res_pjsip_outbound_authenticator_digest res_pjsip_endpoint_identifier_ip res_rtp_asterisk res_http_websocket res_websocket_client res_ari res_ari_asterisk res_ari_channels res_ari_bridges res_ari_events res_stasis app_stasis bridge_simple bridge_softmix res_timing_timerfd codec_alaw codec_ulaw res_pjsip_authenticator_digest res_pjsip_nat pbx_config; do
  docker exec jeeta-asterisk asterisk -rx "module show like $m.so" | grep -q Running || echo "NOT RUNNING: $m"
done; echo "required modules checked"
for p in ari stasis pjsip; do docker exec jeeta-asterisk asterisk -rx "module show like $p" | tail -1; done
ss -lunp | grep asterisk; ss -ltnp | grep asterisk
docker stats --no-stream --format '{{.Name}} pids {{.PIDs}} mem {{.MemUsage}}' jeeta-asterisk
set -a; . /etc/jeeta-voice/ari.env; set +a
printf 'user = "jeeta-voice:%s"\n' "$ARI_PASSWORD" | curl -s -K - http://127.0.0.1:8188/ari/asterisk/info | head -c 120; echo
unset ARI_PASSWORD
journalctl -u jeeta-asterisk -b --no-pager | grep -ciE 'error' || true
# The identification probe (B1 review). From the host to its own public address (over lo, which
# ufw admits). Any From user, NetGSM's endpoint name included, must be challenged.
for u in netgsm 102-8508407303 probe; do
  python3 /root/jeeta-voice-src/rust/bridge/voice/asterisk/sip_probe.py 38.242.233.166 5070 "$u"
done
# NetGSM's own answer to OPTIONS, which decides qualify_frequency (below).
python3 /root/jeeta-voice-src/rust/bridge/voice/asterisk/sip_probe.py sip5.netsantral.com 5060 102-8508407303
```

From the dev machine, the same probe from outside: `python -I rust/bridge/voice/asterisk/sip_probe.py 38.242.233.166 5070 netgsm`

Expected:
- **The build** ends with `naming to docker.io/library/jeeta-asterisk:22.11.0`. Before that, the runtime stage prints `Asterisk 22.11.0` from its module check.
  - Record `time` and the digest printed before the build. Both `FROM` lines are pinned to the first build's digest (`debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3`). A different digest here means Docker Hub moved the tag; the pinned build is unaffected.
  - `nice` is not used: the build's processes run under dockerd. The throttle is `MAKE_JOBS=2`; override it with `--build-arg MAKE_JOBS=…`.
- **`docker ps`** shows `Up … (healthy)` once the 30 s start period is over. The `HEALTHCHECK` is `asterisk -rx 'core waitfullybooted'`.
- **The registration** line shows `netgsm-reg/sip:sip5.netsantral.com` and `Registered`.
- **`pjsip show identifies`** lists `netgsm` with the match `185.88.7.227/32`. The hostname and the literal resolve to the same address today.
- **Modules:** no `NOT RUNNING` line for the 26 required modules. The three counts list `ari`, `stasis` and `pjsip` modules.
- **Sockets:** UDP `0.0.0.0:5070`, TCP `127.0.0.1:8188`, and two ephemeral UDP sockets, `0.0.0.0:<n>` and `[::]:<n>`. RTP ports open only during a call.
  - The two ephemeral sockets are pjproject's DNS resolver. res_pjsip creates it at load (`res_pjsip.c` calls `ast_sip_initialize_dns()`, which runs `pjsip_endpt_create_resolver` in `res_pjsip/config_system.c`), even though Asterisk's own resolver then takes over SIP lookups (`pjsip_resolver.c`).
  - pjlib-util's `init_sock` binds one IPv4 and one IPv6 UDP socket to port 0 (`PJ_HAS_IPV6` is 1 in Asterisk's `config_site.h`). They exchange DNS with the system's nameservers only.
  - Step 11 keeps them, since res_pjsip is required. ufw denies inbound to them like any port.
- **`docker stats`:** pids well under 256 (about 60–150 expected), mem under 512 MiB. Report pids if they come near 200.
- **ARI** answers JSON starting `{"build":`.
- **The journal** holds only warnings and errors. Modules without a config of their own may warn once at start.
- **The probe from the host** prints `SIP/2.0 401 Unauthorized` for each of `netgsm`, `102-8508407303` and `probe`.
  - Under the old default (`identify_by=username,ip`), `From: netgsm` would have been taken as the endpoint unchallenged, answered 200 or 404.
  - Run the probe again after any change to `pjsip.conf` (`pjsip reload` or a restart).
- **The probe from outside** prints `no answer`: ufw drops unsolicited SIP.
- **NetGSM's answer** decides `qualify_frequency`. In 22.11 a qualify counts any reply as `Avail`, 401 included; only silence makes the contact `Unavail`, and the dial (`PJSIP/<n>@netgsm`) uses only a reachable contact.
  - `SIP/2.0 200 OK`: keep `qualify_frequency=20`. The keep-alive refreshes the conntrack entry every 20 s. **Decided on the 2026-10-29 run:** NetGSM answered 200, and 20 stays (`pjsip.conf`, `docs/operations/voice-bridge.md` §6).
  - `401`/`407`: start at `qualify_frequency=0`. Each qualify would cost NetGSM a challenge and an authenticated OPTIONS. Without it, only NetGSM's own OPTIONS would hold the entry: NetGSM grants a registration about 600 s (`exp. 559s` as run), so the REGISTER refresh comes about every 10 minutes, which is longer than a UDP conntrack entry lives.
  - `no answer`: `qualify_frequency=0`. An `Unavail` contact would block every dial.
  - To change it: `sed -i 's/^qualify_frequency=20$/qualify_frequency=0/' /etc/jeeta-voice/asterisk/pjsip.conf && docker exec jeeta-asterisk asterisk -rx 'pjsip reload'`. Then `pjsip show contacts` reads `Unknown`, which is dialable. Report the result so the repository follows.

If the registration reads `Rejected`, check the secret file without printing it, and check that no other UA registers 102. If it reads `No Response`, check `ufw` outbound and DNS. A lasting `Rejected` is the alert of `docs/operations/voice-bridge.md` §6.

**Steps 7–9 as run (production host, 2026-10-29).**
- **Step 7:**
  - The gate printed `FIREWALL OK (ufw)`: `Default: deny (incoming)`, no rule opens 5070 or the RTP range, and every port was free.
  - `command -v docker-init` found nothing, though `/usr/libexec/docker/docker-init` exists and `docker run --init` works. Step 7 now checks `docker info` and that path.
- **Step 8:** completed with no `STOP`. useradd warned about uid 1501 > `SYS_UID_MAX` (harmless).
- **Step 9 build:**
  - `real 8m16.972s` at `MAKE_JOBS=2`; the image is 272 MB.
  - The module check printed `Asterisk 22.11.0`.
  - Base digest `debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3`, now pinned in both `FROM` lines.
- **Runtime:**
  - The container reads `Up (healthy)`.
  - The registration reads `netgsm-reg/sip:sip5.netsantral.com … Registered (exp. 559s)`, so NetGSM grants more than the asked 120 s.
  - The contact is `Avail` (RTT about 49 ms), and the identify matches `185.88.7.227/32` only.
  - All 23 then-required modules were `Running`; the three added later are `res_pjsip_authenticator_digest`, `res_pjsip_nat` and `pbx_config`.
  - pids 51, memory about 40 MiB. ARI answered `{"build":…`.
- **Probes:**
  - From the host, `From:` `netgsm`, `102-8508407303` and `probe` each got `401 Unauthorized`.
  - NetGSM answered our OPTIONS with `200 OK`, so `qualify_frequency=20` stays (decided).
  - The outside probe from the dev machine is the coordinator's to run.
- **Sockets:** UDP 5070, TCP 127.0.0.1:8188, and the resolver's two ephemeral UDP sockets (explained in Step 9).
- **Journal:** 46 "error" lines, all benign.
  - Missing configs: pjsip_wizard, websocket_client, pjproject, chan_websocket, aeap, res_config_sqlite3, cli_aliases, calendar.
  - Modules that declined: res_stun_monitor, res_prometheus, res_pjsip_notify, res_parking, res_hep, res_calendar.
  - One "No such container" from `ExecStartPre`'s `docker rm -f` on the first start.
  - The repository now ships `chan_websocket.conf` (JSON control by default), `pjproject.conf` and `websocket_client.conf`. Step 11's explicit list drops the rest.
- **The pjproject 2.17 advisories (Security check above): option 1 for the test phase.** Mitigations:
  - the firewall gate (Step 7);
  - the hardened container (read-only, no capabilities, `no-new-privileges`, pids and memory limits);
  - the service is kept stopped (and disabled at boot) outside test windows until the B7/E-phase tests are done;
  - the image is rebuilt when Asterisk ships the pjproject fixes, before E2 points production at it.

- [ ] **Step 10: [COORDINATOR, server] One-way audio fallback (only if B7 shows it)**

```bash
ufw allow proto udp from 185.88.7.0/24 to any port 40000:40099 comment 'jeeta-voice RTP from NetGSM'
```

Not applied by default. Since 22.9.0, chan_websocket generates no silence ("chan_websocket: Remove silence generation and frame padding", ChangeLog-22.9.0), and `transmit_silence` covers only waits, not a bridged channel. The worker's pacer (B5, B6) therefore writes one frame every 20 ms from `MEDIA_START`, silence when nothing plays. So RTP leaves as soon as the media is up, and conntrack admits NetGSM's replies, as in Gate V1.

Apply this rule only if B7 still shows one-way audio. First confirm NetGSM's media network during a call, for example with `conntrack -L -p udp 2>/dev/null | grep -E 'port=400[0-9]{2}'` (addresses and ports only). `185.88.7.0/24` is not verified.

- [ ] **Step 11: [COORDINATOR, server, later] After the first working boot: an explicit module list**

Not before B7 passes. `autoload = yes` loads every module that was built, and a dozen of them log a missing config or decline at each start (Steps 7–9 as run). Asterisk 22's loader does not load an unlisted requirement on its own: a module whose `.requires` is not loaded is skipped ("missing dependencies"). So the list names the 26 required modules (`REQUIRED_MODULES` of `asterisk/test_configs.py`) and their whole dependency closure.

The closure comes from the 22.11.0 sources: each module's `AST_MODULE_INFO` `.requires`, and the module names in its `MODULEINFO` `<depend>`. It adds ten modules:
- `res_ari_model`: required by the `res_ari_*` resources.
- `res_pjproject`, `res_sorcery_astdb`, `res_sorcery_config`, `res_sorcery_memory`: required by res_pjsip.
- `res_pjsip_pubsub`: required by chan_pjsip.
- `res_stasis_answer`, `res_stasis_snoop`: required by res_ari_channels.
- `res_stasis_playback`, `res_stasis_recording`: required by res_ari_bridges.

`dnsmgr` and the other built-ins need no line. `res_pjsip_endpoint_identifier_user` is left out on purpose: with it gone, no From-username identification exists at all.

`modules.conf` becomes (a repository commit; the config test then asserts that every `REQUIRED_MODULES` entry has a `load` line):

```ini
[modules]
autoload = no
load => chan_websocket.so
load => chan_pjsip.so
load => res_pjsip.so
load => res_pjsip_session.so
load => res_pjsip_sdp_rtp.so
load => res_pjsip_outbound_registration.so
load => res_pjsip_outbound_authenticator_digest.so
load => res_pjsip_endpoint_identifier_ip.so
load => res_rtp_asterisk.so
load => res_http_websocket.so
load => res_websocket_client.so
load => res_ari.so
load => res_ari_asterisk.so
load => res_ari_channels.so
load => res_ari_bridges.so
load => res_ari_events.so
load => res_stasis.so
load => app_stasis.so
load => bridge_simple.so
load => bridge_softmix.so
load => res_timing_timerfd.so
load => codec_alaw.so
load => codec_ulaw.so
load => res_pjsip_authenticator_digest.so
load => res_pjsip_nat.so
load => pbx_config.so
load => res_ari_model.so
load => res_pjproject.so
load => res_pjsip_pubsub.so
load => res_sorcery_astdb.so
load => res_sorcery_config.so
load => res_sorcery_memory.so
load => res_stasis_answer.so
load => res_stasis_playback.so
load => res_stasis_recording.so
load => res_stasis_snoop.so
```

Before switching, record what runs (names and states only):

```bash
docker exec jeeta-asterisk asterisk -rx 'module show' | awk '/Running/ {print $1}' | sort > /root/jeeta-asterisk-modules.txt
wc -l /root/jeeta-asterisk-modules.txt
```

To deploy it:
1. Run Step 8's config install. The configs are mounted, so the image is not rebuilt.
2. Run `systemctl restart jeeta-asterisk`, then Step 9's checks. Expect no `NOT RUNNING` line, and a journal error count near 1 (the first start's `No such container`).
3. Repeat the identification probe (401 for every From user, `res_pjsip_authenticator_digest` being listed) and one more B7-style call.
4. If a module is missing, its error names it: add it with its reason, or go back to `autoload = yes`.

### Task B2: The speak service (EMA Lightning behind Antalia's normaliser)

**Files:**
- Create: `rust/bridge/voice/speech/speak/respell.py`, `respell.json`
- Create: `rust/bridge/voice/speech/speak/jeeta_speak.py`
- Create: `rust/bridge/voice/speech/speak/pins.py`, `weights.lock`
- Create: `rust/bridge/voice/speech/speak/requirements.txt`; `constraints.txt` and `wheels.sha256` (Step 7, from the server); `torch.lock` and `requirements.lock` (`python pins.py lock`, from `wheels.sha256`)
- Create: `rust/bridge/voice/speech/speak/Dockerfile`, `.dockerignore`
- Create: `rust/bridge/voice/speech/speak/tests/{test_speak_respell,test_speak_session,test_speak_mouth,test_speak_pins,test_speak_image,test_speak_models}.py` (named `test_speak_*` so that B3's `test_session.py` and `test_models.py` sit beside them in one pytest run)
- Create: `rust/bridge/voice/deploy/jeeta-voice-speak.service`
- Modify: `rust/bridge/voice/.gitignore` (`speech/*/pytest.ini`, copied in for an image build only)

**The service in brief** (the module docstring of `jeeta_speak.py` is the contract):
- One WebSocket per connection on `/run/jeeta-voice/speak.sock`. The server speaks first, `hello{voice_id, sample_rate: 8000, format: "pcm16le"}`; the voice id (12 hex) names everything that decides how a text sounds (package versions, weight digests, seed, threads, batch, the brand table, the sentence rules and `PIPELINE_VERSION`), and the worker keys its phrase cache by it (B5/B6). `python jeeta_speak.py --voice-id` prints it without loading the model.
- `synth{id, text}` → binary PCM16 LE 8 kHz frames (EMA's chunks: about 1 s first, then up to 4 s) → `done{id, synth_ms, audio_ms, first_ms}`. `cancel{id}` → `cancelled{id, synth_ms, audio_ms}`. `error{id|null, reason}` with `busy`, `bad_request` (also for a binary or malformed message), `too_long` (over 2 000 characters, or over 4 000 once normalised) or `failed`.
- Every frame of a synthesis precedes its terminal message (`done`, `cancelled` or `error`) and none follows it; a synthesis starts only after the previous one's terminal message. A cancel can lose the race to `done`, so a client drops frames until the terminal message for that id, whichever it is (B6 `draining`). One synthesis per connection: a second `synth` is refused `busy`, except after a `cancel`, when it waits for the cancelled one and then starts.
- Text: the brand table (`respell.json`), then `antalia_mini.Antalia.normalize`, then sentences (cut after `. ! ?` and a space, never after one of the worker's abbreviations, a piece under three words joined to the next), each one EMA stream (`sample_rate=8000`, seed 0) with 250 ms between. A one-sentence text is exactly the owner-tested path.
- EMA: batch 2 (what EMA measured for itself in the owner-tested image; fixed because its measurement writes `~/.cache`), one instance per concurrent synthesis (`SPEAK_WORKERS=2`), since an instance batches its streams and a batched stream's audio differs in its last bits from the same sentence alone.
- The start-up self-test (also run at build) reads, as EMA's model receives them, the clock ("14:00'e" → "on dörde", no "nokta", no "kesme"), each brand and every owner-approved text (`APPROVED_TEXTS`, held to the jt_calls defaults by a repository test).
- Logs: the root handler passes only `jeeta-speak` records (a library's is withheld and named), with lengths, timings and kinds; warnings and uncaught exceptions by kind and place. A watchdog ends the process when a chunk or the event loop is stuck over 60 s, so `Restart=always` recovers it.
- Pins: base image by digest; every package by version and sha256 from two hashed locks, one index each (`--require-hashes --no-deps`, then `pip check`), held by `pins.py check-lock` to the record of the first good build, the frozen owner-tested set and the requirements; EMA's two weight files by sha256 and size (EMA reads its repository's main and takes no revision), checked at build and at every start.
- Isolation: `--network none`, read-only, no capability, no core dumps, uid 1502 (`jeeta-voice-speak`) in gid 1501 (`jeeta-voice`), so the sticky `/run/jeeta-voice` keeps the listen service (uid 1501) from removing or replacing the socket; pids 128, 2 CPUs, 2 GB, no swap, `--pull never`.

- [ ] **Step 1: Write the failing tests**

`rust/bridge/voice/speech/speak/tests/test_speak_respell.py`:

```python
"""The brand respelling table and its matcher. Named test_speak_* so the listen service's tests
(B3: test_session.py, test_models.py) can sit beside these in one pytest run."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from respell import Respeller  # noqa: E402

TABLE = pathlib.Path(__file__).resolve().parents[1] / "respell.json"


def test_brands_are_respelled_with_their_suffixes_kept():
    r = Respeller({"Jeeta": "Cita", "WhatsApp": "vatsap"})
    assert r.apply("Jeeta'nın asistanıyım") == "Cita'nın asistanıyım"
    assert r.apply("WhatsApp'tan yazabilirsiniz") == "vatsap'tan yazabilirsiniz"
    assert r.apply("WhatsApp’tan yazabilirsiniz") == "vatsap’tan yazabilirsiniz"
    assert r.apply("jeeta ve whatsapp") == "Cita ve vatsap"
    assert r.apply("JEETA, Whatsapp!") == "Cita, vatsap!"


def test_words_that_merely_contain_a_brand_are_left_alone():
    r = Respeller({"Jeeta": "Cita", "Google": "gugıl"})
    assert r.apply("Jeetalar") == "Jeetalar"
    assert r.apply("jeetagrowth.com") == "jeetagrowth.com"
    assert r.apply("Googleda Jeeta2") == "Googleda Jeeta2"
    assert r.apply("SüperJeeta MyGoogle _Google") == "SüperJeeta MyGoogle _Google"


def test_the_four_turkish_i_letters_match_one_another():
    r = Respeller({"Instagram": "instagram", "TikTok": "tiktok"})
    assert r.apply("İnstagram'da") == "instagram'da"
    assert r.apply("INSTAGRAM ve TİKTOK") == "instagram ve tiktok"
    assert r.apply("ınstagram") == "instagram"
    assert r.apply("Inſtagram ve TiKTOK") == "instagram ve tiktok"  # long s, Kelvin sign


def test_one_pass_never_respells_a_replacement():
    r = Respeller({"Jeeta": "Google", "Google": "gugıl"})
    assert r.apply("Jeeta ve Google") == "Google ve gugıl"


def test_a_bad_table_is_refused():
    for table in ({"": "x"}, {"Jeeta": ""}, {" Jeeta": "Cita"}, {"Jeeta": 1}, ["Jeeta"]):
        with pytest.raises(ValueError):
            Respeller(table)
    with pytest.raises(ValueError):
        Respeller({"Jeeta": "Cita", "JEETA": "Cita"})
    assert Respeller({}).apply("Jeeta") == "Jeeta"


def test_the_shipped_table_is_the_owners():
    # Owner-given (2026-10-29). Each spelling was run through antalia-mini 1.0.1's normaliser and
    # normalizer-tr 0.8.1 (EMA's own frontend) and reached the model text unchanged; the image
    # checks it again at start (jeeta_speak.self_test). Pronunciation by ear is the owner's.
    table = Respeller.load(TABLE)
    assert table.table == {
        "Jeeta": "Cita",
        "WhatsApp": "vatsap",
        "Instagram": "instagram",
        "Facebook": "feysbuk",
        "TikTok": "tiktok",
        "Google": "gugıl",
    }
    assert table.apply("Merhaba, ben Jeeta'nın dijital asistanıyım.") == "Merhaba, ben Cita'nın dijital asistanıyım."
    assert table.apply("WhatsApp, Facebook, Instagram, TikTok ve Google'da varız.") == (
        "vatsap, feysbuk, instagram, tiktok ve gugıl'da varız."
    )
```

`rust/bridge/voice/speech/speak/tests/test_speak_session.py`:

```python
"""The speak protocol over a real WebSocket, served by the service's own server builder: TCP
loopback here, a unix socket in production (the unix tests run on Linux only)."""
import asyncio
import json
import logging
import os
import pathlib
import socket
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

import jeeta_speak  # noqa: E402
from jeeta_speak import MAX_MESSAGE_BYTES, MAX_TEXT_CHARS, TooLong, health, open_server, parse_endpoint, session  # noqa: E402

QUIET = logging.getLogger("test-client")
QUIET.setLevel(logging.WARNING)


class FakeMouth:
    """chunks(text) like the real mouth: here `n` chunks of one byte value per text, `delay` apart."""

    voice_id = "test-voice"

    def __init__(self, n=2, size=800, delay=0.0, tags=None):
        self.n, self.size, self.delay = n, size, delay
        self.tags = tags or {}
        self.closed = []

    def chunks(self, text):
        tag = self.tags.get(text, 1)
        try:
            for _ in range(self.n):
                if self.delay:
                    time.sleep(self.delay)
                yield bytes([tag, 0]) * self.size
        finally:
            self.closed.append(text)


def decode(msg):
    return msg if isinstance(msg, bytes) else json.loads(msg)


async def talk(mouth, script, until, settle=0.0):
    """Serves `mouth`, reads the hello, runs `script(ws)`, then collects every message until a text
    message whose (type, id) is in `until`, and for `settle` seconds more; returns them decoded."""
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, mouth, pool)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=QUIET) as ws:
                hello = json.loads(await ws.recv())
                assert hello == {"type": "hello", "voice_id": mouth.voice_id, "sample_rate": 8000,
                                 "format": "pcm16le"}
                got = []
                await script(ws)
                while True:
                    msg = decode(await asyncio.wait_for(ws.recv(), 10))
                    got.append(msg)
                    if isinstance(msg, dict) and (msg["type"], msg.get("id")) in until:
                        break
                deadline = time.monotonic() + settle
                while time.monotonic() < deadline:
                    try:
                        got.append(decode(await asyncio.wait_for(ws.recv(), deadline - time.monotonic())))
                    except asyncio.TimeoutError:
                        break
                return got
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def sending(*messages):
    async def script(ws):
        for m in messages:
            await ws.send(m if isinstance(m, (str, bytes)) else json.dumps(m))

    return script


def texts(got):
    return [m for m in got if isinstance(m, dict)]


def kinds(got):
    return [(m["type"], m["id"]) if isinstance(m, dict) else m[0] for m in got]


def test_synth_streams_pcm_then_done():
    mouth = FakeMouth(n=2, size=800)
    got = asyncio.run(talk(mouth, sending({"type": "synth", "id": "a:0", "text": "Merhaba."}), {("done", "a:0")}))
    assert got[0] == b"\x01\x00" * 800 and got[1] == b"\x01\x00" * 800
    done = got[2]
    assert done["id"] == "a:0" and done["audio_ms"] == 200
    assert isinstance(done["synth_ms"], int) and isinstance(done["first_ms"], int)


def test_a_second_synth_while_busy_is_refused():
    mouth = FakeMouth(n=3, size=8000, delay=0.05)
    got = asyncio.run(
        talk(
            mouth,
            sending({"type": "synth", "id": "a:0", "text": "Bir."}, {"type": "synth", "id": "a:1", "text": "İki."}),
            {("done", "a:0")},
        )
    )
    assert {"type": "error", "id": "a:1", "reason": "busy"} in texts(got)
    assert len([m for m in got if isinstance(m, bytes)]) == 3


def test_a_cancel_stops_between_chunks_and_nothing_follows_it():
    mouth = FakeMouth(n=100, size=160, delay=0.02)

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Uzun bir cümle."}))
        assert isinstance(await ws.recv(), bytes)
        await ws.send(json.dumps({"type": "cancel", "id": "a:0"}))

    got = asyncio.run(talk(mouth, script, {("cancelled", "a:0")}, settle=0.5))
    at = got.index(next(m for m in got if isinstance(m, dict)))
    assert got[at]["type"] == "cancelled" and got[at]["id"] == "a:0"
    assert got[at + 1:] == [], "nothing after the terminal message"
    assert len([m for m in got if isinstance(m, bytes)]) < 50
    assert mouth.closed == ["Uzun bir cümle."]


def test_a_synth_after_a_cancel_waits_for_the_cancelled_one_instead_of_busy():
    mouth = FakeMouth(n=20, size=160, delay=0.03, tags={"Bir.": 1, "İki.": 2})

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
        assert await ws.recv() == bytes([1, 0]) * 160
        await ws.send(json.dumps({"type": "cancel", "id": "a:0"}))
        await ws.send(json.dumps({"type": "synth", "id": "a:1", "text": "İki."}))

    got = kinds(asyncio.run(talk(mouth, script, {("done", "a:1")})))
    assert ("error", "a:1") not in got
    cut = got.index(("cancelled", "a:0"))
    assert all(k == 1 for k in got[:cut])
    assert got[cut + 1:-1] == [2] * 20 and got[-1] == ("done", "a:1")


def test_a_queued_synth_can_be_cancelled_and_a_third_then_runs():
    mouth = FakeMouth(n=10, size=160, delay=0.03, tags={"Bir.": 1, "İki.": 2, "Üç.": 3})

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
        assert await ws.recv() == bytes([1, 0]) * 160
        for m in [{"type": "cancel", "id": "a:0"}, {"type": "synth", "id": "a:1", "text": "İki."},
                  {"type": "cancel", "id": "a:1"}, {"type": "synth", "id": "a:2", "text": "Üç."}]:
            await ws.send(json.dumps(m))

    got = kinds(asyncio.run(talk(mouth, script, {("done", "a:2")})))
    a0, a1 = got.index(("cancelled", "a:0")), got.index(("cancelled", "a:1"))
    assert a0 < a1 and all(k == 1 for k in got[:a0]) and got[a0 + 1:a1] == []
    assert got[a1 + 1:] == [3] * 10 + [("done", "a:2")]
    assert 2 not in got, "the cancelled queued synthesis never ran"
    assert "İki." not in mouth.closed


def test_a_cancel_that_loses_the_race_to_the_end_is_ignored():
    mouth = FakeMouth(n=1)

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
        assert isinstance(await ws.recv(), bytes)
        assert json.loads(await ws.recv())["type"] == "done"
        await ws.send(json.dumps({"type": "cancel", "id": "a:0"}))
        await ws.send(json.dumps({"type": "synth", "id": "a:1", "text": "İki."}))

    got = asyncio.run(talk(mouth, script, {("done", "a:1")}, settle=0.3))
    assert [m["type"] for m in texts(got)] == ["done"], "no cancelled for a synthesis that had ended"


def test_a_cancel_for_another_id_is_ignored():
    mouth = FakeMouth(n=2)
    got = asyncio.run(
        talk(
            mouth,
            sending(
                {"type": "cancel", "id": "x:9"},
                {"type": "synth", "id": "a:0", "text": "Bir."},
                {"type": "cancel", "id": "x:9"},
            ),
            {("done", "a:0")},
        )
    )
    assert [m["type"] for m in texts(got)] == ["done"]


def test_bad_requests_are_answered_and_the_connection_stays_usable():
    mouth = FakeMouth(n=1)
    got = asyncio.run(
        talk(
            mouth,
            sending(
                "{not json",
                "[1, 2]",
                "[" * 100_000,
                b"\x00\x01",
                {"type": "synth", "text": "Kimliksiz."},
                {"type": "synth", "id": "a:0"},
                {"type": "speak", "id": "a:1"},
                {"type": "synth", "id": "a:2", "text": "x" * (MAX_TEXT_CHARS + 1)},
                {"type": "synth", "id": "a:3", "text": "Sonunda."},
            ),
            {("done", "a:3")},
        )
    )
    assert texts(got)[:8] == [
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": "a:0", "reason": "bad_request"},
        {"type": "error", "id": "a:1", "reason": "bad_request"},
        {"type": "error", "id": "a:2", "reason": "too_long"},
    ]
    assert texts(got)[8]["type"] == "done"


def test_a_text_too_long_once_normalised_is_refused_too_long():
    class Swelling(FakeMouth):
        def chunks(self, text):
            raise TooLong()
            yield  # a generator, like the real mouth

    got = asyncio.run(talk(Swelling(), sending({"type": "synth", "id": "a:0", "text": "9" * 1500}), {("error", "a:0")}))
    assert texts(got) == [{"type": "error", "id": "a:0", "reason": "too_long"}]


def test_a_message_over_the_size_limit_closes_with_1009_only_that_connection():
    async def run():
        pool = ThreadPoolExecutor(max_workers=1)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, FakeMouth(n=1), pool)) as server:
            port = server.sockets[0].getsockname()[1]
            url = f"ws://127.0.0.1:{port}"
            async with websockets.connect(url, logger=QUIET, max_size=None) as ws:
                await ws.recv()
                await ws.send("x" * (MAX_MESSAGE_BYTES + 1))
                with pytest.raises(ConnectionClosed) as closed:
                    await asyncio.wait_for(ws.recv(), 5)
                code = closed.value.rcvd.code
            async with websockets.connect(url, logger=QUIET) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
                await ws.recv()
                done = json.loads(await ws.recv())
        return code, done

    code, done = asyncio.run(run())
    assert code == 1009 and done["type"] == "done"


def test_the_server_never_compresses_and_never_pings():
    assert jeeta_speak.SERVER_OPTIONS["compression"] is None
    assert jeeta_speak.SERVER_OPTIONS["ping_interval"] is None

    async def run():
        pool = ThreadPoolExecutor(max_workers=1)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, FakeMouth(), pool)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=QUIET, compression="deflate") as ws:
                await ws.recv()
                return ws.response.headers.get("Sec-WebSocket-Extensions")

    assert asyncio.run(run()) is None, "the client offered permessage-deflate and the server declined"


def test_a_failed_synthesis_reports_its_kind_and_the_next_one_runs():
    class Flaky(FakeMouth):
        def chunks(self, text):
            if text == "Kötü.":
                raise RuntimeError("Ayşe Yılmaz 0532 111 22 33")
            return super().chunks(text)

    async def again(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Kötü."}))
        assert json.loads(await ws.recv()) == {"type": "error", "id": "a:0", "reason": "failed"}
        await ws.send(json.dumps({"type": "synth", "id": "a:1", "text": "İyi."}))

    got = asyncio.run(talk(Flaky(n=1), again, {("done", "a:1")}))
    assert got[-1]["type"] == "done"


def test_the_log_never_carries_the_text(caplog):
    caplog.set_level(logging.DEBUG)
    logging.getLogger("jeeta-speak").setLevel(logging.DEBUG)
    secret = "Ayşe Yılmaz, 0532 111 22 33, Bağdat Caddesi"

    class Failing(FakeMouth):
        def chunks(self, text):
            if text.startswith("x"):
                raise ValueError(secret)
            return super().chunks(text)

    try:
        asyncio.run(talk(Failing(n=2), sending({"type": "synth", "id": "a:0", "text": secret}), {("done", "a:0")}))
        asyncio.run(talk(Failing(n=1), sending("{" + secret), {("error", None)}))
        asyncio.run(talk(Failing(n=1), sending({"type": "synth", "id": "a:2", "text": "x" + secret}), {("error", "a:2")}))
        asyncio.run(
            talk(
                Failing(n=20, delay=0.02),
                sending({"type": "synth", "id": "a:3", "text": secret}, {"type": "synth", "id": "a:4", "text": secret}),
                {("error", "a:4")},
            )
        )
    finally:
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
    assert "done:" in caplog.text and "chars" in caplog.text and "busy" in caplog.text
    for word in ("Ayşe", "Yılmaz", "0532", "Bağdat"):
        assert word not in caplog.text


def test_endpoints():
    assert parse_endpoint("unix:/run/jeeta-voice/speak.sock") == ("unix", "/run/jeeta-voice/speak.sock")
    assert parse_endpoint("/run/jeeta-voice/speak.sock") == ("unix", "/run/jeeta-voice/speak.sock")
    assert parse_endpoint("tcp:127.0.0.1:9000") == ("tcp", "127.0.0.1", 9000)
    assert parse_endpoint("tcp:[::1]:9000") == ("tcp", "::1", 9000)
    for bad in ("tcp:0.0.0.0:9000", "tcp:10.0.0.5:9000", "tcp:example.com:80", "tcp:127.0.0.1:x",
                "tcp:127.0.0.1:70000", "speak.sock", "unix:speak.sock"):
        with pytest.raises(ValueError):
            parse_endpoint(bad)


def test_the_health_check_answers_only_when_the_service_does():
    async def run():
        pool = ThreadPoolExecutor(max_workers=1)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, FakeMouth(), pool)) as server:
            port = server.sockets[0].getsockname()[1]
            return await asyncio.to_thread(health, ("tcp", "127.0.0.1", port)), port

    up, port = asyncio.run(run())
    assert up == 0
    assert health(("tcp", "127.0.0.1", port)) == 1


def test_main_health_voice_id_and_a_bad_socket(monkeypatch, capsys):
    async def serve():
        pool = ThreadPoolExecutor(max_workers=1)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, FakeMouth(), pool)) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setenv("SPEAK_SOCKET", f"tcp:127.0.0.1:{port}")
            return await asyncio.to_thread(jeeta_speak.main, ["--health"])

    assert asyncio.run(serve()) == 0
    assert jeeta_speak.main(["--health"]) == 1  # nothing listens there any more
    monkeypatch.setenv("SPEAK_SOCKET", "tcp:0.0.0.0:9")
    with pytest.raises(SystemExit, match="SPEAK_SOCKET"):
        jeeta_speak.main(["--health"])
    monkeypatch.delenv("SPEAK_SOCKET")
    assert jeeta_speak.main(["--voice-id"]) == 0
    printed = capsys.readouterr().out.strip()
    assert len(printed) == 12 and int(printed, 16) >= 0
    monkeypatch.setenv("SPEAK_BATCH", "1")
    assert jeeta_speak.main(["--voice-id"]) == 0
    assert capsys.readouterr().out.strip() != printed, "the batch size is part of the voice"


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_the_unix_socket_is_the_groups_and_a_stale_one_is_replaced():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "speak.sock")
        stale = socket.socket(socket.AF_UNIX)
        stale.bind(path)
        stale.close()

        async def run():
            pool = ThreadPoolExecutor(max_workers=1)
            async with open_server(("unix", path), lambda ws: session(ws, FakeMouth(n=1), pool)):
                mode = os.stat(path).st_mode & 0o777
                async with websockets.unix_connect(path, logger=QUIET) as ws:
                    hello = json.loads(await ws.recv())
                    await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
                    first = await ws.recv()
                    done = json.loads(await ws.recv())
                healthy = await asyncio.to_thread(health, ("unix", path))
            return mode, hello, first, done, healthy

        mode, hello, first, done, healthy = asyncio.run(run())
        assert mode == 0o660
        assert hello["voice_id"] == "test-voice"
        assert first == b"\x01\x00" * 800 and done["type"] == "done"
        assert healthy == 0
        assert not os.path.exists(path), "the socket is removed when the service stops"


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_the_socket_is_born_0660_before_any_chmod(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "speak.sock")
        monkeypatch.setattr(os, "chmod", lambda *a, **k: None)

        async def run():
            async with open_server(("unix", path), lambda ws: None):
                return os.stat(path).st_mode & 0o777

        assert asyncio.run(run()) == 0o660


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_a_regular_file_in_the_sockets_place_is_never_deleted():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "speak.sock")
        pathlib.Path(path).write_text("not a socket", encoding="utf-8")

        async def run():
            async with open_server(("unix", path), lambda ws: None):
                pass

        with pytest.raises(SystemExit):
            asyncio.run(run())
        assert pathlib.Path(path).read_text(encoding="utf-8") == "not a socket"


class PooledMouth:
    """Like the real mouth: a VoicePool, and chunks(text, tts) noting which instance served whom."""

    voice_id = "test-voice"

    def __init__(self, voices):
        self.voice_pool = jeeta_speak.VoicePool(voices)
        self.served = []
        self.busy = set()
        self.overlap = []

    def chunks(self, text, tts):
        self.served.append((text, tts))
        if tts in self.busy:
            self.overlap.append(tts)
        self.busy.add(tts)
        try:
            for _ in range(5):
                time.sleep(0.02)
                yield b"\x01\x00" * 80
        finally:
            self.busy.discard(tts)


def test_each_synthesis_has_an_ema_instance_of_its_own():
    async def run(mouth):
        pool = ThreadPoolExecutor(max_workers=4)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, mouth, pool)) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"

            async def one(n):
                async with websockets.connect(url, logger=QUIET) as ws:
                    await ws.recv()
                    for k in range(3):
                        await ws.send(json.dumps({"type": "synth", "id": f"{n}:{k}", "text": f"{n}"}))
                        while not isinstance(m := await ws.recv(), str):
                            pass
                        assert json.loads(m)["type"] == "done"

            await asyncio.gather(*(one(n) for n in range(3)))

    two = PooledMouth(["A", "B"])
    asyncio.run(run(two))
    assert two.overlap == [], "no instance served two syntheses at once"
    assert {tts for _, tts in two.served} == {"A", "B"} and len(two.served) == 9
    asyncio.run(run(two))  # a second event loop: the pool follows it
    one_voice = PooledMouth(["A"])
    asyncio.run(run(one_voice))
    assert one_voice.overlap == [] and len(one_voice.served) == 9
```

`rust/bridge/voice/speech/speak/tests/test_speak_mouth.py`:

```python
"""The mouth around EMA, with fakes: respelling then normalising, sentences, PCM16 framing, the
batch size, the start-up self-test, the voice id, the watchdog and the logging rules. No model, no
torch."""
import asyncio
import io
import logging
import pathlib
import sys
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import jeeta_speak  # noqa: E402
from jeeta_speak import (  # noqa: E402
    APPROVED_TEXTS, SENTENCE_GAP, Mouth, TooLong, Watchdog, env_int, self_test, set_batch, split_sentences,
    to_pcm16,
)
from respell import Respeller  # noqa: E402

FOLD = str.maketrans("âîûÂÎÛ", "aiuAIU")


def ema_like(text):
    """EMA's frontend on Antalia's readings, as far as the approved texts need: the circumflex
    folded (ema_lightning/frontend.py's alphabet), everything else kept."""
    return text.translate(FOLD)


class FakeTTS:
    """EMA's surface as the mouth uses it: stream(text, sample_rate, seed), _frontend, _batch_size."""

    def __init__(self, chunks=None, frontend=ema_like):
        self.calls = []
        self.closed = []
        self.chunks = chunks if chunks is not None else [np.array([0.5, -0.25], dtype=np.float32)]
        self._frontend = frontend
        self._batch_size = None

    def stream(self, text, sample_rate, seed):
        self.calls.append((text, sample_rate, seed))
        try:
            for c in self.chunks:
                yield c
        finally:
            self.closed.append(text)


def lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def good_normalizer(text):
    return lower(text.replace("14:00'e", "on dörde"))


def mouth(tts=None, normalize=good_normalizer, table=None, residue=None):
    table = table if table is not None else {"Jeeta": "Cita"}
    return Mouth(Respeller(table), normalize, tts or FakeTTS(), seed=0, residue=residue)


def test_text_is_respelled_before_it_is_normalised():
    m = mouth()
    assert m.spoken("Jeeta'nın asistanıyım.") == "cita'nın asistanıyım."


def test_one_sentence_is_one_stream_of_the_normalised_text_at_8k_with_the_fixed_seed():
    tts = FakeTTS()
    m = Mouth(Respeller({"Jeeta": "Cita"}), good_normalizer, tts, seed=7)
    pcm = b"".join(m.chunks("Merhaba, ben Jeeta'nın dijital asistanıyım."))
    assert tts.calls == [("merhaba, ben cita'nın dijital asistanıyım.", 8000, 7)]
    assert pcm == to_pcm16([0.5, -0.25])


def test_sentences_are_streamed_one_by_one_with_a_quarter_second_between():
    tts = FakeTTS()
    pcm = b"".join(mouth(tts).chunks("Yarın sizi arayacağız. Size uygun mu acaba?"))
    assert [c[0] for c in tts.calls] == ["yarın sizi arayacağız.", "size uygun mu acaba?"]
    one = to_pcm16([0.5, -0.25])
    assert pcm == one + SENTENCE_GAP + one
    assert len(SENTENCE_GAP) == 2 * 2000


def test_samples_become_pcm16_little_endian_rounded_clipped_and_finite():
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # no "invalid value encountered in cast": NaN never reaches the cast
        pcm = to_pcm16(np.array([0.5, -1.5, 1.0, 0.0, -0.5, np.nan, np.inf, -np.inf], dtype=np.float32))
    assert np.frombuffer(pcm, dtype="<i2").tolist() == [16384, -32767, 32767, 0, -16384, 0, 32767, -32767]
    assert to_pcm16(np.zeros(0, dtype=np.float32)) == b""


def test_closing_the_chunks_closes_emas_stream():
    tts = FakeTTS(chunks=[np.zeros(80, dtype=np.float32)] * 5)
    gen = mouth(tts).chunks("Bir iki üç dört.")
    next(gen)
    gen.close()
    assert tts.closed == ["bir iki üç dört."]


def test_empty_or_unspeakable_text_gives_no_audio():
    tts = FakeTTS()
    assert list(mouth(tts, normalize=lambda t: "").chunks("☕")) == []
    assert tts.calls == []


def test_a_text_that_swells_past_the_cap_once_normalised_is_refused():
    m = mouth(normalize=lambda t: "dokuz " * 1000)
    with pytest.raises(TooLong):
        list(m.chunks("9" * 1000))


def test_symbols_the_normaliser_left_unread_are_counted_without_the_text(caplog):
    caplog.set_level(logging.WARNING)
    m = mouth(residue=lambda t: len(jeeta_speak.RESIDUE.findall(t)))
    m.spoken("Ayşe 0532 #1 %5 a/b c+d 9:30")
    assert m.residual_symbols == 9 + 4 + 1  # nine digits, # % / +, and the clock's colon
    assert "symbols unread" in caplog.text and "Ayşe" not in caplog.text and "0532" not in caplog.text
    assert jeeta_speak.RESIDUE.findall("Mahalle: Atatürk") == [], "a colon between words is punctuation"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "doktor ahmet bey yarın on otuzda sizi arayacak. profesör doktor ayşe hanım da katılacak.",
            ["doktor ahmet bey yarın on otuzda sizi arayacak.", "profesör doktor ayşe hanım da katılacak."],
        ),
        ("evet. tamam. yarın görüşürüz.", ["evet. tamam. yarın görüşürüz."]),
        ("saat dokuzda mı, dokuz otuzda mı?", ["saat dokuzda mı, dokuz otuzda mı?"]),
        (
            "fiyat bin iki yüz doksan dokuz lira. kampanya üç kasıma kadar sürüyor... ne dersiniz?",
            ["fiyat bin iki yüz doksan dokuz lira.", "kampanya üç kasıma kadar sürüyor... ne dersiniz?"],
        ),
        ("harika! yarın sizi arayacağız.", ["harika! yarın sizi arayacağız."]),
        ("bir iki üç dört! beş altı yedi sekiz.", ["bir iki üç dört!", "beş altı yedi sekiz."]),
        # antalia-mini 1.0.1 leaves a lowercase "sn.", "tel." and "st." as written (2026-10-29)
        ("sayın müşterimiz sn. ahmet yılmaz sizi arıyoruz.", ["sayın müşterimiz sn. ahmet yılmaz sizi arıyoruz."]),
        ("bize her gün tel. sıfır beş yüz otuz iki ile ulaşın.", ["bize her gün tel. sıfır beş yüz otuz iki ile ulaşın."]),
        ("dükkanımız çarşı st. yanında, sizi bekliyoruz.", ["dükkanımız çarşı st. yanında, sizi bekliyoruz."]),
        ("  ", []),
    ],
)
def test_sentences_of_a_normalised_text(text, expected):
    # The inputs are antalia-mini 1.0.1's readings of the written sentences (dates, prices, times
    # and abbreviations already words), as produced on 2026-10-29.
    assert split_sentences(text) == expected


def test_no_cut_after_any_of_the_workers_abbreviations():
    for word in jeeta_speak.ABBREVIATIONS:
        text = f"bunu yarın {word}. ahmet yılmaz ile konuşacağız."
        assert split_sentences(text) == [text], word


def test_the_batch_size_is_fixed_on_emas_attribute():
    tts = FakeTTS()
    set_batch(tts, 2)
    assert tts._batch_size == 2

    class Changed:
        pass

    with pytest.raises(SystemExit):
        set_batch(Changed(), 2)


def test_knobs_are_read_strictly(monkeypatch):
    monkeypatch.setenv("SPEAK_X", "7")
    assert env_int("SPEAK_X", 1, 1, 9) == 7
    assert env_int("SPEAK_UNSET", 3, 1, 9) == 3
    for bad in ("x", "", "0", "10", "1.5"):
        monkeypatch.setenv("SPEAK_X", bad)
        with pytest.raises(SystemExit):
            env_int("SPEAK_X", 1, 1, 9)


def test_the_self_test_passes_on_the_owners_readings():
    self_test(mouth(table={"Jeeta": "Cita", "Google": "gugıl", "Instagram": "instagram"}))


def test_the_self_test_refuses_normalizer_tr_s_reading_of_the_clock():
    def normalizer_tr(text):
        return lower(text.replace("14:00'e", "on dört iki nokta sıfır sıfır kesme e"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=normalizer_tr))

    def half_right(text):
        return lower(text.replace("14:00'e", "on dörde iki nokta sıfır sıfır"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=half_right))

    def apostrophe_read(text):
        return lower(text.replace("14:00'e", "on dörde kesme e"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=apostrophe_read))


def test_the_self_test_refuses_a_spelling_the_model_does_not_receive():
    with pytest.raises(SystemExit, match="Google"):
        self_test(mouth(tts=FakeTTS(frontend=lambda t: ema_like(t).replace("gugıl", "g")), table={"Google": "gugıl"}))


def test_the_self_test_refuses_a_frontend_that_changes_an_approved_text():
    def drops_apostrophes(t):
        return ema_like(t).replace("'", " ")

    with pytest.raises(SystemExit, match="approved-text self-test failed: text 0"):
        self_test(mouth(tts=FakeTTS(frontend=drops_apostrophes)))

    def reads_kesme(t):
        return ema_like(t).replace("cita'nın", "cita kesme nın")

    with pytest.raises(SystemExit, match="approved-text"):
        self_test(mouth(tts=FakeTTS(frontend=reads_kesme)))


def test_the_self_test_needs_to_see_what_the_model_reads():
    with pytest.raises(SystemExit):
        self_test(mouth(tts=FakeTTS(frontend=None)))


def test_the_approved_texts_are_the_policys():
    # The defaults of jt_calls (opening.rs, phrases.rs) with "Jeeta" as the workspace; the
    # repository test test_speak_image.py checks each against the Rust source.
    assert len(APPROVED_TEXTS) == 14 and APPROVED_TEXTS[0] == "Merhaba, ben Jeeta'nın dijital asistanıyım."


def test_the_voice_id_follows_every_knob_the_table_and_the_rules(monkeypatch):
    knobs = {"seed": 0, "threads": 2, "batch": 2}
    base = jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Cita"})
    assert base == jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, dict(knobs),
                                                 {"Jeeta": "Cita"})
    for change in ({"seed": 1}, {"threads": 1}, {"batch": 1}):
        assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"},
                                                     {**knobs, **change}, {"Jeeta": "Cita"}), change
    assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Ciita"})
    assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.3"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Cita"})
    for name, value in (("MIN_SENTENCE_WORDS", 4), ("SENTENCE_GAP_MS", 300), ("PIPELINE_VERSION", 2),
                        ("ABBREVIATIONS", frozenset({"dr"}))):
        monkeypatch.setattr(jeeta_speak, name, value)
        assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs,
                                                     {"Jeeta": "Cita"}), name
        monkeypatch.undo()


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_the_watchdog_ends_a_stuck_synthesis_or_a_stalled_loop():
    clock, exits = Clock(), []
    dog = Watchdog(60, clock=clock, exit=exits.append)
    token = dog.begin()
    clock.t = 59
    dog.heartbeat()
    assert not dog.check() and exits == []
    dog.end(token)
    clock.t = 200
    dog.heartbeat()
    assert not dog.check(), "an ended wait does not count"
    dog.begin()
    clock.t = 261
    dog.heartbeat()
    assert dog.check() and exits == [70]

    clock, exits = Clock(), []
    dog = Watchdog(60, clock=clock, exit=exits.append)
    clock.t = 61
    assert dog.check() and exits == [70], "no heartbeat from the loop for over a minute"


def test_the_watchdog_brackets_each_chunk_wait(monkeypatch):
    seen = []

    class Recording(Watchdog):
        def begin(self):
            seen.append("begin")
            return super().begin()

        def end(self, token):
            seen.append("end")
            super().end(token)

    monkeypatch.setattr(jeeta_speak, "_watchdog", Recording(60))

    async def one():
        loop = asyncio.get_running_loop()
        return await jeeta_speak._next_chunk(loop, ThreadPoolExecutor(1), iter([b"x"]))

    chunk = asyncio.run(one())
    assert chunk == b"x" and seen == ["begin", "end"]


def test_only_the_services_records_reach_its_log(capsys):
    handler = jeeta_speak.configure_logging("info")
    stream = io.StringIO()
    handler.setStream(stream)
    hooks = sys.excepthook, threading.excepthook, warnings.showwarning
    try:
        logging.getLogger("jeeta-speak").info("listening")
        logging.getLogger("antalia_mini").warning("text normaliser failed (Ayşe Yılmaz 0532)")
        jeeta_speak.WS_LOG.error("connection handler failed: Ayşe")
        logging.getLogger("torch").info("anything")
        with warnings.catch_warnings():
            warnings.simplefilter("always")
            warnings.showwarning = jeeta_speak._quiet_warning
            warnings.warn("text normaliser failed (KeyError: 'Ayşe 0532 111 22 33')", RuntimeWarning, stacklevel=1)
        try:
            raise ValueError("Ayşe Yılmaz 0532")
        except ValueError:
            jeeta_speak._quiet_exception(*sys.exc_info())
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
        sys.excepthook, threading.excepthook, warnings.showwarning = hooks
    out = stream.getvalue()
    assert "INFO jeeta-speak listening" in out
    assert "withheld a record (WARNING) from antalia_mini" in out
    assert "withheld a record (ERROR) from speak.websocket" in out
    assert "RuntimeWarning at" in out and "uncaught ValueError at test_speak_mouth.py:" in out
    assert "torch" not in out
    assert "Ayşe" not in out and "0532" not in out and "Yılmaz" not in out
```

`rust/bridge/voice/speech/speak/tests/test_speak_pins.py`:

```python
"""The image's pins: the weights by SHA-256 (with a fake cache), the wheel record, the shipped lock."""
import hashlib
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pins  # noqa: E402


def cache(tmp_path, contents):
    paths = {}
    for name, data in contents.items():
        path = tmp_path / name
        path.write_bytes(data)
        paths[name] = path
    return lambda name: paths.get(name)


def lock_of(contents):
    return {
        "repo": pins.REPO,
        "files": {n: {"sha256": hashlib.sha256(d).hexdigest(), "size": len(d)} for n, d in contents.items()},
    }


WEIGHTS = {"ema.pt": b"acoustic", "decoder.pt": b"vocoder!"}


def test_the_pinned_weights_pass(tmp_path):
    digests = pins.verify(lock_of(WEIGHTS), cache(tmp_path, WEIGHTS))
    assert digests == {n: hashlib.sha256(d).hexdigest() for n, d in WEIGHTS.items()}


def test_a_changed_missing_or_resized_weight_is_refused(tmp_path):
    lock = lock_of(WEIGHTS)
    with pytest.raises(pins.PinError, match="ema.pt: sha256"):
        pins.verify(lock, cache(tmp_path, {**WEIGHTS, "ema.pt": b"acoustiK"}))
    with pytest.raises(pins.PinError, match="decoder.pt: not in"):
        pins.verify(lock, cache(tmp_path, {"ema.pt": WEIGHTS["ema.pt"]}))
    with pytest.raises(pins.PinError, match="ema.pt: size"):
        pins.verify(lock, cache(tmp_path, {**WEIGHTS, "ema.pt": b"acoustic+"}))


def test_record_writes_a_lock_that_verifies(tmp_path):
    located = cache(tmp_path, WEIGHTS)
    recorded = pins.record(located)
    assert recorded == lock_of(WEIGHTS)
    path = tmp_path / "weights.lock"
    path.write_text(json.dumps(recorded), encoding="utf-8")
    pins.verify(pins.load_lock(path), located)


def test_a_lock_without_both_digests_is_refused(tmp_path):
    good = lock_of(WEIGHTS)
    bad = [
        {**good, "repo": "someone/else"},
        {**good, "files": {"ema.pt": good["files"]["ema.pt"]}},
        {**good, "files": {**good["files"], "ema.pt": {"sha256": "abc", "size": 8}}},
        {**good, "files": {**good["files"], "ema.pt": {"sha256": "0" * 64, "size": 0}}},
    ]
    for lock in bad:
        path = tmp_path / "weights.lock"
        path.write_text(json.dumps(lock), encoding="utf-8")
        with pytest.raises(pins.PinError):
            pins.load_lock(path)


def test_the_shipped_lock_pins_both_files_emas_loader_reads():
    lock = pins.load_lock()
    assert sorted(lock["files"]) == ["decoder.pt", "ema.pt"]


REPORT = {
    "install": [
        {
            "metadata": {"name": "Ema_Lightning", "version": "1.1.2"},
            "download_info": {"url": "https://files/x.whl", "archive_info": {"hashes": {"sha256": "a" * 64}}},
        },
        {
            "metadata": {"name": "torch", "version": "2.15.0+cpu"},
            "download_info": {"url": "https://download/t.whl", "archive_info": {"hash": "sha256=" + "b" * 64}},
        },
        {"metadata": {"name": "local.thing", "version": "0.1"}, "download_info": {"url": "file:///x", "dir_info": {}}},
    ]
}


def test_the_wheel_record_is_one_sorted_line_per_install():
    assert pins.wheels(REPORT) == [
        "ema-lightning==1.1.2 sha256=" + "a" * 64,
        "local-thing==0.1 sha256=?",
        "torch==2.15.0+cpu sha256=" + "b" * 64,
    ]


def test_a_build_whose_wheels_differ_from_the_record_or_lack_a_hash_fails(tmp_path, capsys):
    known = {"install": REPORT["install"][:2]}
    first, second = tmp_path / "torch.json", tmp_path / "pypi.json"
    first.write_text(json.dumps({"install": known["install"][1:]}), encoding="utf-8")
    second.write_text(json.dumps({"install": known["install"][:1]}), encoding="utf-8")
    expect = tmp_path / "wheels.sha256"
    expect.write_text("# a comment\n" + "\n".join(pins.wheels(known)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 0
    assert capsys.readouterr().out.splitlines()[1:] == pins.wheels(known)
    expect.write_text("ema-lightning==1.1.2 sha256=" + "c" * 64 + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 1
    assert "ema-lightning" in capsys.readouterr().err
    expect.write_text("# nothing recorded\n", encoding="utf-8")
    assert pins.main(["wheels", str(first), str(second), "--expect", str(expect)]) == 1
    unknown = tmp_path / "unknown.json"
    unknown.write_text(json.dumps(REPORT), encoding="utf-8")
    expect.write_text("\n".join(pins.wheels(REPORT)) + "\n", encoding="utf-8")
    assert pins.main(["wheels", str(unknown), "--expect", str(expect)]) == 1
    assert "without a known sha256" in capsys.readouterr().err


SPEAK = pathlib.Path(__file__).resolve().parents[1]


def test_the_shipped_locks_are_the_record_the_frozen_set_and_the_requirements():
    locked = pins.check_lock()
    assert locked["ema-lightning"][0] == "1.1.2" and locked["torch"][0].endswith("+cpu")
    torch, rest = pins.lock_files(pins.read_record((SPEAK / "wheels.sha256").read_text(encoding="utf-8"), "w"))
    assert (SPEAK / "torch.lock").read_text(encoding="utf-8") == torch
    assert (SPEAK / "requirements.lock").read_text(encoding="utf-8") == rest, "run `python pins.py lock`"


def copy_pins(tmp_path):
    tmp_path.mkdir(parents=True)
    for name in ("constraints.txt", "requirements.txt", "wheels.sha256", "torch.lock", "requirements.lock"):
        (tmp_path / name).write_text((SPEAK / name).read_text(encoding="utf-8"), encoding="utf-8")
    return tmp_path


def edit(path, old, new):
    text = path.read_text(encoding="utf-8")
    assert old in text, old
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_check_lock_refuses_every_drift(tmp_path):
    cases = [
        ("constraints.txt", "ema-lightning==1.1.2", "ema-lightning==1.1.3", "owner's choice"),
        ("constraints.txt", "antalia-mini==1.0.1", "Antalia_Mini==1.0.2", "owner's choice"),
        ("constraints.txt", "torch==2.15.0+cpu", "torch==2.15.0", "CPU build"),
        ("constraints.txt", "numpy==2.5.4", "numpy==2.5.3", "numpy==2.5.3"),
        ("constraints.txt", "zipp==4.1.2\n", "zipp==4.1.2\nleftpad==1.0\n", "leftpad"),
        ("requirements.txt", "websockets==17.3", "websockets==18.0", "websockets==18.0"),
        ("requirements.txt", "antalia-mini==1.0.1", "antalia-mini", "requirements.txt must pin antalia-mini"),
        ("requirements.txt", "huggingface-hub", "huggingface-hub\nrequests", "requests"),
        ("requirements.lock", "--hash=sha256:fbde69", "--hash=sha256:fbde70", "wheels.sha256"),
        ("requirements.lock", "pytest==8.4.2", "pytest==8.4.3", "wheels.sha256"),
        ("torch.lock", "torch==", "numpy==", "torch alone"),
    ]
    for n, (name, old, new, message) in enumerate(cases):
        folder = copy_pins(tmp_path / str(n))
        edit(folder / name, old, new)
        with pytest.raises(pins.PinError, match=message):
            pins.check_lock(folder)
    # A package beyond the frozen set and EXTRA, even locked and recorded alike, is refused.
    folder = copy_pins(tmp_path / "beyond")
    with (folder / "wheels.sha256").open("a", encoding="utf-8") as f:
        f.write("leftpad==1.0 sha256=" + "e" * 64 + "\n")
    with (folder / "requirements.lock").open("a", encoding="utf-8") as f:
        f.write("leftpad==1.0 --hash=sha256:" + "e" * 64 + "\n")
    with pytest.raises(pins.PinError, match="beyond constraints.txt"):
        pins.check_lock(folder)
    folder = copy_pins(tmp_path / "names")
    edit(folder / "constraints.txt", "ema-lightning==1.1.2", "EMA_Lightning==1.1.2")
    pins.check_lock(folder)  # names compare the way PyPI compares them
```

`rust/bridge/voice/speech/speak/tests/test_speak_image.py`:

```python
"""The speak image and its unit as shipped: no network, read-only and unprivileged at run time; the
base image, the packages and the weights pinned; only Antalia's normaliser in our code; the
approved texts the self-test reads are the policy's."""
import pathlib
import re
import shlex

import pytest

SPEAK = pathlib.Path(__file__).resolve().parents[1]
UNIT_FILE = SPEAK.parent.parent / "deploy" / "jeeta-voice-speak.service"
if not UNIT_FILE.exists():  # inside the image, which holds neither the Dockerfile nor the unit
    pytest.skip("the repository's Dockerfile and unit are not here", allow_module_level=True)
DOCKERFILE = (SPEAK / "Dockerfile").read_text(encoding="utf-8")
UNIT = UNIT_FILE.read_text(encoding="utf-8")
RUST_CALLS = SPEAK.parents[3] / "crates" / "domain" / "jt_calls" / "src"

# Every option of the unit's `docker run`, exactly: adding, dropping or changing one fails here.
RUN_OPTIONS = [
    "--rm", "--pull", "never", "--name", "jeeta-voice-speak", "--init", "--network", "none",
    "--user", "1502:1501", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--ulimit", "core=0", "--cpus", "2", "--cpu-shares", "2048",
    "--memory", "2g", "--memory-swap", "2g",
    "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev",
    "--mount", "type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice",
    "-e", "SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock", "-e", "SPEAK_THREADS=2", "-e", "SPEAK_BATCH=2",
    "-e", "EMA_SEED=0", "-e", "SPEAK_WORKERS=2", "-e", "SPEAK_WATCHDOG_S=60",
    "${SPEAK_IMAGE}",
]


def exec_start():
    joined = re.sub(r"\\\n\s*", " ", UNIT)
    line = re.search(r"^ExecStart=(.+)$", joined, re.M).group(1)
    return shlex.split(line)


def test_the_container_runs_exactly_as_specified():
    argv = exec_start()
    assert argv[:2] == ["/usr/bin/docker", "run"]
    assert argv[2:] == RUN_OPTIONS
    assert re.search(r"^Restart=always$", UNIT, re.M)
    assert re.search(r"^StartLimitBurst=5$", UNIT, re.M)
    assert "SPEAK_WEIGHTS_LOCK" not in UNIT and "RESPELL_FILE" not in UNIT


def test_the_image_user_is_the_units():
    assert re.findall(r"^USER (\S+)$", DOCKERFILE, re.M) == ["1502:1501"]
    assert "useradd --uid 1502 --gid 1501" in DOCKERFILE and "groupadd --gid 1501 jeeta-voice" in DOCKERFILE


def test_the_base_image_is_pinned_by_digest():
    froms = re.findall(r"^FROM\s+(\S+)", DOCKERFILE, re.M)
    assert len(froms) == 1
    assert re.fullmatch(r"python:3\.12-slim-bookworm@sha256:[0-9a-f]{64}", froms[0]), froms[0]


def test_packages_install_only_from_the_hashed_locks_one_index_each():
    code = re.sub(r"\\\n\s*", " ", re.sub(r"^#.*\n", "", DOCKERFILE, flags=re.M))  # no comments, a RUN per line
    installs = re.findall(r"pip install (.+?) -r (\S+)", code)
    assert [lock for _, lock in installs] == ["torch.lock", "requirements.lock"]
    (torch_options, _), (rest_options, _) = installs
    for options in (torch_options, rest_options):
        for flag in ("--no-cache-dir", "--require-hashes", "--no-deps", "--only-binary=:all:"):
            assert flag in options.split()
        assert "--extra-index-url" not in options
    assert "--index-url https://download.pytorch.org/whl/cpu" in torch_options
    assert "--index-url https://pypi.org/simple" in rest_options
    assert re.search(r"&& pip check\s+&&", code) and "RUN python pins.py check-lock" in code
    assert code.index("pins.py check-lock") < code.index("pip install")
    assert "--expect wheels.sha256" in code
    assert "constraints.txt" not in code.split("pip install", 1)[1], "constraints only feed the locks"


def test_the_weights_are_fetched_checked_and_offline_after():
    fetch = DOCKERFILE.index("python pins.py fetch-weights")
    offline = DOCKERFILE.index("HF_HUB_OFFLINE=1")
    assert fetch < offline < DOCKERFILE.index("python jeeta_speak.py --self-test") < DOCKERFILE.index("\nCMD ")
    assert "Antalia()" not in DOCKERFILE, "the normaliser is code only: no Antalia weights"


def test_every_copied_file_passes_the_dockerignore():
    allowed = {
        line[1:] for line in (SPEAK / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.startswith("!")
    }
    copied = [src for line in re.findall(r"^COPY (.+)$", DOCKERFILE, re.M) for src in line.split()[:-1]]
    for src in copied:
        assert src in allowed or f"{src}/*.py" in allowed, f"{src} is not let through .dockerignore"
        assert (SPEAK / src).exists() or src == "pytest.ini", f"{src} does not exist"


def test_production_reads_no_override_of_its_pinned_files():
    source = (SPEAK / "jeeta_speak.py").read_text(encoding="utf-8")
    assert "SPEAK_WEIGHTS_LOCK" not in source and "RESPELL_FILE" not in source
    knobs = set(re.findall(r'env_int\("([A-Z_]+)"', source)) | set(re.findall(r'os\.environ\.get\("([A-Z_]+)"', source))
    assert knobs == {"SPEAK_THREADS", "SPEAK_BATCH", "EMA_SEED", "SPEAK_WORKERS", "SPEAK_WATCHDOG_S", "SPEAK_SOCKET",
                     "SPEAK_LOG"}


def test_our_code_never_uses_normalizer_tr():
    # Owner decision (2026-10-29): normalizer-tr 0.8.1 read "14:00'e" as "on dört iki nokta sıfır
    # sıfır kesme e"; the normaliser is Antalia's.
    for name in ("jeeta_speak.py", "respell.py", "pins.py"):
        source = (SPEAK / name).read_text(encoding="utf-8")
        assert not re.search(r"^\s*(import|from)\s+normalizer_tr\b", source, re.M), name
    assert "Antalia.normalize" in (SPEAK / "jeeta_speak.py").read_text(encoding="utf-8")


def test_the_approved_texts_are_the_policys_defaults():
    import sys

    sys.path.insert(0, str(SPEAK))
    from jeeta_speak import APPROVED_TEXTS

    rust = "\n".join(
        (RUST_CALLS / name).read_text(encoding="utf-8") for name in ("opening.rs", "phrases.rs")
    )
    templates = re.findall(r'format!\("([^"]+)"', rust)
    for text in APPROVED_TEXTS:
        workspace = text.replace("Jeeta'nın", "{g}")
        literal = f'"{text}"' in rust
        templated = any(t.replace("{o}", "Merhaba, ben {g} dijital asistanıyım.") == workspace for t in templates)
        assert literal or templated, text
    phrases = re.findall(r'"([^"]+[.?!])"', (RUST_CALLS / "phrases.rs").read_text(encoding="utf-8"))
    assert set(phrases) <= set(APPROVED_TEXTS), set(phrases) - set(APPROVED_TEXTS)
```

`rust/bridge/voice/speech/speak/tests/test_speak_models.py`:

```python
"""With the real models, inside the image on the host (B2 Step 5), with the unit's isolation:

  docker run --rm --pull never --network none --read-only --cap-drop ALL \\
    --security-opt no-new-privileges --user 1502:1501 --cpus 2 --memory 2g --memory-swap 2g \\
    --pids-limit 128 --tmpfs /tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \\
    jeeta-voice-speak:<tag> python -m pytest -p no:cacheprovider -s -rs tests

Skipped where EMA Lightning or its weights are not installed (the dev machine, CI)."""
import asyncio
import json
import logging
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.models


@pytest.fixture(scope="module")
def mouth():
    pytest.importorskip("ema_lightning")
    pytest.importorskip("antalia_mini")
    import pins

    if any(pins.locate(name) is None for name in pins.FILES):
        pytest.skip("EMA Lightning's weights are not in the model cache")
    from jeeta_speak import build_mouth

    return build_mouth()


def test_the_mouth_speaks_and_reads_times_the_way_the_owner_heard(mouth):
    from jeeta_speak import measure, self_test

    self_test(mouth)
    pcm = b"".join(mouth.chunks("Merhaba, ben Jeeta'nın dijital asistanıyım."))
    assert len(pcm) // 2 > 8000  # more than a second of 8 kHz audio
    for text in ["Merhaba.", "Bir saniye, hemen bakıyorum.", "Salı saat 14:00'e randevunuz var.",
                 "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."]:
        first, total, audio = measure(mouth, text)
        print(f"\nTIMING chars={len(text)} first_ms={first} synth_ms={total} audio_ms={audio}")
        assert audio > 0 and first is not None


def test_the_voice_id_without_the_model_is_the_loaded_ones(mouth):
    from jeeta_speak import voice_id

    assert voice_id() == mouth.voice_id


def test_each_brand_reaches_the_model_as_respelled(mouth):
    from jeeta_speak import tr_lower

    for written, said in mouth.respeller.table.items():
        reading = mouth.model_text(f"Bize {written} üzerinden ulaşabilirsiniz.")
        assert f" {tr_lower(said)} " in f" {reading} ", (written, reading)


def test_numbers_survive_the_sentence_cut(mouth):
    sentences = mouth.sentences("Toplam 1.250,50 TL. Randevunuz 3 Kasım saat 09:30'da.")
    assert sentences == [
        "toplam bin iki yüz elli lira elli kuruş.",
        "randevunuz üç kasım saat dokuz otuzda.",
    ]


ABBREVIATED = {
    "dr": "Yarın Dr. Ahmet Yılmaz sizi arayacak.", "sn": "Sn. Ahmet Yılmaz sizi arıyoruz.",
    "av": "Av. Ayşe Demir dosyayı inceledi.", "prof": "Prof. Ayşe Demir ders verecek.",
    "doç": "Doç. Ali Kaya katılacak.", "yrd": "Yrd. Doç. Ali Kaya katılacak.", "no": "Daire No. 5 sizin mi?",
    "tel": "Tel. sıfır beş yüz otuz iki arayın.", "vb": "Kalem, defter vb. ürünler var.",
    "vs": "Kalem, defter vs. ürünler var.", "ltd": "Figurunica Ltd. Şti. sizi arıyor.",
    "şti": "Atölye Şti. adına arıyorum.", "cad": "Bağdat Cad. üzerindeyiz.", "sok": "Lale Sok. içinde bulunuyor.",
    "mah": "Moda Mah. içinde bulunuyor.", "apt": "Gül Apt. önünde bekliyoruz.",
    "bul": "Atatürk Bul. üzerindeyiz.", "st": "Çarşı St. yanında bekliyoruz.",
}


def test_no_sentence_is_cut_after_one_of_the_workers_abbreviations(mouth):
    from jeeta_speak import ABBREVIATIONS

    assert set(ABBREVIATED) == ABBREVIATIONS
    for word, text in ABBREVIATED.items():
        for written in (text, text.replace(f"{word.capitalize()}.", f"{word}.")):
            assert len(mouth.sentences(written)) == 1, (word, mouth.sentences(written))


def test_the_same_sentence_sounds_the_same_each_time(mouth):
    # The worker caches a sentence's audio by its text: one text, one rendering.
    text = "Anladım."
    assert b"".join(mouth.chunks(text)) == b"".join(mouth.chunks(text))


async def serve_and(mouth, clients):
    """Serves the real mouth as the service does and runs `clients(url)`."""
    import jeeta_speak

    pool = ThreadPoolExecutor(max_workers=len(mouth.voices))
    async with jeeta_speak.open_server(("tcp", "127.0.0.1", 0), lambda ws: jeeta_speak.session(ws, mouth, pool)) as s:
        return await clients(f"ws://127.0.0.1:{s.sockets[0].getsockname()[1]}")


async def synthesise(ws, sid, text):
    await ws.send(json.dumps({"type": "synth", "id": sid, "text": text}))
    pcm = b""
    while True:
        m = await ws.recv()
        if isinstance(m, bytes):
            pcm += m
        elif json.loads(m)["type"] == "done":
            return pcm


def test_concurrent_streams_sound_as_they_do_alone(mouth):
    # The live sentence and the pre-synthesis come on two connections at once; each synthesis takes
    # an EMA instance of its own (one instance batches its streams, and a batched stream's audio
    # differs in its last bits), so each must get exactly the audio of the same sentence alone.
    import websockets

    texts = ["Bir saniye, hemen bakıyorum.", "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."]
    alone = {t: b"".join(mouth.chunks(t)) for t in texts}
    assert len(mouth.voices) >= 2
    for voice in mouth.voices[1:]:
        assert {t: b"".join(mouth.chunks(t, voice)) for t in texts} == alone, "the instances are one voice"

    async def clients(url):
        async def one(order, n):
            async with websockets.connect(url, logger=logging.getLogger("canary-client")) as ws:
                await ws.recv()
                return [(t, await synthesise(ws, f"{n}:{k}", t)) for k, t in enumerate(order * 3)]

        a, b = await asyncio.gather(one(texts, 0), one(texts[::-1], 1))
        return a + b

    results = asyncio.run(serve_and(mouth, clients))
    assert len(results) == 12
    for text, pcm in results:
        assert pcm == alone[text], text


def test_a_stream_closed_early_leaves_ema_ready_for_the_next(mouth):
    gen = mouth.chunks("Bu uzun bir cümle; ilk saniyesinden sonra kesiliyor ve geri kalanı hiç okunmuyor.")
    assert next(gen)
    gen.close()
    assert len(b"".join(mouth.chunks("Tamam."))) > 0


def test_a_spoken_name_and_number_reach_no_log(mouth, caplog, capfd):
    # The canary: a name and a phone number through the real stack (respelling, Antalia, EMA, the
    # session over a WebSocket), with the service's own logging at debug level.
    import websockets

    import jeeta_speak

    secret = "Ayşe Yılmaz 0532 412 33 08"
    spoken = mouth.spoken(secret)
    caplog.set_level(logging.DEBUG)
    handler = jeeta_speak.configure_logging("debug")
    quiet = logging.getLogger("canary-client")
    quiet.setLevel(logging.WARNING)

    async def run():
        pool = ThreadPoolExecutor(max_workers=2)
        async with jeeta_speak.open_server(("tcp", "127.0.0.1", 0),
                                           lambda ws: jeeta_speak.session(ws, mouth, pool)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=quiet) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "synth", "id": "c:0", "text": secret}))
                while True:
                    m = await ws.recv()
                    if isinstance(m, str) and json.loads(m)["type"] != "hello":
                        return json.loads(m)

    try:
        done = asyncio.run(run())
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
    assert done["type"] == "done" and done["audio_ms"] > 1000
    out, err = capfd.readouterr()
    logged = (caplog.text + out + err).lower()
    assert "done:" in logged
    for piece in ["ayşe", "yılmaz", "0532", "412", "33 08", spoken.lower(), "beş yüz otuz iki"]:
        assert piece not in logged, piece
```

- [ ] **Step 2: Run them to see them fail**

Run (from `rust/bridge/voice`, Python 3.12 with `pip install pytest==8.4.2 numpy==2.5.4 websockets==17.3`): `python -I -m pytest -c speech/pytest.ini -m "not models" speech/speak/tests`
Expected: FAIL (`ModuleNotFoundError: No module named 'respell'`).

- [ ] **Step 3: Write the service**

`rust/bridge/voice/speech/speak/respell.py`:

```python
"""Brand respelling in front of the normaliser: a written brand becomes the spelling the voice
pronounces right ("Jeeta" -> "Cita"). EMA Lightning reads foreign words by Turkish spelling (its
model card), and Antalia's normaliser keeps these brands as written (its lexicon is reviewed for
its own voice): without the table EMA's model would receive "jeeta", "whatsapp", "facebook" and
"google" (checked with antalia-mini 1.0.1 and normalizer-tr 0.8.1 on 2026-10-29).

Whole words only and case-insensitive; Python's matching also pairs the Turkish i letters (I, İ,
ı, i), so "İNSTAGRAM" and "Instagram" match alike. A suffix after an apostrophe stays as written
("WhatsApp'tan" -> "vatsap'tan"). One pass: a replacement is never matched again. The transcript
keeps the original text; this is pronunciation only."""
import json
import re


def fold(word):
    """The key a written word is matched by: case-folded, with the four i letters made one."""
    return word.replace("İ", "i").replace("I", "i").replace("ı", "i").casefold()


class Respeller:
    def __init__(self, table):
        if not isinstance(table, dict):
            raise ValueError("the respelling table is an object of written -> spoken")
        said = {}
        for written, spoken in table.items():
            for value in (written, spoken):
                if not isinstance(value, str) or not value or value != value.strip():
                    raise ValueError("a respelling entry is a non-empty string without outer spaces")
            if fold(written) in said:
                raise ValueError(f"the respelling table names {written!r} twice")
            said[fold(written)] = spoken
        self.table = dict(table)
        self._said = said
        self._pattern = None
        if said:
            alternatives = sorted(table, key=len, reverse=True)
            self._pattern = re.compile(
                r"(?<!\w)(" + "|".join(map(re.escape, alternatives)) + r")(?!\w)", re.IGNORECASE
            )

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    def apply(self, text):
        if self._pattern is None:
            return text
        return self._pattern.sub(lambda m: self._said.get(fold(m.group(1)), m.group(1)), text)
```

`rust/bridge/voice/speech/speak/respell.json`:

```json
{
  "Jeeta": "Cita",
  "WhatsApp": "vatsap",
  "Instagram": "instagram",
  "Facebook": "feysbuk",
  "TikTok": "tiktok",
  "Google": "gugıl"
}
```

`rust/bridge/voice/speech/speak/jeeta_speak.py`:

```python
"""jeeta-speak: the voice bridge's mouth (design addendum section 6, plan V1-T3 B2).

A long-lived process that keeps EMA Lightning warm and speaks one protocol, one WebSocket per
connection, on a unix socket (the container runs with --network none) or, for development, a
loopback TCP port. SPEAK_SOCKET is `unix:/path`, `/path` or `tcp:127.0.0.1:<port>`.

  server -> {"type": "hello", "voice_id": "<12 hex>", "sample_rate": 8000, "format": "pcm16le"}
  client -> {"type": "synth", "id": "<id>", "text": "<a sentence>"}
  server -> binary frames: PCM16 little-endian mono 8000 Hz, in order (the worker encodes G.711)
  server -> {"type": "done", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>, "first_ms": <int>}
  client -> {"type": "cancel", "id": "<id>"}
  server -> {"type": "cancelled", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>}
  server -> {"type": "error", "id": "<id>"|null, "reason": "busy"|"bad_request"|"too_long"|"failed"}

`hello` comes first on every connection: its voice id names everything that decides how a text
sounds (versions, weights, seed, threads, batch, the brand table, the sentence rules), so a client
keys its audio cache by it. Frames are EMA's chunks (about one second first, then up to four), of
any even length. Every frame of a synthesis comes before its terminal message (done, cancelled or
error) and none after it, and a synthesis starts only after the previous one's terminal message.
A cancel can lose the race: a synthesis that already ended is not cancelled, so a client that
cancels drops frames until it reads the terminal message for that id, whichever it is. One
synthesis at a time per connection: a second `synth` while one runs is refused `busy`, except after
a `cancel`, when it waits for the cancelled one to unwind and then starts. A cancel takes effect
when EMA hands over its next chunk; the rest of that sentence is dropped. `first_ms` is the time to
the first frame, absent when there was none.

Text goes through the brand respelling table, then Antalia-2 Mini's normaliser, is cut into
sentences, and each sentence is one EMA stream (`sample_rate=8000`, a fixed seed), with 250 ms of
silence between sentences. A one-sentence text is exactly one stream of the normalised text, the
path the owner's blind test heard. Nothing that holds a text reaches the log: the root handler
passes only this service's records, which carry lengths, timings and kinds.
"""
import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import signal
import stat
import sys
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from respell import Respeller

LOG = logging.getLogger("jeeta-speak")
# The connections' logger, outside "jeeta-speak" on purpose: websockets logs every frame (text
# included) at debug level and quotes exceptions at error level, so the root filter withholds it.
WS_LOG = logging.getLogger("speak.websocket")
WS_LOG.setLevel(logging.WARNING)

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 8000
# EMA's own pause between the pieces it cuts a long text into (ema_lightning/chunker.py).
SENTENCE_GAP_MS = 250
SENTENCE_GAP = b"\x00\x00" * (SAMPLE_RATE * SENTENCE_GAP_MS // 1000)
MIN_SENTENCE_WORDS = 3
# The worker's abbreviations (plan B4 text.rs). Antalia's normaliser expands all of them except
# a lowercase "sn.", "tel." and "st." (antalia-mini 1.0.1, checked 2026-10-29), so a period after
# one of these words never ends a sentence.
ABBREVIATIONS = frozenset([
    "dr", "sn", "av", "prof", "doç", "yrd", "no", "tel", "vb", "vs", "ltd", "şti", "cad", "sok", "mah",
    "apt", "bul", "st",
])
# Bump with any change to how a text becomes sentences or audio that the constants below miss.
PIPELINE_VERSION = 1
MAX_TEXT_CHARS = 2000
# The normalised text a request may become (numbers read out grow several times their digits).
MAX_SPOKEN_CHARS = 4000
MAX_ID_CHARS = 128
MAX_MESSAGE_BYTES = 1 << 20
DEFAULT_SOCKET = "unix:/run/jeeta-voice/speak.sock"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
CLOCK_PROBE = "Salı saat 14:00'e randevunuz var."
WARM_TEXT = "Merhaba, ben dijital asistanınız; size nasıl yardımcı olabilirim?"
# What Antalia's normaliser should have read out: a digit or one of these symbols left in its
# cased output (before its last pass drops what the model cannot read) was not spoken.
RESIDUE = re.compile(r"[0-9%@#/+]|(?<=\d):|:(?=\d)")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_LAST_WORD = re.compile(r"(\w+)\.$")
_RUNNING = set()

# The owner-approved texts the bridge plays (jt_calls opening.rs and phrases.rs defaults, A3/A4),
# with "Jeeta" as the workspace. The self-test reads each one through the real stack.
APPROVED_TEXTS = (
    "Merhaba, ben Jeeta'nın dijital asistanıyım.",
    "Merhaba, ben Jeeta'nın dijital asistanıyım. Size nasıl yardımcı olabilirim?",
    "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.",
    "Görüşmek üzere, iyi günler.",
    "Hı hı.",
    "Anladım.",
    "Tamam.",
    "Peki.",
    "Bir saniye, hemen bakıyorum.",
    "Kontrol ediyorum, kısa bir an.",
    "Biraz daha zaman alıyor, beklediğiniz için teşekkürler.",
    "Sizi tam duyamadım, tekrar eder misiniz?",
    "Hâlâ orada mısınız?",
    "Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.",
)
# Where EMA's own frontend changes Antalia's reading of an approved text (its alphabet folds the
# circumflex: ema_lightning/frontend.py); everywhere else it must pass the reading through as is.
MODEL_READS = {"hâlâ orada mısınız?": "hala orada mısınız?"}


class TooLong(Exception):
    """The normalised text exceeds MAX_SPOKEN_CHARS."""


def tr_lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def split_sentences(text):
    """The sentences of a normalised text: cut after . ! ? and a space (after Antalia's normaliser
    numbers, times and most abbreviations are words, so a period left is a sentence's end), never
    after one of the worker's abbreviations. A piece of fewer than three words joins the next one
    ("evet. tamam. yarın görüşürüz." stays whole)."""
    out, pending = [], ""
    for part in _SENTENCE_END.split(text.strip()):
        pending = f"{pending} {part}".strip()
        last = _LAST_WORD.search(pending)
        if last and tr_lower(last.group(1)) in ABBREVIATIONS:
            continue
        if len(pending.split()) >= MIN_SENTENCE_WORDS:
            out.append(pending)
            pending = ""
    if pending:
        if out:
            out[-1] = f"{out[-1]} {pending}"
        else:
            out.append(pending)
    return out


def to_pcm16(audio):
    samples = np.nan_to_num(np.asarray(audio, dtype=np.float32).reshape(-1), nan=0.0, posinf=1.0, neginf=-1.0)
    return np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class VoicePool:
    """EMA instances, one per synthesis at a time. One instance batches the streams it serves
    together, and a batched stream's audio differs (in its last bits) from the same sentence alone:
    each synthesis takes an instance of its own, on the event loop, so no worker thread ever waits
    for one."""

    def __init__(self, voices):
        self.voices = list(voices)
        self.free = None
        self.loop = None

    async def acquire(self):
        loop = asyncio.get_running_loop()
        if self.loop is not loop:  # a queue belongs to one loop: the service has one
            self.free, self.loop = asyncio.Queue(), loop
            for v in self.voices:
                self.free.put_nowait(v)
        return await self.free.get()

    def release(self, voice):
        self.free.put_nowait(voice)


class Mouth:
    def __init__(self, respeller, normalize, tts, seed, sample_rate=SAMPLE_RATE, residue=None):
        self.respeller = respeller
        self.normalize = normalize
        # One EMA instance or several (a VoicePool hands them out); the first reads the self-test.
        self.voices = list(tts) if isinstance(tts, (list, tuple)) else [tts]
        self.tts = self.voices[0]
        self.voice_pool = None
        self.seed = seed
        self.sample_rate = sample_rate
        # text -> how many symbols the normaliser left unread (None: not measured).
        self.residue = residue
        self.residual_symbols = 0
        self.weights = {}  # name -> sha256 of the weights checked before loading
        self.voice_id = None

    def spoken(self, text):
        respelled = self.respeller.apply(text)
        if self.residue is not None:
            left = self.residue(respelled)
            if left:
                self.residual_symbols += left
                LOG.warning("the normaliser left %d symbols unread (%d so far)", left, self.residual_symbols)
        return self.normalize(respelled)

    def sentences(self, text):
        spoken = self.spoken(text)
        if len(spoken) > MAX_SPOKEN_CHARS:
            raise TooLong()
        return split_sentences(spoken)

    def model_text(self, text):
        """What EMA's model reads for `text` (its frontend runs after ours), or None if unknown."""
        frontend = getattr(self.tts, "_frontend", None)
        if frontend is None:
            return None
        return " ".join(frontend(s) for s in self.sentences(text))

    def chunks(self, text, tts=None):
        """PCM16 chunks of `text`, as EMA (`tts`, else the first instance) makes them. Closing this
        generator stops EMA's work."""
        tts = tts or self.tts
        for i, sentence in enumerate(self.sentences(text)):
            if i:
                yield SENTENCE_GAP
            stream = tts.stream(sentence, sample_rate=self.sample_rate, seed=self.seed)
            try:
                for audio in stream:
                    pcm = to_pcm16(audio)
                    if pcm:
                        yield pcm
            finally:
                close = getattr(stream, "close", None)
                if close is not None:
                    close()


def measure(mouth, text, tts=None):
    """(first chunk ms, total ms, audio ms) of one synthesis."""
    started, first, samples = time.monotonic(), None, 0
    for chunk in mouth.chunks(text, tts):
        if first is None:
            first = int((time.monotonic() - started) * 1000)
        samples += len(chunk) // 2
    return first, int((time.monotonic() - started) * 1000), samples * 1000 // mouth.sample_rate


def env_int(name, default, low, high):
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer") from None
    if not low <= value <= high:
        raise SystemExit(f"{name} must be from {low} to {high}")
    return value


def settings():
    """The environment's knobs (the unit sets each explicitly)."""
    return {
        "threads": env_int("SPEAK_THREADS", 2, 1, 16),
        "batch": env_int("SPEAK_BATCH", 2, 1, 8),
        "seed": env_int("EMA_SEED", 0, 0, 2**31 - 1),
        "workers": env_int("SPEAK_WORKERS", 2, 1, 8),
        "watchdog_s": env_int("SPEAK_WATCHDOG_S", 60, 10, 600),
    }


def set_batch(tts, size):
    """EMA measures its best batch size on first use (every size up to 8 on its probe sentence) and
    caches the result under ~/.cache, which this read-only container cannot write; a failed write
    fails every synthesis in that turn. The size is fixed instead (ema-lightning 1.1.2,
    `EMA._batch_size`): 2, the value EMA measured for itself in the image the owner tested."""
    if not hasattr(tts, "_batch_size"):
        raise SystemExit("ema-lightning changed: it has no batch size to fix")
    tts._batch_size = size


def versions():
    from importlib.metadata import PackageNotFoundError, version

    out = {}
    for name in ("ema-lightning", "antalia-mini", "normalizer-tr", "torch"):
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = "?"
    return out


def pipeline():
    """The sentence and audio rules, as data: a change to any of them changes the voice id."""
    return {
        "version": PIPELINE_VERSION,
        "gap_ms": SENTENCE_GAP_MS,
        "min_words": MIN_SENTENCE_WORDS,
        "splitter": _SENTENCE_END.pattern,
        "abbreviations": sorted(ABBREVIATIONS),
        "rate": SAMPLE_RATE,
    }


def voice_fingerprint(versions, weights, knobs, table):
    """A short id of everything that decides how a text sounds: a cache of synthesised sentences
    is only valid for one (the worker keys its cache by the `hello`'s voice id)."""
    parts = {"versions": versions, "weights": weights, "seed": knobs["seed"], "threads": knobs["threads"],
             "batch": knobs["batch"], "respell": table, "pipeline": pipeline()}
    encoded = json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()[:12]


def voice_id(knobs=None):
    """The voice id from the installed versions, weights.lock, the knobs and respell.json, without
    loading the model (the weights are checked against the same lock before they are loaded)."""
    import pins

    lock = pins.load_lock()
    weights = {name: entry["sha256"] for name, entry in lock["files"].items()}
    table = Respeller.load(os.path.join(HERE, "respell.json")).table
    return voice_fingerprint(versions(), weights, knobs or settings(), table)


def build_mouth(knobs=None):
    """The real mouth: the pinned weights checked, EMA loaded on the CPU, Antalia's normaliser."""
    import torch
    from antalia_mini import Antalia
    from antalia_mini.text import normalize_for_cased_model
    from ema_lightning import EMA

    import pins

    knobs = knobs or settings()
    try:
        weights = pins.verify(pins.load_lock())
    except (pins.PinError, OSError, ValueError) as e:
        raise SystemExit(f"weights check failed: {e}") from None
    torch.set_num_threads(knobs["threads"])
    voices = [EMA(device="cpu") for _ in range(knobs["workers"])]
    for tts in voices:
        set_batch(tts, knobs["batch"])
    respeller = Respeller.load(os.path.join(HERE, "respell.json"))
    # A static method in antalia-mini 1.0.1: the text the model reads, with no weights loaded. Its
    # cased stage, before the last pass drops what the model cannot read, shows what was not read.
    mouth = Mouth(respeller, Antalia.normalize, voices, knobs["seed"],
                  residue=lambda t: len(RESIDUE.findall(normalize_for_cased_model(t))))
    mouth.voice_pool = VoicePool(voices)
    mouth.weights = weights
    mouth.voice_id = voice_fingerprint(versions(), weights, knobs, respeller.table)
    return mouth


def self_test(mouth):
    """The readings the owner's test depended on, as EMA's model receives them; the process
    refuses to start without them. The clock: "on dörde", not normalizer-tr's "iki nokta ... kesme".
    Each brand: its respelling reaches the model. Each approved text: EMA's frontend keeps
    Antalia's reading as is (or as MODEL_READS says), and no "kesme" is read aloud."""
    reading = mouth.model_text(CLOCK_PROBE)
    if reading is None:
        raise SystemExit("self-test: the voice does not show the text its model reads")
    if "on dörde" not in reading or "nokta" in reading or "kesme" in reading:
        raise SystemExit("normaliser self-test failed: 14:00'e")
    for written, said in mouth.respeller.table.items():
        reading = mouth.model_text(f"Bugün {written} hakkında konuşuyoruz.")
        if not re.search(rf"(?<!\w){re.escape(tr_lower(said))}(?!\w)", reading):
            raise SystemExit(f"respelling self-test failed: {written}")
    frontend = mouth.tts._frontend
    for n, text in enumerate(APPROVED_TEXTS):
        for sentence in mouth.sentences(text):
            read = frontend(sentence)
            if read != MODEL_READS.get(sentence, sentence) or "kesme" in read:
                raise SystemExit(f"approved-text self-test failed: text {n}")


class Watchdog:
    """Ends the process when a synthesis chunk, or the event loop itself, is stuck past `limit_s`,
    so systemd's Restart=always brings a working service back. It runs on its own thread."""

    def __init__(self, limit_s, clock=time.monotonic, exit=os._exit):
        self.limit_s, self.clock, self.exit = limit_s, clock, exit
        self.lock = threading.Lock()
        self.waits = {}
        self.token = 0
        self.beat = clock()

    def begin(self):
        with self.lock:
            self.token += 1
            self.waits[self.token] = self.clock()
            return self.token

    def end(self, token):
        with self.lock:
            self.waits.pop(token, None)

    def heartbeat(self):
        self.beat = self.clock()

    def check(self):
        now = self.clock()
        with self.lock:
            stuck = sum(1 for t in self.waits.values() if now - t > self.limit_s)
        if stuck or now - self.beat > self.limit_s:
            LOG.critical("stuck for over %d s (%d synthesis waits, loop %s): exiting", self.limit_s, stuck,
                         "stalled" if now - self.beat > self.limit_s else "running")
            self.exit(70)
            return True
        return False

    def start(self, period_s=1.0):
        def run():
            while not self.check():
                time.sleep(period_s)

        threading.Thread(target=run, name="speak-watchdog", daemon=True).start()


_watchdog = None


class OnlyOurs(logging.Filter):
    """Passes this service's records only. A library's record may quote a text (antalia-mini's
    normaliser warning does, websockets' frame and error lines can): it is withheld, and one of ours
    says which logger and level it came from."""

    def filter(self, record):
        if record.name == LOG.name or record.name.startswith(LOG.name + "."):
            return True
        if record.levelno >= logging.WARNING:
            LOG.warning("withheld a record (%s) from %s", record.levelname, record.name)
        return False


def _quiet_warning(message, category, filename, lineno, file=None, line=None):
    # A library warning may quote the text it failed on (antalia-mini's normaliser fallback does).
    LOG.warning("%s at %s:%d", category.__name__, os.path.basename(filename), lineno)


def _quiet_exception(kind, value, tb):
    # An exception's message may quote a text: its kind and where it was raised only.
    frame = traceback.extract_tb(tb)[-1] if tb else None
    where = f"{os.path.basename(frame.filename)}:{frame.lineno}" if frame else "?"
    LOG.critical("uncaught %s at %s", kind.__name__, where)


def configure_logging(level_name):
    """Our handler on the root logger, behind OnlyOurs; library warnings and uncaught exceptions
    are logged by kind and place. Returns the handler."""
    level = getattr(logging, level_name.upper(), None)
    if not isinstance(level, int):
        raise SystemExit("SPEAK_LOG must be debug, info, warning or error")
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    handler.addFilter(OnlyOurs())
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    LOG.setLevel(level)
    warnings.showwarning = _quiet_warning
    sys.excepthook = _quiet_exception
    threading.excepthook = lambda a: _quiet_exception(a.exc_type, a.exc_value, a.exc_traceback)
    return handler


def parse_endpoint(value):
    if value.startswith("tcp:"):
        host, _, port = value[4:].rpartition(":")
        host = host.strip("[]")
        if host not in LOOPBACK:
            raise ValueError("a TCP endpoint must be on loopback")
        if not port.isdigit() or int(port) > 65535:
            raise ValueError("a TCP endpoint needs a port")
        return ("tcp", host, int(port))
    path = value.removeprefix("unix:")
    if not path.startswith("/"):
        raise ValueError("a unix socket path must be absolute")
    return ("unix", path)


def remove_stale_socket(path):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise SystemExit(f"{path} exists and is not a socket")
    os.unlink(path)


SERVER_OPTIONS = {
    # No compression (audio does not shrink), no keepalive pings (a local socket closes when its
    # peer dies), a megabyte per message so an over-long text is refused, not a dropped connection.
    "compression": None, "ping_interval": None, "max_size": MAX_MESSAGE_BYTES, "logger": WS_LOG,
}


@contextlib.asynccontextmanager
async def open_server(endpoint, handler):
    from websockets.asyncio.server import serve, unix_serve

    if endpoint[0] == "tcp":
        async with serve(handler, endpoint[1], endpoint[2], **SERVER_OPTIONS) as server:
            yield server
        return
    path = endpoint[1]
    remove_stale_socket(path)
    old = os.umask(0o117)
    try:
        server = await unix_serve(handler, path, **SERVER_OPTIONS)
    finally:
        os.umask(old)
    try:
        os.chmod(path, 0o660)
        yield server
    finally:
        server.close()
        await server.wait_closed()
        with contextlib.suppress(OSError):
            if stat.S_ISSOCK(os.lstat(path).st_mode):
                os.unlink(path)


def health(endpoint):
    """0 when the service answers a WebSocket handshake with its hello, 1 otherwise (the image's
    HEALTHCHECK)."""
    from websockets.sync.client import connect, unix_connect

    options = {"open_timeout": 5, "compression": None}
    try:
        if endpoint[0] == "tcp":
            host = f"[{endpoint[1]}]" if ":" in endpoint[1] else endpoint[1]
            opening = connect(f"ws://{host}:{endpoint[2]}/", **options)
        else:
            opening = unix_connect(endpoint[1], **options)
        with opening as ws:
            return 0 if json.loads(ws.recv(timeout=5)).get("type") == "hello" else 1
    except Exception:  # noqa: BLE001 - any failure is "unhealthy"
        return 1


def parse_request(message):
    """(kind, id, text, problem): problem is None or the reason of the error to answer."""
    try:
        msg = json.loads(message)
    except (ValueError, RecursionError):
        return None, None, None, "bad_request"
    if not isinstance(msg, dict):
        return None, None, None, "bad_request"
    sid = msg.get("id")
    if not (isinstance(sid, str) and 0 < len(sid) <= MAX_ID_CHARS):
        sid = None
    kind = msg.get("type")
    if kind not in ("synth", "cancel") or sid is None:
        return kind, sid, None, "bad_request"
    if kind == "cancel":
        return kind, sid, None, None
    text = msg.get("text")
    if not isinstance(text, str):
        return kind, sid, None, "bad_request"
    if len(text) > MAX_TEXT_CHARS:
        return kind, sid, None, "too_long"
    return kind, sid, text, None


async def _next_chunk(loop, pool, gen):
    token = _watchdog.begin() if _watchdog else None
    try:
        return await loop.run_in_executor(pool, next, gen, None)
    finally:
        if token is not None:
            _watchdog.end(token)


async def run_synth(ws, mouth, pool, sid, text, cancel, after=None):
    from websockets.exceptions import ConnectionClosed

    if after is not None:
        with contextlib.suppress(Exception):
            await after
    loop = asyncio.get_running_loop()
    started, first_ms, samples, gen, voice = time.monotonic(), None, 0, None, None
    voices = getattr(mouth, "voice_pool", None)
    try:
        if voices is not None and not cancel.is_set():
            voice = await voices.acquire()
        if not cancel.is_set():
            gen = mouth.chunks(text) if voice is None else mouth.chunks(text, voice)
            while True:
                chunk = await _next_chunk(loop, pool, gen)
                if chunk is None or cancel.is_set():
                    break
                if first_ms is None:
                    first_ms = int((time.monotonic() - started) * 1000)
                samples += len(chunk) // 2
                await ws.send(chunk)
        reply = {
            "type": "cancelled" if cancel.is_set() else "done",
            "id": sid,
            "synth_ms": int((time.monotonic() - started) * 1000),
            "audio_ms": samples * 1000 // SAMPLE_RATE,
        }
        if first_ms is not None:
            reply["first_ms"] = first_ms
        await ws.send(json.dumps(reply))
        LOG.debug("%s: %d chars, first %s ms, synth %d ms, audio %d ms", reply["type"], len(text),
                  first_ms, reply["synth_ms"], reply["audio_ms"])
    except ConnectionClosed:
        cancel.set()
    except TooLong:
        LOG.warning("refused a request: too_long (normalised)")
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": "too_long"}))
    except Exception as e:  # noqa: BLE001 - report the kind, never the text
        LOG.error("synthesis failed: %s", type(e).__name__)
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": "failed"}))
    finally:
        if gen is not None:
            with contextlib.suppress(ValueError):  # still running in a thread only at shutdown
                gen.close()
        if voice is not None:
            voices.release(voice)


async def session(ws, mouth, pool):
    from websockets.exceptions import ConnectionClosed

    current = None  # (id, cancel event, task) of the last synthesis started
    try:
        await ws.send(json.dumps({"type": "hello", "voice_id": mouth.voice_id, "sample_rate": SAMPLE_RATE,
                                  "format": "pcm16le"}))
        async for message in ws:
            if isinstance(message, bytes):
                kind, sid, text, problem = None, None, None, "bad_request"
            else:
                kind, sid, text, problem = parse_request(message)
            if problem is not None:
                LOG.warning("refused a request: %s", problem)
                await ws.send(json.dumps({"type": "error", "id": sid, "reason": problem}))
                continue
            busy = current is not None and not current[2].done()
            if kind == "cancel":
                if busy and current[0] == sid:
                    current[1].set()
                continue
            if busy and not current[1].is_set():
                LOG.warning("refused a request: busy")
                await ws.send(json.dumps({"type": "error", "id": sid, "reason": "busy"}))
                continue
            cancel = asyncio.Event()
            after = current[2] if busy else None
            task = asyncio.create_task(run_synth(ws, mouth, pool, sid, text, cancel, after))
            _RUNNING.add(task)
            task.add_done_callback(_RUNNING.discard)
            current = (sid, cancel, task)
    except ConnectionClosed:
        pass
    finally:
        if current is not None:
            current[1].set()


async def serve_forever(endpoint, mouth, pool, watchdog=None):
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, AttributeError, ValueError):
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))

    async def beat():
        while True:
            watchdog.heartbeat()
            await asyncio.sleep(1)

    beating = asyncio.create_task(beat()) if watchdog else None
    if watchdog:
        watchdog.start()
    async with open_server(endpoint, lambda ws: session(ws, mouth, pool)):
        LOG.info("listening")
        await stop
    if beating:
        beating.cancel()
    LOG.info("stopped")


def main(argv=None):
    global _watchdog
    parser = argparse.ArgumentParser(prog="jeeta_speak.py")
    parser.add_argument("--health", action="store_true", help="exit 0 if the service answers")
    parser.add_argument("--self-test", action="store_true", help="load, check the readings, exit")
    parser.add_argument("--voice-id", action="store_true", help="print the voice id and exit")
    args = parser.parse_args(argv)
    try:
        endpoint = parse_endpoint(os.environ.get("SPEAK_SOCKET", DEFAULT_SOCKET))
    except ValueError as e:
        raise SystemExit(f"SPEAK_SOCKET: {e}") from None
    if args.health:
        return health(endpoint)
    knobs = settings()
    if args.voice_id:
        print(voice_id(knobs))
        return 0
    configure_logging(os.environ.get("SPEAK_LOG", "info"))
    started = time.monotonic()
    mouth = build_mouth(knobs)
    loaded_ms = int((time.monotonic() - started) * 1000)
    self_test(mouth)
    LOG.info("loaded in %d ms: %s; seed %d, threads %d, batch %d, voice %s", loaded_ms,
             ", ".join(f"{k} {v}" for k, v in versions().items()), knobs["seed"], knobs["threads"],
             knobs["batch"], mouth.voice_id)
    if args.self_test:
        LOG.info("self-test passed")
        return 0
    for n, tts in enumerate(mouth.voices):
        first, total, audio = measure(mouth, WARM_TEXT, tts)
        LOG.info("warm %d: first audio in %s ms, %d ms for %d ms of audio", n, first, total, audio)
    pool = ThreadPoolExecutor(max_workers=knobs["workers"], thread_name_prefix="speak")
    _watchdog = Watchdog(knobs["watchdog_s"])
    asyncio.run(serve_forever(endpoint, mouth, pool, _watchdog))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`rust/bridge/voice/speech/speak/pins.py`:

```python
"""What the speak image pins, and the checks that hold it to them. Standard library only at import
time: the build runs `check-lock` before anything is installed.

Packages. constraints.txt is the frozen set of the image the owner's blind test ran on (B2 Step 7,
`pip freeze` of jeeta-ttstest:tmp); requirements.txt names what the service imports; wheels.sha256
records every wheel of the first good build (name, version, sha256). The build installs only from
torch.lock (PyTorch's CPU index alone) and requirements.lock (PyPI alone), both
`--require-hashes --no-deps`, and `lock` writes them from wheels.sha256. `check-lock` refuses a
lock that is not exactly wheels.sha256, a frozen set without ema-lightning 1.1.2, antalia-mini
1.0.1 and a torch CPU build, a requirement the locks miss or pin otherwise, and any package beyond
the frozen set except the service's and pytest's own (EXTRA). `wheels` turns the build's pip
reports into the same lines and, against an --expect file, refuses any difference or unknown hash.

Weights. EMA() downloads ema.pt and decoder.pt from its repository's main branch and takes no
revision, so they are pinned by SHA-256 and size in weights.lock: the build fetches and checks them
(`fetch-weights`), the service checks them again before it loads them (`verify`), and `record`
prints a lock from a local Hugging Face cache (B2 Step 7 ran `verify` in the tested image).

Usage: python pins.py check-lock | lock | fetch-weights | verify | record [--lock PATH]
       python pins.py wheels REPORT.json [REPORT.json ...] [--expect wheels.sha256]
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = "canberkkkkkk/ema-lightning"
# The files EMA() loads (ema_lightning/api.py 1.1.2: ema.pt, decoder.pt; config.json is asked for
# and never read).
FILES = ("ema.pt", "decoder.pt")
HERE = Path(__file__).resolve().parent
LOCK = HERE / "weights.lock"
HEX64 = re.compile(r"[0-9a-f]{64}")
# The owner's choices, which the frozen set must hold.
CHOSEN = {"ema-lightning": "1.1.2", "antalia-mini": "1.0.1"}
# Packages the image holds beyond the owner-tested set: the service's server library and pytest
# with its dependencies (the tested image had neither).
EXTRA = {"websockets", "pytest", "iniconfig", "pluggy", "pygments"}
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"
PYPI_INDEX = "https://pypi.org/simple"


class PinError(Exception):
    """A pinned file is missing or differs (the message names the file, never a path's content)."""


def canonical(name):
    """A project name the way PyPI compares them (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# --- packages ------------------------------------------------------------------------------------


def listed(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def read_pins(text, what):
    """name -> version of `name==version` lines (anything after the version is ignored)."""
    pins = {}
    for line in listed(text):
        m = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)(?:\s.*)?", line)
        if not m:
            raise PinError(f"{what}: not a name==version line: {line.split()[0]}")
        name = canonical(m.group(1))
        if name in pins:
            raise PinError(f"{what}: {name} is listed twice")
        pins[name] = m.group(2)
    return pins


def read_record(text, what):
    """name -> (version, sha256) of `name==version sha256=<hex>` lines (wheels.sha256)."""
    out = {}
    for line in listed(text):
        m = re.fullmatch(r"(\S+)==(\S+) sha256=(\S+)", line)
        if not m or not HEX64.fullmatch(m.group(3)):
            raise PinError(f"{what}: a line has no name==version sha256=<hex>")
        out[canonical(m.group(1))] = (m.group(2), m.group(3))
    return out


def read_lock(text, what):
    """name -> (version, sha256) of `name==version --hash=sha256:<hex>` lines."""
    out = {}
    for line in listed(text):
        m = re.fullmatch(r"(\S+)==(\S+) --hash=sha256:([0-9a-f]{64})", line)
        if not m:
            raise PinError(f"{what}: a line has no name==version --hash=sha256:<hex>")
        out[canonical(m.group(1))] = (m.group(2), m.group(3))
    return out


def lock_lines(entries):
    return [f"{name}=={version} --hash=sha256:{digest}" for name, (version, digest) in sorted(entries.items())]


def lock_files(record):
    """(torch.lock, requirements.lock) texts from a wheel record."""
    torch = {n: e for n, e in record.items() if n == "torch"}
    rest = {n: e for n, e in record.items() if n != "torch"}
    head = "# Generated by `python pins.py lock` from wheels.sha256; installed --require-hashes --no-deps"
    return (
        "\n".join([head + f" from {TORCH_INDEX} alone.", *lock_lines(torch)]) + "\n",
        "\n".join([head + f" from {PYPI_INDEX} alone.", *lock_lines(rest)]) + "\n",
    )


def check_lock(folder=HERE):
    """Every rule of the module docstring, over the files in `folder`; returns the locked set."""
    read = lambda name: (folder / name).read_text(encoding="utf-8")  # noqa: E731
    frozen = read_pins(read("constraints.txt"), "constraints.txt")
    for name, version in CHOSEN.items():
        if frozen.get(name) != version:
            raise PinError(f"constraints.txt must hold {name}=={version}, the owner's choice")
    if not frozen.get("torch", "").endswith("+cpu"):
        raise PinError("constraints.txt must hold a torch CPU build (torch==...+cpu)")
    record = read_record(read("wheels.sha256"), "wheels.sha256")
    torch = read_lock(read("torch.lock"), "torch.lock")
    rest = read_lock(read("requirements.lock"), "requirements.lock")
    if list(torch) != ["torch"] or "torch" in rest:
        raise PinError("torch.lock holds torch alone, and requirements.lock holds no torch")
    locked = {**torch, **rest}
    if locked != record:
        names = sorted(set(locked.items()) ^ set(record.items()))
        raise PinError("the locks differ from wheels.sha256: " + ", ".join(sorted({n for n, _ in names})))
    for name, version in frozen.items():
        if locked.get(name, (None,))[0] != version:
            raise PinError(f"the locks do not hold {name}=={version} from constraints.txt")
    if set(locked) - set(frozen) != EXTRA:
        raise PinError("beyond constraints.txt the locks must hold exactly " + ", ".join(sorted(EXTRA)))
    required = read_pins("\n".join(r for r in listed(read("requirements.txt")) if "==" in r), "requirements.txt")
    for name, version in CHOSEN.items():
        if required.get(name) != version:
            raise PinError(f"requirements.txt must pin {name}=={version}, the owner's choice")
    for line in listed(read("requirements.txt")):
        name, _, version = line.partition("==")
        entry = locked.get(canonical(name))
        if entry is None or (version and entry[0] != version):
            raise PinError(f"the locks do not satisfy {line} from requirements.txt")
    return locked


def wheels(report):
    """`name==version sha256=<hex>` per installed distribution of a `pip install --report`, sorted."""
    lines = []
    for item in report.get("install", []):
        meta, info = item.get("metadata", {}), item.get("download_info", {})
        archive = info.get("archive_info", {})
        digest = archive.get("hashes", {}).get("sha256")
        if not digest and str(archive.get("hash", "")).startswith("sha256="):
            digest = archive["hash"].split("=", 1)[1]
        lines.append(f"{canonical(meta['name'])}=={meta['version']} sha256={digest or '?'}")
    return sorted(lines)


# --- weights -------------------------------------------------------------------------------------


def load_lock(path=LOCK):
    with open(path, encoding="utf-8") as f:
        lock = json.load(f)
    if lock.get("repo") != REPO:
        raise PinError(f"weights.lock is not for {REPO}")
    files = lock.get("files")
    if not isinstance(files, dict) or sorted(files) != sorted(FILES):
        raise PinError(f"weights.lock must pin exactly {', '.join(FILES)}")
    for name, entry in files.items():
        if not HEX64.fullmatch(str(entry.get("sha256", ""))):
            raise PinError(f"weights.lock: {name} has no sha256")
        if not isinstance(entry.get("size"), int) or entry["size"] <= 0:
            raise PinError(f"weights.lock: {name} has no size")
    return lock


def locate(name):
    """The cached file EMA() would load for `name` (the main revision), or None. Offline, no write."""
    from huggingface_hub import try_to_load_from_cache

    found = try_to_load_from_cache(REPO, name)
    return Path(found) if isinstance(found, str) else None


def verify(lock, locate=locate):
    """Every pinned file is in the cache with its size and SHA-256; returns name -> sha256."""
    digests = {}
    for name, entry in sorted(lock["files"].items()):
        path = locate(name)
        if path is None or not path.is_file():
            raise PinError(f"{name}: not in the model cache")
        if path.stat().st_size != entry["size"]:
            raise PinError(f"{name}: size differs from weights.lock")
        digest = sha256_of(path)
        if digest != entry["sha256"]:
            raise PinError(f"{name}: sha256 differs from weights.lock")
        digests[name] = digest
    return digests


def fetch(lock):
    """Build time, with network: download what EMA() will load, then verify it."""
    from huggingface_hub import hf_hub_download

    for name in sorted(lock["files"]):
        hf_hub_download(REPO, name)
    return verify(lock)


def record(locate=locate):
    files = {}
    for name in FILES:
        path = locate(name)
        if path is None:
            raise PinError(f"{name}: not in the model cache")
        files[name] = {"sha256": sha256_of(path), "size": path.stat().st_size}
    return {"repo": REPO, "files": files}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pins.py")
    parser.add_argument("action", choices=["check-lock", "lock", "fetch-weights", "verify", "record", "wheels"])
    parser.add_argument("reports", nargs="*")
    parser.add_argument("--lock", default=str(LOCK))
    parser.add_argument("--expect")
    args = parser.parse_args(argv)
    try:
        if args.action == "check-lock":
            print(f"locks: ok ({len(check_lock())} wheels)")
        elif args.action == "lock":
            torch, rest = lock_files(read_record((HERE / "wheels.sha256").read_text(encoding="utf-8"), "wheels.sha256"))
            (HERE / "torch.lock").write_text(torch, encoding="utf-8", newline="\n")
            (HERE / "requirements.lock").write_text(rest, encoding="utf-8", newline="\n")
        elif args.action == "record":
            print(json.dumps(record(), indent=2, sort_keys=True))
        elif args.action == "wheels":
            got = []
            for path in args.reports:
                with open(path, encoding="utf-8") as f:
                    got.extend(wheels(json.load(f)))
            got.sort()
            if args.expect:
                want = sorted(listed(Path(args.expect).read_text(encoding="utf-8")))
                if any(line.endswith("sha256=?") for line in got):
                    raise PinError("a wheel was installed without a known sha256")
                if want != got:
                    names = sorted({line.split("==")[0] for line in set(want) ^ set(got)})
                    raise PinError("the installed wheels differ from wheels.sha256: " + ", ".join(names))
            print("# pip install --report of the speak image: one installed wheel per line")
            print("\n".join(got))
        else:
            lock = load_lock(args.lock)
            digests = fetch(lock) if args.action == "fetch-weights" else verify(lock)
            print("weights: ok (" + ", ".join(f"{n} {d[:12]}" for n, d in digests.items()) + ")")
    except PinError as e:
        print(f"pins: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`rust/bridge/voice/speech/speak/weights.lock`:

```json
{
  "files": {
    "decoder.pt": {
      "sha256": "9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67",
      "size": 12103269
    },
    "ema.pt": {
      "sha256": "95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6",
      "size": 22285878
    }
  },
  "note": "LFS sha256 of main at e7c96f2fc0ba843cd0f86e02786655bb56f50df8 (last modified 2026-10-21), read from the Hugging Face API on 2026-10-29; B2 Step 7 checks them against jeeta-ttstest:tmp, the image the owner's blind test ran on.",
  "repo": "canberkkkkkk/ema-lightning"
}
```

`rust/bridge/voice/speech/speak/requirements.txt`:

```text
# What the speak service imports, the input of the locks: the two the owner chose and the server
# and test libraries the plan fixes are pinned here; numpy, torch (its CPU build) and
# huggingface-hub take the versions of constraints.txt, the frozen set of the image the owner's
# blind test ran on. The build installs only from the hashed locks (pins.py check-lock holds them
# to this file). normalizer-tr is not ours: ema-lightning requires it and runs it on the text
# Antalia's normaliser has already spelled out; the start-up self-test checks that the readings we
# rely on reach the model unchanged (jeeta_speak.self_test).
ema-lightning==1.1.2
antalia-mini==1.0.1
websockets==17.3
pytest==8.4.2
numpy
torch
huggingface-hub
```

- [ ] **Step 4: Run the unit tests**

Run: `python -I -m pytest -c speech/pytest.ini -m "not models" speech/speak/tests`
Expected: on Windows `72 passed, 3 skipped, 9 deselected` (the three unix-socket tests skip); on Linux `75 passed, 9 deselected`.

- [ ] **Step 5: Write the image and the unit**

`constraints.txt` and `wheels.sha256` come from the server (Step 7); `python pins.py lock` writes `torch.lock` and `requirements.lock` from `wheels.sha256`, and `python pins.py check-lock` must print `locks: ok (39 wheels)`.

`rust/bridge/voice/speech/speak/Dockerfile`:

```dockerfile
# jeeta-voice-speak: EMA Lightning 1.1.2 behind Antalia-2 Mini's normaliser (plan V1-T3 B2).
# Runs with --network none, read-only, as uid 1502 (jeeta-voice-speak) in gid 1501 (jeeta-voice),
# serving /run/jeeta-voice/speak.sock. Build from this directory with speech/pytest.ini copied in.
#
# What is pinned, and how (pins.py has the rules):
# - the base image by digest (python:3.12-slim-bookworm as published on 2026-10-29);
# - every package by version and sha256: torch.lock from PyTorch's CPU index alone and
#   requirements.lock from PyPI alone, --require-hashes --no-deps, wheels only, then `pip check`.
#   `pins.py check-lock` first holds the locks to wheels.sha256 (the first good build's record),
#   to constraints.txt (the frozen set of the image the owner tested) and to requirements.txt;
# - EMA's weights by SHA-256 and size (weights.lock): EMA() reads its repository's main branch and
#   takes no revision, so the build fetches them and refuses a mismatch, and the service checks
#   them again at every start. Antalia's normaliser is code only: no Antalia weights are fetched.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf HF_HUB_DISABLE_TELEMETRY=1
RUN groupadd --gid 1501 jeeta-voice \
 && useradd --uid 1502 --gid 1501 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      jeeta-voice-speak
WORKDIR /app
COPY requirements.txt constraints.txt wheels.sha256 torch.lock requirements.lock pins.py ./
RUN python pins.py check-lock
RUN pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      --index-url https://download.pytorch.org/whl/cpu -r torch.lock --report /tmp/torch.json \
 && pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      --index-url https://pypi.org/simple -r requirements.lock --report /tmp/pypi.json \
 && pip check \
 && python pins.py wheels /tmp/torch.json /tmp/pypi.json --expect wheels.sha256 > wheels.installed \
 && rm /tmp/torch.json /tmp/pypi.json
COPY weights.lock ./
RUN python pins.py fetch-weights
COPY respell.py respell.json jeeta_speak.py ./
# From here on nothing is downloaded; whatever a library caches goes to the run tmpfs.
ENV HF_HUB_OFFLINE=1 XDG_CACHE_HOME=/tmp/cache HOME=/tmp
# Fail the build, not the first call: the weights check, EMA's offline load and the readings the
# owner's test depended on (jeeta_speak.self_test).
RUN python jeeta_speak.py --self-test
COPY pytest.ini ./
COPY tests ./tests
USER 1502:1501
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["python", "jeeta_speak.py", "--health"]
CMD ["python", "jeeta_speak.py"]
```

`rust/bridge/voice/speech/speak/.dockerignore`:

```text
# Only what the Dockerfile copies reaches the daemon (no caches, no stray fixtures).
*
!requirements.txt
!constraints.txt
!wheels.sha256
!torch.lock
!requirements.lock
!pins.py
!weights.lock
!respell.py
!respell.json
!jeeta_speak.py
!pytest.ini
!tests/*.py
```

`rust/bridge/voice/deploy/jeeta-voice-speak.service`:

```ini
[Unit]
Description=Jeeta voice: speak (EMA Lightning behind Antalia's normaliser, no network)
After=docker.service systemd-tmpfiles-setup.service
Requires=docker.service
# A start that keeps failing (the weights check or the readings self-test) stops after five tries
# instead of loading the model every few seconds.
StartLimitIntervalSec=600
StartLimitBurst=5

# No network, read-only, no capability, no core dumps, uid 1502 (jeeta-voice-speak) in gid 1501
# (jeeta-voice). Its socket in /run/jeeta-voice (1770 root:jeeta-voice) is the group's, mode 0660,
# and the sticky directory keeps the listen service (uid 1501) from removing or replacing it. The
# writable paths are that directory and a small /tmp. No swap, so a paged-out model cannot stall a
# sentence. The image must already be on the host (--pull never): it is built there, never pulled.
[Service]
Type=simple
EnvironmentFile=/etc/jeeta-voice/images.env
ExecStartPre=-/usr/bin/docker rm -f jeeta-voice-speak
ExecStart=/usr/bin/docker run --rm --pull never --name jeeta-voice-speak --init --network none \
  --user 1502:1501 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
  --ulimit core=0 --cpus 2 --cpu-shares 2048 --memory 2g --memory-swap 2g \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --tmpfs /tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \
  --mount type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice \
  -e SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock -e SPEAK_THREADS=2 -e SPEAK_BATCH=2 -e EMA_SEED=0 \
  -e SPEAK_WORKERS=2 -e SPEAK_WATCHDOG_S=60 \
  ${SPEAK_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 jeeta-voice-speak
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Commit**

```bash
git add rust/bridge/voice/.gitignore rust/bridge/voice/speech/speak rust/bridge/voice/deploy/jeeta-voice-speak.service
git commit -m "feat(voice): the speak service, EMA Lightning behind Antalia's normaliser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: [COORDINATOR, server] Pin the tested set, build, test, start**

From `/root/jeeta-voice-src` at the reviewed commit. Steps 7.1 and 7.2 run once (done on 2026-10-29); 7.3 onward on every rebuild.

7.1 Freeze the owner-tested package set (the owner's blind test ran on `jeeta-ttstest:tmp`):

```bash
cd /root/jeeta-voice-src/rust/bridge/voice/speech/speak
docker run --rm --network none --entrypoint pip jeeta-ttstest:tmp freeze > constraints.txt
grep -iE '^(ema-lightning|antalia-mini|normalizer-tr|torch|numpy|huggingface-hub|websockets|pytest)==' constraints.txt
grep -E ' @ |^-e' constraints.txt || echo "no local installs"
```

Expected: `ema-lightning==1.1.2`, `antalia-mini==1.0.1`, `torch==…+cpu`, `no local installs`. A different ema-lightning is a stop (the owner chose 1.1.2).

7.2 Check the weights pin against the tested image's model cache:

```bash
docker run --rm --network none -v "$PWD":/check:ro -v /root/voicegate/tts/cache:/cache:ro -e HF_HOME=/cache/hf \
  --entrypoint python jeeta-ttstest:tmp /check/pins.py verify --lock /check/weights.lock
```

Expected: `weights: ok (decoder.pt 9595819b173f, ema.pt 95aec03dafbe)`; `sha256 differs` is a stop (print the tested hashes with `pins.py record`).

7.3 The speak user, once (uid 1502 in the `jeeta-voice` group of B1 Step 8):

```bash
getent passwd 1502 || useradd --system --uid 1502 --gid jeeta-voice --no-create-home --shell /usr/sbin/nologin jeeta-voice-speak
id jeeta-voice-speak
```

Expected: `uid=1502(jeeta-voice-speak) gid=1501(jeeta-voice)`. If 1502 is taken by another account, stop: the image, the unit and the tests name 1502.

7.4 Build:

```bash
cp ../pytest.ini .
TAG=$(date +%Y%m%d%H%M)
time docker build -t jeeta-voice-speak:$TAG .
```

Expected: `locks: ok (39 wheels)`, `Successfully installed torch-2.15.0+cpu`, `No broken requirements found.`, `weights: ok (decoder.pt 9595819b173f, ema.pt 95aec03dafbe)`, `INFO jeeta-speak loaded in … ms: ema-lightning 1.1.2, antalia-mini 1.0.1, normalizer-tr 0.8.1, torch 2.15.0+cpu; seed 0, threads 2, batch 2, voice <id>` and `INFO jeeta-speak self-test passed`. On the first build only (before `wheels.sha256` held the record): `docker run --rm --network none --entrypoint cat jeeta-voice-speak:$TAG /app/wheels.installed > wheels.sha256`, then `python3 pins.py lock` on the dev machine, and commit `constraints.txt`, `wheels.sha256` and both locks.

7.5 Every test in the image, with the unit's isolation:

```bash
docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1502:1501 --cpus 2 --memory 2g --memory-swap 2g --pids-limit 128 --ulimit core=0 \
  --tmpfs /tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \
  jeeta-voice-speak:$TAG python -m pytest -p no:cacheprovider -s -rs tests
```

Expected: `75 passed, 1 skipped` (the skip: the repository's Dockerfile and unit are not in the image) and four `TIMING` lines; record them.

7.6 Install and start (the old socket belongs to the previous uid and the sticky directory keeps the new one from removing it, so root removes it while the service is stopped):

```bash
systemctl stop jeeta-voice-speak 2>/dev/null; rm -f /run/jeeta-voice/speak.sock
grep -q '^SPEAK_IMAGE=' /etc/jeeta-voice/images.env 2>/dev/null \
  && sed -i "s|^SPEAK_IMAGE=.*|SPEAK_IMAGE=jeeta-voice-speak:$TAG|" /etc/jeeta-voice/images.env \
  || printf 'SPEAK_IMAGE=jeeta-voice-speak:%s\n' "$TAG" >> /etc/jeeta-voice/images.env
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-speak.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/jeeta-voice-speak.service
systemctl daemon-reload && systemctl enable --now jeeta-voice-speak
sleep 30
ls -l /run/jeeta-voice/speak.sock; journalctl -u jeeta-voice-speak -n 6 --no-pager
docker ps --filter name=jeeta-voice-speak --format '{{.Names}} {{.Status}}'
docker stats --no-stream --format '{{.Name}} pids {{.PIDs}} mem {{.MemUsage}}' jeeta-voice-speak
stat -c '%a %U:%G %n' /run/jeeta-voice /run/jeeta-voice/speak.sock
docker run --rm --pull never --network none --user 1501:1501 --mount type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice \
  --entrypoint python jeeta-voice-speak:$TAG jeeta_speak.py --health; echo health=$?
docker run --rm --pull never --network none --entrypoint python jeeta-voice-speak:$TAG jeeta_speak.py --voice-id
sudo -u jeeta-voice-bridge test -w /run/jeeta-voice/speak.sock && echo "bridge can connect"
```

Expected: `srw-rw---- 1 jeeta-voice-speak jeeta-voice … speak.sock`; the journal shows `loaded in …`, `warm 0: …`, `warm 1: …`, `listening`, and no text; `Up … (healthy)`; pids under 30 and memory well under 2 GiB (locally, with its two EMA instances: 16 pids, 430 MiB); `1770 root:jeeta-voice /run/jeeta-voice` and `660 jeeta-voice-speak:jeeta-voice …speak.sock`, so uid 1501 can connect (`health=0`) but the sticky bit keeps it from removing the socket (tried on the dev machine: `Operation not permitted`; not tried here, on the live socket); the printed voice id equals the journal's; `bridge can connect`.

**B2 as run (2026-10-29, first round, image `jeeta-voice-speak:202610291512`).**
- Step 7.1: `constraints.txt` frozen from `jeeta-ttstest:tmp`: ema-lightning 1.1.2, antalia-mini 1.0.1, normalizer-tr 0.8.1, torch 2.15.0+cpu, numpy 2.5.4; no local installs; 34 lines. Committed with `wheels.sha256` as d1da6a9d.
- Step 7.2: `weights: ok (decoder.pt 9595819b173f, ema.pt 95aec03dafbe)` against the tested image's cache (`/root/voicegate/tts/cache`, `HF_HOME=/cache/hf`): `weights.lock` is what the owner heard.
- EMA's own batch measurement in the owner-tested cache (`.cache/ema_lightning/batch_size_v2.json`) reads `{"cpu-6": 2}`: the fixed batch 2 is the owner-heard one.
- Step 7.4: built in 1 min 55 s, 1.2 GB, voice `0b26ad0520ff` (the first round's id; the review round's id adds batch, threads and the sentence rules, so it differs), self-test passed.
- Step 7.5: `50 passed, 1 skipped`. TIMING on the host (ms): 8 chars first 244 / synth 244 / audio 520; 28 chars 707 / 710 / 1640; 33 chars 315 / 704 / 2080; 53 chars 381 / 896 / 2840.
- Step 7.6: live. Socket `srw-rw---- jeeta-voice-svc jeeta-voice` (the first round ran as uid 1501); loaded in 5528 ms; warm first audio in 795 ms; healthy; 11 pids, about 501 MiB; `health=0`; the bridge user can connect.

**B2 review (2026-10-29): what changed.** Nothing was blocking; the round:
- I1 cancel contract: the terminal-message rule above (docstring, B5 `Spoken`, B6 `draining`), tests for a cancel after `done`, nothing after `cancelled`, a queued cancel then a third synth.
- I2 concurrency: a real-model test through the session (two connections, two sentences, three rounds each) failed byte for byte against the sentences alone while both streams shared one EMA (batched); each concurrent synthesis now takes an EMA instance of its own from a pool on the event loop, and the test passes.
- I3 self-test: every approved text and each brand, as the model receives them; `MODEL_READS` holds the one difference EMA's frontend makes (it folds the circumflex of "hâlâ"); no "kesme" anywhere; a warning counts symbols Antalia left unread (`[0-9%@#/+]`, a colon by a digit), with no text.
- I4 voice id: batch, threads, the sentence rules and `PIPELINE_VERSION` are in it; `hello` on every connection and `--voice-id`; B5/B6 take the worker's cache key from the hello (no `VOICE_ID`).
- I5 logs: the root filter passes only `jeeta-speak` records (websockets' logger is now outside that name, so it is withheld); warnings and uncaught exceptions by kind and place; a real-model canary ("Ayşe Yılmaz 0532 412 33 08" through respelling, Antalia, EMA and the session at debug level) finds neither the text nor its reading in caplog or the process's output.
- I6 supply chain: two hashed locks, one index each, `--require-hashes --no-deps`, `pip check`; the test stack (pytest, pluggy, iniconfig, pygments) is hash-locked with the rest (pins.py `EXTRA`); `wheels --expect` refuses an unknown hash.
- M1–M10: `RecursionError` answered `bad_request`; NaN and infinities made finite before the cast; the splitter never cuts after the worker's abbreviations (Antalia leaves a lowercase "sn.", "tel." and "st."), with a real-model test over all eighteen; the normalised length is capped; the watchdog; speak as uid 1502; `--mount type=bind`, `--pull never`, `--ulimit core=0`, no lock or table override from the environment; the listed tests, exact unit options; binary messages refused; the freeze gate compares names the way PyPI does (`pins.py check-lock`, which also requires requirements.txt to pin the owner's two choices); the brand table's decision record in the design addendum §10.
- Mutation passes: 53 edits to the service, the respeller, the brand table and pins.py, run on Linux in the image against the pure tests: 51 fail a test. The two that survive are benign: removing the explicit `gen.close()` (CPython closes the generator when the synthesis's frame drops it; kept for clarity) and the respeller's lookup fallback (`.get(key, word)` for `[key]`: unreachable, since every case-insensitive match folds to a table key; kept so an unforeseen fold cannot fail a synthesis). 31 edits to the unit, the Dockerfile, `.dockerignore`, requirements.txt and the locks, run on Windows against the repository tests: all 31 fail. On Windows the unix-socket tests skip, so the `os.chmod`/`os.umask` and not-a-socket edits fail only on Linux.
- Measured on the dev machine (Docker Desktop, `--cpus 2`, this round's image): loaded in about 4 s with two EMA instances, 430 MiB, 16 pids; TIMING 8 chars 189 / 189 / 520 ms, 28 chars 584 / 589 / 1640, 33 chars 256 / 588 / 2080, 53 chars 231 / 722 / 2840. In the first round an 8 s sentence cancelled after its first chunk answered `cancelled` after 2.7 s (the 4 s window under way finishes first): the worker's `FLUSH_MEDIA` cuts the sound at once, but the next sentence on that connection waits that long.

### Task B3: The listen service (Silero VAD, Smart Turn v3.2, seda-v0.1)

**Files (as built):**
- Create: `rust/bridge/voice/speech/listen/{jeeta_listen.py,endpoint.py,hotwords.py,features.py,vad.py,turn.py,asr.py}`
- Create: `rust/bridge/voice/speech/listen/listen_pins.py`, `models.lock` (`python listen_pins.py resolve`)
- Create: `rust/bridge/voice/speech/listen/requirements.txt`; `constraints.txt` and `wheels.sha256` (the bootstrap, Step 8.2); `requirements.lock` (`python listen_pins.py lock`)
- Create: `rust/bridge/voice/speech/listen/Dockerfile`, `.dockerignore`
- Create: `rust/bridge/voice/speech/listen/tests/{test_listen_endpoint,test_listen_hotwords,test_listen_features,test_listen_session,test_listen_protocol,test_listen_pins,test_listen_image,test_listen_models}.py` (named `test_listen_*`, and the pins module `listen_pins.py`, so that one pytest run holds asterisk, speak and listen: D3's `voice-speech` job)
- Create: `rust/bridge/voice/speech/listen/tests/{listen_audio.py,make_fixtures.py,probe_socket.py}`, `tests/fixtures/{yarin,pause,digits,names}.alaw`, `fixtures.json`, `whisper_features.json`
- Create: `rust/bridge/voice/deploy/jeeta-voice-listen.service`
- Modify: `rust/bridge/voice/.gitattributes` (`*.alaw binary`)

**The service in brief** (the module docstring of `jeeta_listen.py` is the contract):
- One WebSocket per call on `/run/jeeta-voice/listen/listen.sock` (listen's own directory: B3 review I4). The server speaks first, `hello{listen_id, sample_rate: 8000, format: "pcm16le"}`; the listen id (12 hex) names the versions, the model digests, the endpoint and decoding rules (`python jeeta_listen.py --listen-id` prints it without loading a model). B6 reads `Heard` with `if let Ok`, so the hello (a type `Heard` lacks) is passed over; B5 may add `Heard::Hello` to log the id.
- `start{sample_rate: 8000, hotwords}` first, then binary PCM16 LE 8 kHz frames (any even length) and `playback{active}` (the echo guard). Out: `speech_start{audio_ms}` (the onset), `speech_end{audio_ms}`, `resume{audio_ms}`, `partial{text}`, `final{text, speech_end_ms, endpoint_ms, endpoint_by, stt_ms}`, `unheard{audio_ms}`, `error{reason}` (`bad_request`, `busy` beyond 4 calls with close 1013, `failed`). Bad hotwords, or hotwords that are not a list, never refuse a start (a refused start would leave the call deaf); a failure while processing audio is answered `failed`, then `unheard` when a turn was open, and the call goes on.
- Turns: Silero at 8 kHz (32 ms chunks; 0.5, 0.6 while the bridge plays and for 400 ms after; a started run and running speech continue down to the threshold less 0.15, Silero's neg_threshold), 200 ms (250) of speech to start, a pause after 200 ms of silence, Smart Turn v3.2 on the turn from 500 ms before its onset (last 8 s), complete at p >= 0.5, else the fallback silence of 1.5 s; while the words end in a number being read out (`endpoint.dictating`: the last word a number word and two of the last three, or four in the turn) the "complete" is not taken and only 2.8 s of silence ends the turn, within the report's 1.2-1.8 s and 2.5-3 s; a turn is cut at 30 s.
- Decoding: seda-v0.1, modified beam search over 4 paths, RNN LM 0.6 with LODR -0.5 (the card's FLEURS-dev scales, sedalib 1.1.0's), one thread; a turn is decoded in segments cut at its pauses, each flushed (0.9 s of silence, sedalib's padding for 0.64 s chunks) on the session's thread while Smart Turn judges on its own, so a "complete" is final at once and a fallback has nothing left to decode.
- Hotwords: up to 20 per call, Turkish-lowercased, circumflexes folded, apostrophes dropped, other punctuation a space; a hotword with a digit or a letter the model lacks is dropped whole (sherpa-onnx's native code prints a hotword it cannot encode, and aborts on a word that starts with ":" or "#" and is not a number). sherpa-onnx cuts them itself (`modeling_unit="bpe"`) over a `piece score` vocabulary the service writes to the run tmpfs from `tokens.txt`, with Zipf scores by rank; `hotwords.Vocab` makes the same cut (held to a byte-level port of simple-sentencepiece 0.7).
- Logs: the root handler passes only `jeeta-listen` records (counts, lengths, timings, kinds); a library's record is withheld and named; never a word, a hotword or audio. A watchdog ends the process when audio processing or the event loop is stuck over 30 s.
- Pins: base image by digest (the speak image's); 13 wheels by version and sha256 from one hashed lock (PyPI alone, `--require-hashes --no-deps`, then `pip check`), held by `listen_pins.py check-lock` to the bootstrap's record, the frozen resolution and the exact requirements; 8 model files by URL (a fixed Hugging Face revision, or a member of the silero-vad wheel), SHA-256 and size, fetched and checked at build and checked again at every start.
- Isolation: `--network none`, read-only, no capability, no core dumps, uid 1501 (`jeeta-voice-svc`, B1 Step 8) in gid 1501, beside speak's uid 1502, its socket in a directory of its own (`/run/jeeta-voice/listen`, 0710, the only one it mounts) so speak cannot bind its name; pids 64, 1.5 CPUs, 1 GB, no swap, `--pull never`, `--mount type=bind`, one BLAS thread.

**B3 as built (2026-10-29): what differs from the draft below.** Steps 1 to 7 below are the first draft; the committed files supersede them, and Step 8 is the server procedure as it now stands.
- No transformers: `features.py` computes Smart Turn's Whisper log-mel features in numpy (as Pipecat does since May 2026), held to values transformers 5.21.0 computed (largest difference over 80 x 800: 1.2e-7). The image drops transformers, tokenizers, huggingface-hub and their dependencies.
- No silero-vad package: it requires torch, so `pip check` fails with it installed `--no-deps`. Its ONNX file is a model in `models.lock`, taken from inside the pinned wheel (wheel and member both hash-checked). `fetch_models.py` became `listen_pins.py` (stdlib-only fetch by URL, B2's lock rules); huggingface-hub is not needed.
- The LM scale: chosen on the dev machine, not on the server. 30 conversational sentences in the speak voice through G.711 A-law (WER / CER without spaces): no LM 8.7 / 1.2 %, LM 0.3 7.6 / 1.2 %, LM 0.5 8.1 / 4.6 %, LM 0.6 14.0 / 9.5 % (whole phrases deleted), LM 0.3 + LODR -0.25 6.4 / 1.0 %, **LM 0.6 + LODR -0.5 5.2 / 1.3 %** (kept), LM 0.8 + LODR -0.5 5.2 / 1.9 %. The draft's LM 0.3 without LODR and its `SEDA_LM_SCALE` knob are gone.
- Hotwords: the draft's greedy cut, passed with sherpa-onnx's default `modeling_unit` (`cjkchar`), would have been split back into single characters, a path the model never emits. As built (above), the cut agrees with the model's own pieces on 40 of 40 words of the fixtures (about 94 % on 30 more sentences on the dev machine), and the boost recovers 2 of 3 names in the names fixture (`selin karaosmanoğlu` for `selim kara osmanoğlu`, `kılıçarslan` for `kılıç arslan`; `Talas` stays `falan`) without changing sentences that hold none; score 2.5 began to damage neighbouring words, so 1.5 stays.
- Turn end: segments cut at pauses, the decode beside the turn model (above), instead of the draft's turn model then the decode; the processing of the frame that ends a turn went from 233-360 ms to 157-203 ms natively on the dev machine. A resumed segment never re-reads decoded speech, and the preroll is 500 ms (Pipecat's pre-speech), not 300.
- Digits: the longer fallback (2.8 s) while the words end in two number words; the draft had none (the review round widened the rule and stopped taking a "complete" while dictating: below).
- Protocol: `hello` first (B2's pattern), `error{reason}`, a session limit, odd or early audio refused once; `speech_start` and `resume` report the onset; the draft's `max_size` of 64 KiB is kept with a 256-message queue.
- Hardening as B2's: uid 1501 (the draft ran as 1501 too, without the named user), `--pull never`, `--mount type=bind`, `--ulimit core=0`, `--cap-drop ALL`, no-new-privileges, pids, no swap, `Restart=always` with a start limit, a health check and a watchdog, `OPENBLAS_NUM_THREADS=1` (numpy's spinning BLAS threads doubled a turn's end under the CPU quota: 511 against 253 ms).
- Fixtures: four A-law files in the speak voice (`make_fixtures.py`, run in the speak image), so the model tests run in the image with no recording mounted; the draft's `LISTEN_FIXTURE_WAV` loop is gone.
- Measured on the dev machine (i5-9300H): natively, streaming RTF 0.08-0.12, the turn-ending frame 156-203 ms, a final 224 ms of audio after the end of speech plus that; in Docker Desktop at `--cpus 1.5` (a noisy VM: the same run gave 266 and 531 ms) 163-531 ms; through the live socket at real time, finals arrived 377-441 ms after the end of speech; 14 pids, about 246 MiB; built in 1 min 33 s, 413 MB. Smart Turn alone: 142 ms on one thread, 83 ms on two. The server's numbers are Step 8.4's TIMING lines.
- Mutation pass: 33 edits to the service, the pins, the Dockerfile, `.dockerignore` and the unit, against the pure tests: all 33 fail a test (two, the socket umask and the models' 0644, only on Linux, where those tests run).

**B3 as run (2026-10-29, first round, image `jeeta-voice-listen:202610291826`, commit `ebbd524c`).**
- Build: 0 min 44 s, 413 MB; `locks: ok (13 wheels)`, `No broken requirements found.`, `models: ok (8 files)`; loaded in 7097 ms (sherpa-onnx 2.0.1, onnxruntime 1.31.1, soxr 1.1.0, numpy 2.5.4), listen `afd024d659de`, self-test passed.
- In the image under the unit's isolation (`--cpus 1.5`): `83 passed, 1 skipped`; `TIMING yarin turn_end_ms=308 stt_ms=223 endpoint_after_speech_ms=224 rtf=0.126`, `TIMING pause turn_end_ms=241,416 rtf=0.186`, `TIMING fallback turn_end_ms=0 stt_ms=408`; `HOTWORDS recovered 2/3; talas heard: False`, `HOTWORDS cut agreement 40/40`.
- Live: healthy, 10 pids, 230 MiB; warm 1500 ms decoded in 225 ms, a turn judged in 176 ms; socket `660 jeeta-voice-svc:jeeta-voice` beside speak's `660 jeeta-voice-speak:jeeta-voice` in `1770 root:jeeta-voice`; `health=0` from uid 1502, the bridge user can connect. Probes: `pause` 2/2 finals 441 ms after the end of speech (stt 94 ms), `names` 3/3 at 492 ms (stt 234 ms). The journal holds counts only.

**B3 review (2026-10-29): what changed.**
- I1, digits: while the words end in numbers being read out, Smart Turn's "complete" is not taken (a digit group sounds finished) and only 2.8 s of silence ends the turn. `dictating` widened: the last word a number word and two of the last three number words, or four or more in the turn, so one misheard digit does not end it. A separate, shorter hold after a "complete" (1.8 s) was considered and not taken: the digits fixture's groups are 2 s apart, as a number read from a card can be, and one rule is one knob (`LISTEN_DIGITS_FALLBACK_MS`). Tests: four digit groups under a turn model that always says complete are one final; the `digits` fixture at the default threshold is one final. The cost: an answer that ends in two number words ("saat on dört") waits about 2.8 s (design §10).
- I2: a failure while processing audio is answered `error{failed}` and then `unheard{audio_ms}` when a turn was open toward the bridge (a `speech_start` out and no final, or the endpointer mid-turn), so the talker asks again instead of waiting.
- I3: the echo guard outlasts `playback{false}` by `guard_tail_ms` = 400 of audio (`LISTEN_GUARD_TAIL_MS`, 200-800), the line's echo of the last sound; playing again within the tail keeps it; a second stop does not stretch it. B7 records the guarded barge-in against the 300 ms alert.
- I4: listen's socket moved into a directory of its own, `/run/jeeta-voice/listen` (0710 `jeeta-voice-svc:jeeta-voice`, tmpfiles), mounted alone into the listen container: the group (speak, the bridge) may reach the socket but create nothing there, and listen no longer sees speak's socket. Tried locally: uid 1502 with speak's mount of `/run/jeeta-voice` could not list, create or bind in `listen/` (Permission denied), and connected (`health=0`). Speak keeps its place in the shared sticky directory for now (it is deployed; it moves with B5). B5's `speech::connect` now checks the peer's uid (listen 1501, speak 1502) and refuses `WrongPeer`. A socket path held by another user, or by something that is not a socket, ends listen once with status 78, which the unit does not restart (`RestartPreventExitStatus=78`): the unit fails and the alert fires instead of a restart loop.
- M1: a segment's end is the audio it was given, so the 30 s cut decodes no frame twice; the cut stays `endpoint_by: "fallback"`: B5's `Heard::Final` reads `jt_calls::EndpointBy`, which has two kinds, and a final the bridge cannot parse would be dropped whole (a third kind means jt_calls, the core's trace and the panel).
- M2: a stream whose hotwords the recognizer refuses goes without them; hotwords are given up only after three refusals.
- M3: hotwords are NFC-composed first; a Linux test pushes 300 rounds of random strings of the model's letters and sherpa-onnx's special characters through `clean` and a real biased stream: native stdout and stderr stay empty.
- M4: hotwords that are not a list are no hotwords; the start is never refused for them.
- M5: tests for the mutants that survived the coordinator's pass (the sample rate check, a failed start's slot, `drop_turn`, `OnlyOurs`, the health check's hello, the contract's values, `stt_ms`, the decoding pins over a stand-in sherpa-onnx, the BLAS and HEALTHCHECK lines, the exact `.dockerignore`).
- M6: `THIRD_PARTY.md` (in the image at `/app`): each model's source, revision, author and licence, unmodified (seda Apache-2.0, its LM CC BY-SA 4.0, Smart Turn BSD-2-Clause, Silero MIT from the wheel's LICENSE), the packages' licences from their wheel metadata (python-soxr LGPL-2.1-or-later), and the fixtures: EMA Lightning and antalia-mini are Apache-2.0, which sets no terms on output, and EMA's voice is itself synthetic; labelled AI-generated as EMA's card asks.
- M7: design §10 notes that `--cpus` may go to 2 on B7's numbers (241-416 ms at 1.5 on the box).
- M8: a download is cut at its pinned size (a wheel or a lookup at 64 MiB); `sys.unraisablehook` logs by kind; a run that has started stays voiced down to the threshold less 0.15 (the onset's hysteresis).
- WER with pauses inside a sentence: ten such sentences (76 words) in the speak voice, decoded in segments and in one stream: 3.9 % both ways, so cutting at pauses cost nothing here. A `multi` fixture (two pauses inside one sentence) holds it in the model tests. At the default threshold Smart Turn ended all ten turns at the first inner pause: each piece was synthesised as a sentence of its own, so it sounds finished; real callers' inner pauses are B7's to measure.
- Smart Turn's probability is pinned on `yarin` and on `pause`'s first turn against the reference pipeline (transformers 5.21.0's features, the model card's call): equal to six decimals (`fixtures/smart_turn_reference.json`).
- Mutation pass over the round: 32 edits, all fail a test; the first pass's 33 still do (two lines were rewritten; the two Linux-only ones as before).
- Tests: Windows 108 passed, 3 skipped; in the image under the unit's isolation 112 passed, 1 skipped. The listen id is `75fd70c20156` (the endpoint config gained the guard's tail).

- [ ] **Step 1: Write the failing pure tests**

`rust/bridge/voice/speech/listen/tests/test_endpoint.py`:

```python
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from endpoint import EndpointConfig, Endpointer  # noqa: E402

VOICED, SILENT = 0.9, 0.1


def feed(e, prob, chunks):
    out = []
    for _ in range(chunks):
        out += e.feed(prob)
    return out


def test_speech_starts_after_the_minimum_speech_and_reports_its_onset():
    e = Endpointer(EndpointConfig())
    assert feed(e, SILENT, 3) == []
    events = feed(e, VOICED, 7)  # 7 x 32 ms = 224 ms >= 200 ms
    assert events == [("speech_start", 96)]


def test_a_complete_turn_ends_on_the_turn_models_verdict():
    e = Endpointer(EndpointConfig())
    feed(e, VOICED, 20)
    events = feed(e, SILENT, 7)  # 224 ms >= 200 ms stop
    assert events == [("pause", 640)]
    assert e.verdict(False) == []
    final = e.verdict(True)
    assert final == [("finalize", {"speech_end_ms": 640, "endpoint_ms": 864, "by": "smart_turn"})]


def test_an_incomplete_turn_ends_on_the_fallback_silence():
    e = Endpointer(EndpointConfig(fallback_ms=1500))
    feed(e, VOICED, 10)
    feed(e, SILENT, 7)
    e.verdict(False)
    events = feed(e, SILENT, 40)  # 47 chunks of silence in all: 1504 ms
    assert events == [("finalize", {"speech_end_ms": 320, "endpoint_ms": 1824, "by": "fallback"})]


def test_speech_after_a_pause_resumes_the_turn():
    e = Endpointer(EndpointConfig())
    feed(e, VOICED, 10)
    feed(e, SILENT, 7)
    assert feed(e, VOICED, 1) == [("resume", 576)]
    assert e.verdict(True) == []


def test_the_echo_guard_raises_the_threshold_and_the_minimum():
    e = Endpointer(EndpointConfig())
    e.guarded = True
    assert feed(e, 0.55, 20) == []
    assert feed(e, VOICED, 7) == []  # 224 ms < 250 ms while guarded
    assert feed(e, VOICED, 1) == [("speech_start", 640)]
```

`rust/bridge/voice/speech/listen/tests/test_hotwords.py`:

```python
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from hotwords import encode, lower_tr  # noqa: E402

VOCAB = {"▁je", "e", "ta", "▁fi", "gu", "ru", "ni", "ca", "▁is", "tan", "bul", "▁a", "hmet"}


def test_turkish_lowercase():
    assert lower_tr("İSTANBUL") == "istanbul"
    assert lower_tr("ISPARTA") == "ısparta"


def test_words_are_cut_into_the_models_pieces_greedily():
    assert encode(["Jeeta"], VOCAB) == "▁je e ta"
    assert encode(["Figurunica", "İstanbul"], VOCAB) == "▁fi gu ru ni ca/▁is tan bul"


def test_a_word_the_vocabulary_cannot_spell_is_dropped():
    assert encode(["Jeeta", "Xq"], VOCAB) == "▁je e ta"
    assert encode([], VOCAB) == ""
```

- [ ] **Step 2: Run them to see them fail**

Run: `python -m pytest -c speech/pytest.ini -m "not models" speech/listen/tests/test_endpoint.py speech/listen/tests/test_hotwords.py`
Expected: FAIL (`ModuleNotFoundError: No module named 'endpoint'`).

- [ ] **Step 3: Write `endpoint.py` and `hotwords.py`**

`rust/bridge/voice/speech/listen/endpoint.py`:

```python
"""When a caller's turn starts and ends (design addendum section 6), from Silero VAD probabilities,
one per 32 ms chunk of 8 kHz audio. Pure: the turn model's verdict is handed in.

Events: ("speech_start", onset_ms) after the minimum speech; ("pause", speech_end_ms) after `stop_ms`
of silence, when the turn model should judge the turn; ("resume", audio_ms) when speech comes back
during the pause; ("finalize", {...}) when the turn ends, by the model's "complete" or after
`fallback_ms` of silence. Times are audio positions in milliseconds since the stream began."""
from dataclasses import dataclass


@dataclass
class EndpointConfig:
    threshold: float = 0.5
    guarded_threshold: float = 0.6
    min_speech_ms: int = 200
    guarded_min_speech_ms: int = 250
    stop_ms: int = 200
    fallback_ms: int = 1500
    smart_turn_threshold: float = 0.5


class Endpointer:
    CHUNK_MS = 32

    def __init__(self, cfg):
        self.cfg = cfg
        self.guarded = False
        self.audio_ms = 0
        self.state = "idle"
        self.voiced_ms = 0
        self.silence_ms = 0
        self.onset_ms = 0
        self.speech_end_ms = 0

    def feed(self, prob):
        self.audio_ms += self.CHUNK_MS
        cfg = self.cfg
        voiced = prob >= (cfg.guarded_threshold if self.guarded else cfg.threshold)
        out = []
        if self.state == "idle":
            if voiced:
                if self.voiced_ms == 0:
                    self.onset_ms = self.audio_ms - self.CHUNK_MS
                self.voiced_ms += self.CHUNK_MS
                need = cfg.guarded_min_speech_ms if self.guarded else cfg.min_speech_ms
                if self.voiced_ms >= need:
                    self.state = "speaking"
                    self.speech_end_ms = self.audio_ms
                    self.silence_ms = 0
                    out.append(("speech_start", self.onset_ms))
            else:
                self.voiced_ms = 0
        elif self.state == "speaking":
            if voiced:
                self.speech_end_ms = self.audio_ms
                self.silence_ms = 0
            else:
                self.silence_ms += self.CHUNK_MS
                if self.silence_ms >= cfg.stop_ms:
                    self.state = "paused"
                    out.append(("pause", self.speech_end_ms))
        elif self.state == "paused":
            if voiced:
                self.state = "speaking"
                self.speech_end_ms = self.audio_ms
                self.silence_ms = 0
                out.append(("resume", self.audio_ms))
            else:
                self.silence_ms += self.CHUNK_MS
                if self.silence_ms >= cfg.fallback_ms:
                    out.append(self._finalize("fallback"))
        return out

    def verdict(self, complete):
        """The turn model's verdict on the pause just reported."""
        if self.state == "paused" and complete:
            return [self._finalize("smart_turn")]
        return []

    def _finalize(self, by):
        event = ("finalize", {"speech_end_ms": self.speech_end_ms, "endpoint_ms": self.audio_ms, "by": by})
        self.state = "idle"
        self.voiced_ms = 0
        self.silence_ms = 0
        return event
```

`rust/bridge/voice/speech/listen/hotwords.py`:

```python
"""Per-call hotwords for sherpa-onnx's contextual biasing. seda ships `tokens.txt` (BPE-500) but no
`bpe.model`, so words are cut into the model's pieces here: lowercase Turkish, a word-start marker
"▁", greedy longest match. A word the vocabulary cannot spell is dropped. Phrases are joined with
"/" as sherpa-onnx's per-stream hotwords expect."""

MARK = "▁"


def lower_tr(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def load_vocab(tokens_path):
    with open(tokens_path, encoding="utf-8") as f:
        return {line.split(" ")[0] for line in f if line.strip()}


def _pieces(word, vocab):
    s = MARK + word
    out = []
    while s:
        for end in range(len(s), 0, -1):
            if s[:end] in vocab:
                out.append(s[:end])
                s = s[end:]
                break
        else:
            return None
    return out


def encode(words, vocab):
    lines = []
    for phrase in words:
        pieces = []
        for word in lower_tr(phrase).split():
            p = _pieces(word, vocab)
            if p is None:
                pieces = None
                break
            pieces += p
        if pieces:
            lines.append(" ".join(pieces))
    return "/".join(lines)
```

- [ ] **Step 4: Run the pure tests**

Run: `python -m pytest -c speech/pytest.ini -m "not models" speech/listen/tests/test_endpoint.py speech/listen/tests/test_hotwords.py`
Expected: `8 passed`.

- [ ] **Step 5: Write the engines and the session, with its test**

`rust/bridge/voice/speech/listen/vad.py`:

```python
"""Silero VAD (ONNX, the file shipped in the silero-vad 6.2.3 wheel) at 8 kHz: 256-sample chunks
with 32 samples of context, as the reference wrapper feeds it."""
import importlib.util
import os

import numpy as np


def model_path():
    spec = importlib.util.find_spec("silero_vad")
    return os.path.join(spec.submodule_search_locations[0], "data", "silero_vad.onnx")


class SileroVad:
    CHUNK = 256
    CONTEXT = 32

    def __init__(self, path=None, threads=1):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(path or model_path(), sess_options=opts,
                                            providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, self.CONTEXT), dtype=np.float32)

    def prob(self, chunk):
        x = np.concatenate([self.context, chunk.reshape(1, -1).astype(np.float32)], axis=1)
        out, self.state = self.session.run(
            None, {"input": x, "state": self.state, "sr": np.array(8000, dtype=np.int64)}
        )
        self.context = x[:, -self.CONTEXT:]
        return float(out[0][0])
```

`rust/bridge/voice/speech/listen/turn.py`:

```python
"""Smart Turn v3.2 (smart-turn-v3.2-cpu.onnx, BSD-2): the probability that the caller finished,
from the turn's last 8 s at 16 kHz, zero-padded at the start as the model card asks."""
import numpy as np

SECONDS = 8
RATE = 16000


class SmartTurn:
    def __init__(self, path, threads=1):
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor

        opts = ort.SessionOptions()
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.features = WhisperFeatureExtractor(chunk_length=SECONDS)

    def complete_probability(self, audio16k):
        n = SECONDS * RATE
        audio = np.asarray(audio16k, dtype=np.float32)[-n:]
        if len(audio) < n:
            audio = np.concatenate([np.zeros(n - len(audio), dtype=np.float32), audio])
        f = self.features(audio, sampling_rate=RATE, return_tensors="np", padding="max_length",
                          max_length=n, truncation=True, do_normalize=True)
        out = self.session.run(None, {"input_features": f.input_features.astype(np.float32)})
        return float(np.asarray(out[0]).reshape(-1)[0])
```

`rust/bridge/voice/speech/listen/asr.py`:

```python
"""seda-v0.1 (atasoglu, Apache-2.0) on sherpa-onnx: streaming Zipformer2 transducer, beam search
with 4 active paths and the shipped RNN LM, one thread per stream, per-stream hotwords."""
import logging
import os

from hotwords import encode, load_vocab

LOG = logging.getLogger("jeeta-listen.asr")
LM_SCALE = float(os.environ.get("SEDA_LM_SCALE", "0.3"))


class Seda:
    def __init__(self, model_dir, threads=1, hotwords_score=1.5):
        import sherpa_onnx

        tokens = os.path.join(model_dir, "tokens.txt")
        self.rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens,
            encoder=os.path.join(model_dir, "encoder.int8.onnx"),
            decoder=os.path.join(model_dir, "decoder.onnx"),
            joiner=os.path.join(model_dir, "joiner.int8.onnx"),
            num_threads=threads,
            sample_rate=16000,
            feature_dim=80,
            decoding_method="modified_beam_search",
            max_active_paths=4,
            hotwords_score=hotwords_score,
            lm=os.path.join(model_dir, "lm", "rnnlm.int8.onnx"),
            lm_scale=LM_SCALE,
            enable_endpoint_detection=False,
        )
        self.vocab = load_vocab(tokens)
        self.hotwords_ok = True

    def stream(self, hotwords):
        encoded = encode(hotwords, self.vocab)
        if encoded and self.hotwords_ok:
            try:
                return self.rec.create_stream(hotwords=encoded)
            except (TypeError, RuntimeError):
                self.hotwords_ok = False
                LOG.warning("hotwords are not accepted by this recognizer; continuing without")
        return self.rec.create_stream()

    def accept(self, stream, samples16k):
        stream.accept_waveform(16000, samples16k)
        while self.rec.is_ready(stream):
            self.rec.decode_stream(stream)

    def text(self, stream):
        r = self.rec.get_result(stream)
        return (r if isinstance(r, str) else getattr(r, "text", "")).strip()

    def finish(self, stream):
        stream.input_finished()
        while self.rec.is_ready(stream):
            self.rec.decode_stream(stream)
        return self.text(stream)
```

`rust/bridge/voice/speech/listen/jeeta_listen.py`:

```python
"""jeeta-listen: the voice bridge's ears (design addendum section 6).

One WebSocket per call on a unix socket (the container runs with --network none):

  client -> {"type": "start", "sample_rate": 8000, "hotwords": ["..."]}
  client -> binary frames: PCM16 little-endian mono 8000 Hz (20 ms each)
  client -> {"type": "playback", "active": true|false}   (echo guard while the bridge speaks)
  server -> {"type": "speech_start", "audio_ms": n} | {"type": "speech_end", "audio_ms": n}
          | {"type": "resume", "audio_ms": n} | {"type": "partial", "text": "..."}
          | {"type": "final", "text": "...", "speech_end_ms": n, "endpoint_ms": n,
             "endpoint_by": "smart_turn"|"fallback", "stt_ms": n}
          | {"type": "unheard", "audio_ms": n}

Positions are audio time since the stream began. The log never carries a word."""
import asyncio
import collections
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from endpoint import EndpointConfig, Endpointer

LOG = logging.getLogger("jeeta-listen")
PREROLL_MS = 300
PARTIAL_EVERY_MS = 160


class Ears:
    """The loaded models, shared by every call."""

    def __init__(self, vad_factory, turn, asr, resampler_factory):
        self.vad_factory = vad_factory
        self.turn = turn
        self.asr = asr
        self.resampler_factory = resampler_factory


def soxr_resampler():
    import soxr

    stream = soxr.ResampleStream(8000, 16000, 1, dtype="float32", quality="HQ")
    return stream.resample_chunk


class Session:
    def __init__(self, ears, hotwords, cfg=None):
        self.ears = ears
        self.cfg = cfg or EndpointConfig()
        self.endpointer = Endpointer(self.cfg)
        self.vad = ears.vad_factory()
        self.resample = ears.resampler_factory()
        self.hotwords = hotwords
        self.pending8 = np.zeros(0, dtype=np.float32)
        self.preroll = collections.deque(maxlen=max(1, PREROLL_MS // 20))
        self.turn16 = []
        self.stream = None
        self.last_partial = ""
        self.since_partial_ms = 0

    def playback(self, active):
        self.endpointer.guarded = bool(active)

    def feed(self, pcm):
        x8 = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        x16 = self.resample(x8)
        events = []
        if self.stream is not None:
            self.ears.asr.accept(self.stream, x16)
            self.turn16.append(x16)
            self.since_partial_ms += len(x8) * 1000 // 8000
        else:
            self.preroll.append(x16)
        self.pending8 = np.concatenate([self.pending8, x8])
        while len(self.pending8) >= 256:
            chunk, self.pending8 = self.pending8[:256], self.pending8[256:]
            for kind, at in self.endpointer.feed(self.vad.prob(chunk)):
                events += self.on(kind, at)
        if self.stream is not None and self.since_partial_ms >= PARTIAL_EVERY_MS:
            self.since_partial_ms = 0
            text = self.ears.asr.text(self.stream)
            if text and text != self.last_partial:
                self.last_partial = text
                events.append({"type": "partial", "text": text})
        return events

    def on(self, kind, at):
        if kind == "speech_start":
            self.stream = self.ears.asr.stream(self.hotwords)
            self.turn16 = list(self.preroll)
            for chunk in self.turn16:
                self.ears.asr.accept(self.stream, chunk)
            self.last_partial = ""
            return [{"type": "speech_start", "audio_ms": at}]
        if kind == "resume":
            return [{"type": "resume", "audio_ms": at}]
        if kind == "pause":
            events = [{"type": "speech_end", "audio_ms": at}]
            audio = np.concatenate(self.turn16) if self.turn16 else np.zeros(0, dtype=np.float32)
            p = self.ears.turn.complete_probability(audio)
            for k, a in self.endpointer.verdict(p >= self.cfg.smart_turn_threshold):
                events += self.on(k, a)
            return events
        if kind == "finalize":
            started = time.monotonic()
            text = self.ears.asr.finish(self.stream) if self.stream is not None else ""
            stt_ms = int((time.monotonic() - started) * 1000)
            self.stream = None
            self.turn16 = []
            self.preroll.clear()
            if not text:
                return [{"type": "unheard", "audio_ms": at["endpoint_ms"]}]
            return [{"type": "final", "text": text, "speech_end_ms": at["speech_end_ms"],
                     "endpoint_ms": at["endpoint_ms"], "endpoint_by": at["by"], "stt_ms": stt_ms}]
        return []


async def serve_session(ws, ears, pool):
    loop = asyncio.get_running_loop()
    session = None
    async for message in ws:
        if isinstance(message, bytes):
            if session is None:
                continue
            events = await loop.run_in_executor(pool, session.feed, message)
            for e in events:
                await ws.send(json.dumps(e, ensure_ascii=False))
            continue
        msg = json.loads(message)
        if msg.get("type") == "start":
            session = Session(ears, list(msg.get("hotwords", []))[:20])
        elif msg.get("type") == "playback" and session is not None:
            session.playback(msg.get("active"))


def build_ears():
    from asr import Seda
    from turn import SmartTurn
    from vad import SileroVad

    models = os.environ.get("LISTEN_MODELS", "/models")
    asr = Seda(os.path.join(models, "seda-v0.1"))
    turn = SmartTurn(os.path.join(models, "smart-turn", "smart-turn-v3.2-cpu.onnx"))
    return Ears(lambda: SileroVad(), turn, asr, soxr_resampler)


async def main():
    from websockets.asyncio.server import unix_serve

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    sock = os.environ.get("LISTEN_SOCKET", "/run/jeeta-voice/listen.sock")
    ears = build_ears()
    pool = ThreadPoolExecutor(max_workers=int(os.environ.get("LISTEN_THREADS", "2")))
    if os.path.exists(sock):
        os.unlink(sock)
    async with unix_serve(lambda ws: serve_session(ws, ears, pool), sock, max_size=2**16):
        os.chmod(sock, 0o660)
        LOG.info("listening")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
```

`rust/bridge/voice/speech/listen/tests/test_session.py`:

```python
"""The session over fake engines: a turn is opened at speech start, judged at the pause, and its
final transcript (or 'unheard') is reported with the audio positions."""
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from jeeta_listen import Ears, Session  # noqa: E402


class LoudVad:
    def prob(self, chunk):
        return 0.9 if float(np.abs(chunk).mean()) > 0.05 else 0.1


class FakeTurn:
    def __init__(self, p):
        self.p = p

    def complete_probability(self, audio):
        return self.p


class FakeAsr:
    def __init__(self, text):
        self.result = text
        self.fed = 0

    def stream(self, hotwords):
        return {"hotwords": hotwords}

    def accept(self, stream, samples):
        self.fed += len(samples)

    def text(self, stream):
        return self.result

    def finish(self, stream):
        return self.result


def frames(loud, ms):
    level = 8000 if loud else 0
    return [np.full(160, level, dtype="<i2").tobytes() for _ in range(ms // 20)]


def run(session, pcm_frames):
    events = []
    for f in pcm_frames:
        events += session.feed(f)
    return events


def ears(text, p):
    return Ears(lambda: LoudVad(), FakeTurn(p), FakeAsr(text), lambda: (lambda x: np.repeat(x, 2)))


def test_a_complete_turn_is_reported_final_with_positions():
    s = Session(ears("evet perşembe uygun", 0.9), ["Jeeta"])
    events = run(s, frames(False, 200) + frames(True, 600) + frames(False, 400))
    kinds = [e["type"] for e in events]
    assert kinds[0] == "speech_start" and "speech_end" in kinds and kinds[-1] == "final"
    final = events[-1]
    assert final["text"] == "evet perşembe uygun"
    assert final["endpoint_by"] == "smart_turn"
    assert final["endpoint_ms"] > final["speech_end_ms"]


def test_no_words_is_reported_unheard():
    s = Session(ears("", 0.9), [])
    events = run(s, frames(True, 600) + frames(False, 400))
    assert events[-1]["type"] == "unheard"


def test_an_incomplete_turn_waits_for_the_fallback():
    s = Session(ears("şey salı günü", 0.1), [])
    events = run(s, frames(True, 600) + frames(False, 1000))
    assert all(e["type"] != "final" for e in events)
    events = run(s, frames(False, 800))
    assert events[-1]["type"] == "final" and events[-1]["endpoint_by"] == "fallback"
```

`rust/bridge/voice/speech/listen/tests/test_models.py`:

```python
"""Runs inside the image on the host. With LISTEN_FIXTURE_WAV (8 kHz mono PCM16 WAV) and
LISTEN_EXPECT (a word the transcript must contain), it transcribes the file through the full session."""
import os
import pathlib
import sys
import wave

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.models


def test_the_models_load_and_silence_is_not_speech():
    from jeeta_listen import Session, build_ears

    s = Session(build_ears(), ["Jeeta"])
    events = []
    for _ in range(100):
        events += s.feed(np.zeros(160, dtype="<i2").tobytes())
    assert events == []


@pytest.mark.skipif(not os.environ.get("LISTEN_FIXTURE_WAV"), reason="no fixture recording")
def test_a_recorded_sentence_is_transcribed():
    from jeeta_listen import Session, build_ears

    s = Session(build_ears(), [])
    with wave.open(os.environ["LISTEN_FIXTURE_WAV"]) as w:
        assert w.getframerate() == 8000 and w.getsampwidth() == 2 and w.getnchannels() == 1
        pcm = w.readframes(w.getnframes())
    pcm += b"\x00\x00" * 8000 * 2  # two seconds of silence after it
    events = []
    for i in range(0, len(pcm), 320):
        events += s.feed(pcm[i:i + 320])
    finals = [e for e in events if e["type"] == "final"]
    assert finals and os.environ["LISTEN_EXPECT"] in finals[-1]["text"]
```

Run: `python -m pytest -c speech/pytest.ini -m "not models" speech/listen/tests`
Expected: `11 passed, 2 deselected`.

- [ ] **Step 6: Pin the model revisions**

`rust/bridge/voice/speech/listen/fetch_models.py`:

```python
"""Downloads the listen models at the revisions in models.lock and checks their SHA-256.
`--resolve` (dev machine, with network) writes models.lock from the repositories' current heads."""
import hashlib
import json
import os
import sys

from huggingface_hub import HfApi, hf_hub_download

FILES = {
    "atasoglu/seda-v0.1": ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt",
                           "lm/rnnlm.int8.onnx"],
    "pipecat-ai/smart-turn-v3": ["smart-turn-v3.2-cpu.onnx"],
}
TARGET = {"atasoglu/seda-v0.1": "seda-v0.1", "pipecat-ai/smart-turn-v3": "smart-turn"}
LOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.lock")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def resolve():
    lock = {}
    for repo, files in FILES.items():
        rev = HfApi().model_info(repo).sha
        lock[repo] = {"revision": rev, "files": {}}
        for name in files:
            path = hf_hub_download(repo, name, revision=rev)
            lock[repo]["files"][name] = sha256(path)
    with open(LOCK, "w", encoding="utf-8") as f:
        json.dump(lock, f, indent=2, sort_keys=True)
        f.write("\n")


def fetch(dest):
    with open(LOCK, encoding="utf-8") as f:
        lock = json.load(f)
    for repo, entry in lock.items():
        for name, digest in entry["files"].items():
            path = hf_hub_download(repo, name, revision=entry["revision"],
                                   local_dir=os.path.join(dest, TARGET[repo]))
            if sha256(path) != digest:
                raise SystemExit(f"checksum mismatch: {repo}/{name}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--resolve"]:
        resolve()
    else:
        fetch(sys.argv[1] if len(sys.argv) > 1 else "/models")
```

Run on the dev machine (network): `pip install huggingface-hub==2.3.0 && python rust/bridge/voice/speech/listen/fetch_models.py --resolve`
Expected: `rust/bridge/voice/speech/listen/models.lock` holds a 40-hex `revision` per repository and a 64-hex digest per file. Inspect it, then commit it in Step 9.

- [ ] **Step 7: Write the image and the unit**

`rust/bridge/voice/speech/listen/requirements.txt`:

```
sherpa-onnx==2.0.1
onnxruntime==1.31.1
transformers==5.21.0
soxr==1.1.0
numpy==2.5.4
websockets==17.3
huggingface-hub==2.3.0
pytest==8.4.2
```

`rust/bridge/voice/speech/listen/Dockerfile`:

```dockerfile
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_DISABLE_TELEMETRY=1
WORKDIR /app
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt \
 && pip install --no-cache-dir --no-deps silero-vad==6.2.3
COPY fetch_models.py models.lock ./
RUN python fetch_models.py /models
COPY endpoint.py hotwords.py vad.py turn.py asr.py jeeta_listen.py ./
COPY tests ./tests
COPY pytest.ini ./pytest.ini
ENV HF_HUB_OFFLINE=1 LISTEN_MODELS=/models
USER 1501:1501
CMD ["python", "jeeta_listen.py"]
```

`rust/bridge/voice/deploy/jeeta-voice-listen.service`:

```ini
[Unit]
Description=Jeeta voice: listen (Silero VAD, Smart Turn v3.2, seda-v0.1; no network)
After=docker.service systemd-tmpfiles-setup.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/jeeta-voice/images.env
ExecStartPre=-/usr/bin/docker rm -f jeeta-voice-listen
ExecStart=/usr/bin/docker run --rm --name jeeta-voice-listen --network none --user 1501:1501 \
  --cpus 1.5 --cpu-shares 2048 --memory 1g --read-only --tmpfs /tmp \
  -v /run/jeeta-voice:/run/jeeta-voice \
  -e LISTEN_SOCKET=/run/jeeta-voice/listen.sock -e LISTEN_THREADS=2 \
  ${LISTEN_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 jeeta-voice-listen
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 8: [COORDINATOR, server] Build, test, start**

From `/root/jeeta-voice-src` at the reviewed commit. Nothing is frozen on the server: the lock and the models lock are committed (Step 8.2 says how to redo them). On a host where the first round ran, 8.1 and 8.2 need nothing; run 8.0, then 8.3 onward.

8.0 Listen's own directory (once; the review round's tmpfiles line):

```bash
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice.tmpfiles /etc/tmpfiles.d/jeeta-voice.conf
systemd-tmpfiles --create /etc/tmpfiles.d/jeeta-voice.conf
stat -c '%a %U:%G %n' /run/jeeta-voice /run/jeeta-voice/listen
```

Expected: `1770 root:jeeta-voice /run/jeeta-voice` and `710 jeeta-voice-svc:jeeta-voice /run/jeeta-voice/listen`.

8.1 The listen user, already there (B1 Step 8 made uid 1501; B2 moved speak to 1502):

```bash
id jeeta-voice-svc; getent passwd 1502
```

Expected: `uid=1501(jeeta-voice-svc) gid=1501(jeeta-voice) groups=1501(jeeta-voice)` and `jeeta-voice-speak:x:1502:1501:...`. If uid 1501 is not `jeeta-voice-svc`, stop: the image, the unit and the tests name 1501.

8.2 Only when a pinned version or model changes (done on the dev machine on 2026-10-29; any Docker host with network will do):

```bash
cd rust/bridge/voice/speech/listen
docker run --rm -v "$PWD":/w -w /w python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 sh -c \
  'pip install --no-cache-dir -q --root-user-action=ignore --only-binary=:all: --index-url https://pypi.org/simple \
     -r requirements.txt --report /tmp/r.json && pip freeze > constraints.txt && python -I listen_pins.py wheels /tmp/r.json > wheels.sha256'
python3 -I listen_pins.py lock && python3 -I listen_pins.py check-lock
python3 -I listen_pins.py resolve   # only when a revision in listen_pins.SOURCES changes
```

Expected: `locks: ok (13 wheels)`; restore the two comment lines at the head of constraints.txt; commit all four files with the change.

8.3 Build:

```bash
cd /root/jeeta-voice-src/rust/bridge/voice/speech/listen
cp ../pytest.ini .
TAG=$(date +%Y%m%d%H%M)
time nice -n 10 docker build -t jeeta-voice-listen:$TAG .
```

Expected: `locks: ok (13 wheels)`, `Successfully installed flatbuffers-25.12.19 ... sherpa-onnx-2.0.1 sherpa-onnx-core-2.0.1 soxr-1.1.0 websockets-17.3`, `No broken requirements found.`, `models: ok (8 files)`, `INFO jeeta-listen loaded in … ms: sherpa-onnx 2.0.1, sherpa-onnx-core 2.0.1, onnxruntime 1.31.1, soxr 1.1.0, numpy 2.5.4; fallback 1500 ms, digits 2800 ms, listen 75fd70c20156` and `INFO jeeta-listen self-test passed`. A `differs from models.lock`, a `larger than` or a `pins:` line is a stop.

8.4 Every test in the image, with the unit's isolation:

```bash
docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1501:1501 --cpus 1.5 --memory 1g --memory-swap 1g --pids-limit 64 --ulimit core=0 \
  --tmpfs /tmp:uid=1501,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \
  jeeta-voice-listen:$TAG python -m pytest -p no:cacheprovider -s -rs tests
```

Expected: `112 passed, 1 skipped` (the skip: the repository's Dockerfile and unit are not in the image), three `TIMING` lines, two `HOTWORDS` lines (`recovered 2/3; talas heard: False`, `cut agreement 40/40`) and `WER multi: segments 0/9 words wrong, one stream 0/9`; record them. The hotword fuzz runs here only (Linux) and must pass: it fails if sherpa-onnx prints anything. A failing model test is a stop-and-report, not a tuning round on the server.

8.5 Install and start (the first round's socket sits at the old path, `/run/jeeta-voice/listen.sock`; root removes it while the service is stopped):

```bash
systemctl stop jeeta-voice-listen 2>/dev/null; rm -f /run/jeeta-voice/listen.sock /run/jeeta-voice/listen/listen.sock
grep -q '^LISTEN_IMAGE=' /etc/jeeta-voice/images.env \
  && sed -i "s|^LISTEN_IMAGE=.*|LISTEN_IMAGE=jeeta-voice-listen:$TAG|" /etc/jeeta-voice/images.env \
  || printf 'LISTEN_IMAGE=jeeta-voice-listen:%s\n' "$TAG" >> /etc/jeeta-voice/images.env
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-listen.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/jeeta-voice-listen.service
systemctl daemon-reload && systemctl enable --now jeeta-voice-listen
sleep 30
ls -l /run/jeeta-voice/listen/listen.sock; journalctl -u jeeta-voice-listen -n 5 --no-pager
docker ps --filter name=jeeta-voice-listen --format '{{.Names}} {{.Status}}'
docker stats --no-stream --format '{{.Name}} pids {{.PIDs}} mem {{.MemUsage}}' jeeta-voice-listen
stat -c '%a %U:%G %n' /run/jeeta-voice /run/jeeta-voice/listen /run/jeeta-voice/listen/listen.sock /run/jeeta-voice/speak.sock
docker run --rm --pull never --network none --user 1502:1501 --mount type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice \
  --entrypoint sh jeeta-voice-listen:$TAG -c \
  'python jeeta_listen.py --health; echo health=$?; touch /run/jeeta-voice/listen/x 2>&1 | grep -c "Permission denied"'
docker run --rm --pull never --network none --entrypoint python jeeta-voice-listen:$TAG jeeta_listen.py --listen-id
sudo -u jeeta-voice-bridge test -w /run/jeeta-voice/listen/listen.sock && echo "bridge can connect"
docker exec jeeta-voice-listen ls /run/jeeta-voice
```

Expected: `srw-rw---- 1 jeeta-voice-svc jeeta-voice … listen.sock`; the journal shows `loaded in … listen 75fd70c20156`, `warm: 1500 ms decoded in … ms, a turn judged in … ms`, `listening`, and no word; `Up … (healthy)`; pids under 30 and memory well under 1 GiB (first round: 10 pids, 230 MiB); `1770 root:jeeta-voice /run/jeeta-voice`, `710 jeeta-voice-svc:jeeta-voice /run/jeeta-voice/listen`, `660 jeeta-voice-svc:jeeta-voice …listen.sock` and speak's `660 jeeta-voice-speak:jeeta-voice …speak.sock` unchanged; `health=0` and `1` (uid 1502 connects through the group and cannot create a file in listen's directory); the printed listen id equals the journal's; `bridge can connect`; the last line is `listen` alone (the container sees its own directory, not speak's socket).

8.6 A call through the live socket (numbers only), and the journal after it:

```bash
for f in pause names; do
  docker run --rm --pull never --network none --user 1502:1501 --mount type=bind,source=/run/jeeta-voice,target=/run/jeeta-voice \
    --entrypoint python jeeta-voice-listen:$TAG tests/probe_socket.py $f
done
journalctl -u jeeta-voice-listen -n 4 --no-pager
```

Expected: `2/2 sentences final` and `3/3 sentences final`, each final `by smart_turn` and a few hundred ms after the end of speech (first round: 441 and 492 ms); the journal shows `a call started: 0 hotwords (0 dropped)` and `a call ended after … s: … turns (… by smart turn, … by fallback, 0 unheard)`, no word.

- [ ] **Step 9: Commit**

```bash
git add rust/bridge/voice/.gitattributes rust/bridge/voice/speech/listen rust/bridge/voice/deploy/jeeta-voice-listen.service
git commit -m "feat(voice): the listen service, Silero VAD, Smart Turn v3.2 and seda-v0.1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task B4: The worker crate and its pure modules

**Files:**
- Create: `rust/bridge/voice/Cargo.toml`
- Create: `rust/bridge/voice/src/lib.rs`
- Create: `rust/bridge/voice/src/g711.rs`, `src/text.rs`, `src/netgsm.rs`, `src/talker.rs`
- Create: `rust/bridge/voice/tests/g711.rs`, `tests/text.rs`, `tests/netgsm.rs`, `tests/talker.rs`, `tests/logging.rs`
- Modify: `rust/Cargo.toml` (member `bridge/voice`; `tokio-tungstenite = "0.30"`)
- Modify: `rust/deny.toml` (the `reqwest` wrappers; `tokio-tungstenite`)
- Modify: `rust/crates/jt_archtest/tests/dependency_boundaries.rs`

- [ ] **Step 1: Write the failing boundary test**

Append to `rust/crates/jt_archtest/tests/dependency_boundaries.rs`:

```rust
/// The voice bridge (`bridge/voice`) is a program of its own beside the server, on the same host:
/// it reaches Jeeta, Asterisk and the speech services over loopback only, and builds and tests on
/// Windows. So no section of its manifest names a workspace crate but the calls domain (`jt_calls`,
/// pure, whose wire it speaks): not `jt_pg`, not `jt_app`, no adapter.
#[test]
fn voice_bridge_depends_on_no_server_crate() {
    const BRIDGE: &str = "jeeta-voice-bridge";
    let metadata = metadata();
    let bridge = metadata["packages"]
        .as_array()
        .expect("`cargo metadata` has no `packages` array")
        .iter()
        .find(|p| p["name"] == BRIDGE)
        .expect("jeeta-voice-bridge is a workspace package");
    let workspace = workspace_packages();
    let named: BTreeSet<&str> = bridge["dependencies"]
        .as_array()
        .expect("package has no `dependencies` array")
        .iter()
        .map(|d| d["name"].as_str().expect("dependency has no `name`"))
        .collect();
    for d in &named {
        assert!(
            !workspace.contains(*d) || *d == "jt_calls",
            "{BRIDGE} depends on {d}: the bridge names no server crate"
        );
        assert_ne!(*d, "sqlx", "{BRIDGE} depends on sqlx");
    }
    let deps = direct_deps(BRIDGE);
    for needed in ["jt_calls", "reqwest", "tokio-tungstenite"] {
        assert!(deps.contains(needed), "{BRIDGE} lost its {needed} dependency");
    }
}
```

In `no_crate_but_outbound_names_reqwest`, change the list and the count:

```rust
    const OWN_CLIENT: &[&str] = &["jt_outbound", "jeeta-device-bridge", "jeeta-voice-bridge"];
```

```rust
    // Every crate but the four: not vacuous.
    assert_eq!(checked, workspace_packages().len() - 4);
```

and extend that test's doc comment with: "And the voice bridge (`jeeta-voice-bridge`, design addendum 2026-10-29), whose HTTP peers are Jeeta's and Asterisk's loopback addresses."

- [ ] **Step 2: Run it to see it fail (CI)**

CI `rust-test` (Linux): `cargo test --locked -p jt_archtest --test dependency_boundaries`
Expected: FAIL `jeeta-voice-bridge is a workspace package`. (On Windows `jt_archtest` does not build; push nothing yourself, the coordinator reads CI after Step 9.)

- [ ] **Step 3: Create the crate**

`rust/Cargo.toml`: add `"bridge/voice",` after `"bridge/device",` in `members`, and under `# Third-party crates`:

```toml
# The voice bridge's WebSocket client (Asterisk's events and media, the local speech services);
# only jeeta-voice-bridge may name it (deny.toml, archtest).
tokio-tungstenite = "0.30"
```

`rust/bridge/voice/Cargo.toml`:

```toml
[package]
name = "jeeta-voice-bridge"
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

# The talker beside Asterisk on the Jeeta host (design addendum 2026-10-29-voice-sidecar-free-path).
# A program of its own: it reaches Jeeta, ARI and the speech services over loopback, and names no
# server crate, only the calls domain whose wire it speaks (archtest).
[dependencies]
jt_calls.workspace = true
tokio = { workspace = true, features = ["time", "net", "io-util", "fs"] }
tokio-tungstenite.workspace = true
futures-util.workspace = true
# The bridge's own HTTP client to Jeeta and ARI, both on loopback.
reqwest.workspace = true
serde.workspace = true
serde_json.workspace = true
time.workspace = true
uuid.workspace = true
sha2.workspace = true
hex.workspace = true
base64.workspace = true
thiserror.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true

[dev-dependencies]
# The fake Jeeta and fake ARI of the tests.
axum.workspace = true
tokio = { workspace = true, features = ["test-util"] }

[lints]
workspace = true
```

`rust/deny.toml`: replace the `reqwest` line and add the WebSocket client:

```toml
  { crate = "reqwest", wrappers = ["jt_outbound", "jeeta-device-bridge", "jeeta-voice-bridge"] },
  { crate = "tokio-tungstenite", wrappers = ["jeeta-voice-bridge"] },
```

and extend the comment above `deny = [` with: "The voice bridge, a program beside the server whose peers are Jeeta's and Asterisk's loopback addresses, has its own HTTP and WebSocket clients too."

`rust/bridge/voice/src/lib.rs`:

```rust
//! `jeeta-voice-bridge`: the talker beside Asterisk (design addendum
//! `docs/superpowers/specs/2026-10-29-voice-sidecar-free-path-design.md`). It registers the
//! workspace's line with Jeeta, takes the commands queued for its calls, drives each call through
//! Asterisk (ARI and `chan_websocket` media) and the local speech services, and reports what
//! happened, as the voice bridge protocol of `jt_calls::wire` says.
//!
//! - [`g711`], [`text`], [`netgsm`]: codecs, sentences and the line's dialling rules (pure).
//! - [`talker`]: one call's state machine: openings, turns, barge-in, acknowledgements and
//!   fillers, closing (pure).
//!
//! # Logging
//!
//! Call ids, command ids and kinds, states, counts, durations and error kinds. Never a phone
//! number, a transcript, a sentence, audio, an audio path holding a number, the key or a password;
//! an HTTP error is logged without its URL (`tests/logging.rs` checks the log calls).

pub mod g711;
pub mod netgsm;
pub mod talker;
pub mod text;
```

- [ ] **Step 4: Write the failing pure tests**

`rust/bridge/voice/tests/g711.rs`:

```rust
use jeeta_voice_bridge::g711::{Codec, alaw_decode, alaw_encode, ulaw_decode, ulaw_encode};

#[test]
fn silence_has_its_known_code_words() {
    assert_eq!(ulaw_encode(0), 0xFF);
    assert_eq!(ulaw_decode(0xFF), 0);
    assert_eq!(alaw_encode(0), 0xD5);
    assert_eq!(alaw_decode(0xD5), 8);
}

#[test]
fn every_sample_survives_a_round_trip_within_the_step() {
    for x in (i16::MIN..=i16::MAX).step_by(7) {
        let bound = i32::from(x).unsigned_abs() as i32 / 16 + 16;
        let u = i32::from(ulaw_decode(ulaw_encode(x)));
        let a = i32::from(alaw_decode(alaw_encode(x)));
        assert!((u - i32::from(x)).abs() <= bound + 32, "ulaw {x} -> {u}");
        assert!((a - i32::from(x)).abs() <= bound + 32, "alaw {x} -> {a}");
    }
}

#[test]
fn a_frame_is_160_bytes_both_ways() {
    let pcm = vec![1000i16; 160];
    for codec in [Codec::Alaw, Codec::Ulaw] {
        let bytes = codec.encode(&pcm);
        assert_eq!(bytes.len(), 160);
        assert_eq!(codec.decode(&bytes).len(), 160);
    }
    assert_eq!(Codec::from_format("alaw"), Some(Codec::Alaw));
    assert_eq!(Codec::from_format("ulaw"), Some(Codec::Ulaw));
    assert_eq!(Codec::from_format("slin16"), None);
}
```

`rust/bridge/voice/tests/text.rs`:

```rust
use jeeta_voice_bridge::text::{heard_chars, is_backchannel, sentences};

fn texts(t: &str) -> Vec<String> {
    sentences(t).into_iter().map(|s| s.text).collect()
}

#[test]
fn a_text_is_cut_at_its_sentence_ends() {
    assert_eq!(
        texts("Merhaba, ben Acme'nin dijital asistanıyım. Görüşmemiz yazıya dökülmektedir. Ada Hanım ile mi görüşüyorum?"),
        [
            "Merhaba, ben Acme'nin dijital asistanıyım.",
            "Görüşmemiz yazıya dökülmektedir.",
            "Ada Hanım ile mi görüşüyorum?",
        ]
    );
}

#[test]
fn numbers_times_and_abbreviations_stay_whole() {
    assert_eq!(
        texts("Tutar 1.250 TL. Saat 14.30'da Dr. Ahmet bekliyor! Tamam mı?"),
        ["Tutar 1.250 TL.", "Saat 14.30'da Dr. Ahmet bekliyor!", "Tamam mı?"]
    );
    assert_eq!(texts("Randevunuz 14:00'e."), ["Randevunuz 14:00'e."]);
}

#[test]
fn offsets_are_characters_of_the_original_text() {
    let s = sentences("Öğle. İkindi.");
    assert_eq!((s[0].start, s[0].end), (0, 5));
    assert_eq!((s[1].start, s[1].end), (6, 13));
}

#[test]
fn a_very_long_sentence_is_cut_at_a_comma() {
    let long = format!("{}, ve devamı.", "kelime ".repeat(40).trim_end());
    let parts = sentences(&long);
    assert_eq!(parts.len(), 2);
    assert!(parts[0].text.ends_with(','));
}

#[test]
fn heard_characters_count_finished_sentences_and_the_share_of_the_current_one() {
    let s = sentences("Bir iki. Üç dört beş.");
    assert_eq!(heard_chars(&s, 0, 0.0), 0);
    assert_eq!(heard_chars(&s, 1, 0.0), 9);
    assert_eq!(heard_chars(&s, 1, 0.5), 15);
    assert_eq!(heard_chars(&s, 2, 0.0), 21);
}

#[test]
fn backchannel_words_alone_are_an_acknowledgement() {
    assert!(is_backchannel("hı hı"));
    assert!(is_backchannel("evet evet tamam"));
    assert!(!is_backchannel("evet ama yarın olmaz"));
    assert!(!is_backchannel(""));
}
```

`rust/bridge/voice/tests/netgsm.rs`:

```rust
use jeeta_voice_bridge::netgsm::{dial_string, hangup_cause};

#[test]
fn only_turkish_numbers_are_dialled_in_national_form() {
    assert_eq!(dial_string("+905321234567").as_deref(), Some("05321234567"));
    assert_eq!(dial_string("+902125550000").as_deref(), Some("02125550000"));
    assert_eq!(dial_string("+4915112345678"), None);
    assert_eq!(dial_string("+90532"), None);
    assert_eq!(dial_string("05321234567"), None);
}

#[test]
fn q850_causes_map_to_the_cores_words() {
    assert_eq!(hangup_cause(Some(16), true), "normal");
    assert_eq!(hangup_cause(Some(17), false), "busy");
    assert_eq!(hangup_cause(Some(21), false), "busy");
    assert_eq!(hangup_cause(Some(19), false), "no_answer");
    assert_eq!(hangup_cause(Some(34), false), "congestion");
    assert_eq!(hangup_cause(Some(1), false), "failed");
    assert_eq!(hangup_cause(None, false), "no_answer");
}
```

`rust/bridge/voice/tests/talker.rs`:

```rust
//! One call's talker against a scripted clock (design addendum §3).
use jeeta_voice_bridge::talker::{Action, Input, Source, Talker, Timing};
use jt_calls::{BridgePhrases, PhraseSet};

fn talker() -> Talker {
    Talker::new(Timing::default(), BridgePhrases::default())
}

fn plays(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Play(item) => Some(item.text.clone()),
            _ => None,
        })
        .collect()
}

/// Every item `actions` started plays to its end at `now`.
fn finish(t: &mut Talker, actions: &[Action], now: u64) -> Vec<Action> {
    let mut out = Vec::new();
    for a in actions {
        if let Action::Play(item) = a {
            out.extend(t.on(Input::Played { id: item.id }, now));
        }
    }
    out
}

fn say(seq: u32, text: &str) -> Input {
    Input::Speak { seq, text: text.into(), barge_in: true, agent: true }
}

#[test]
fn an_acknowledgement_plays_600_ms_after_the_callers_turn() {
    let mut t = talker();
    t.on(Input::Final, 1_000);
    assert!(plays(&t.on(Input::Tick, 1_580)).is_empty());
    let a = t.on(Input::Tick, 1_600);
    assert_eq!(plays(&a), ["Hı hı."]);
    assert!(a.contains(&Action::EchoGuard(true)));
}

#[test]
fn no_acknowledgement_when_the_reply_came_first() {
    let mut t = talker();
    t.on(Input::Final, 1_000);
    assert_eq!(plays(&t.on(say(7, "Perşembe uygun."), 1_400)), ["Perşembe uygun."]);
    assert!(plays(&t.on(Input::Tick, 1_700)).is_empty());
    assert!(plays(&t.on(Input::Tick, 4_000)).is_empty());
}

#[test]
fn a_filler_then_the_long_wait_cover_a_slow_reply_and_rotate_next_time() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let ack = t.on(Input::Tick, 600);
    assert_eq!(plays(&ack), ["Hı hı."]);
    finish(&mut t, &ack, 1_100);
    let filler = t.on(Input::Tick, 2_700);
    assert_eq!(plays(&filler), ["Bir saniye, hemen bakıyorum."]);
    finish(&mut t, &filler, 4_500);
    let long = t.on(Input::Tick, 8_000);
    assert_eq!(plays(&long), ["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]);
    finish(&mut t, &long, 11_000);
    assert!(plays(&t.on(Input::Tick, 15_000)).is_empty());
    t.on(Input::Final, 20_000);
    assert_eq!(plays(&t.on(Input::Tick, 20_600)), ["Anladım."]);
}

#[test]
fn two_phrases_never_play_within_a_second() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let ack = t.on(Input::Tick, 600);
    finish(&mut t, &ack, 2_500);
    assert!(plays(&t.on(Input::Tick, 2_700)).is_empty());
    assert_eq!(plays(&t.on(Input::Tick, 3_500)), ["Bir saniye, hemen bakıyorum."]);
}

#[test]
fn the_caller_cuts_the_agent_and_the_queue_is_dropped() {
    let mut t = talker();
    t.on(say(3, "Uzun bir cümle."), 0);
    t.on(say(4, "İkinci cümle."), 10);
    let cut = t.on(Input::SpeechStart, 500);
    let (item, dropped) = cut
        .iter()
        .find_map(|a| match a {
            Action::Cut { item, dropped } => Some((item.clone(), dropped.clone())),
            _ => None,
        })
        .expect("a cut");
    assert_eq!(item.source, Source::Core { seq: 3, agent: true });
    assert_eq!(dropped.len(), 1);
    assert!(cut.contains(&Action::EchoGuard(false)));
}

#[test]
fn a_sentence_that_asks_to_be_heard_through_is_not_cut() {
    let mut t = talker();
    t.on(Input::Speak { seq: 3, text: "Önemli bilgi.".into(), barge_in: false, agent: true }, 0);
    let a = t.on(Input::SpeechStart, 500);
    assert!(!a.iter().any(|x| matches!(x, Action::Cut { .. })));
}

#[test]
fn the_caller_is_asked_once_whether_they_are_still_there() {
    let mut t = talker();
    let a = t.on(say(5, "Hangi gün uygun?"), 0);
    finish(&mut t, &a, 2_000);
    assert!(plays(&t.on(Input::Tick, 10_900)).is_empty());
    assert_eq!(plays(&t.on(Input::Tick, 11_000)), ["Hâlâ orada mısınız?"]);
    let again = t.on(Input::Tick, 30_000);
    assert!(plays(&again).is_empty());
}

#[test]
fn unheard_words_are_asked_again_only_when_nothing_is_owed() {
    let mut t = talker();
    assert_eq!(plays(&t.on(Input::Unheard, 100)), ["Sizi tam duyamadım, tekrar eder misiniz?"]);
    let mut t = talker();
    t.on(Input::Final, 0);
    assert!(plays(&t.on(Input::Unheard, 100)).is_empty());
}

#[test]
fn the_closing_plays_to_its_end_then_the_line_is_hung_up() {
    let mut t = talker();
    let a = t.on(
        Input::Speak { seq: 9, text: "Görüşmek üzere, iyi günler.".into(), barge_in: true, agent: false },
        0,
    );
    assert!(!t.on(Input::HangupWhenDone, 5).contains(&Action::Hangup));
    let done = finish(&mut t, &a, 3_000);
    assert!(done.contains(&Action::Hangup));
    assert!(t.on(Input::Tick, 3_020).is_empty());
}

#[test]
fn losing_the_core_plays_the_fault_sentence_and_hangs_up() {
    let mut t = talker();
    t.on(Input::Speak { seq: 3, text: "Bir şey.".into(), barge_in: false, agent: true }, 0);
    let lost = t.on(Input::CoreLost, 100);
    assert!(lost.iter().any(|a| matches!(a, Action::Cut { .. })));
    assert_eq!(
        plays(&lost),
        ["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."]
    );
    assert!(finish(&mut t, &lost, 5_000).contains(&Action::Hangup));
}

#[test]
fn nothing_starts_while_the_caller_is_speaking() {
    let mut t = talker();
    t.on(Input::SpeechStart, 0);
    assert!(plays(&t.on(say(2, "Evet."), 100)).is_empty());
    assert_eq!(plays(&t.on(Input::SpeechEnd, 300)), ["Evet."]);
}

#[test]
fn a_phrase_is_reported_by_its_set_and_index() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let a = t.on(Input::Tick, 600);
    let Some(Action::Play(item)) = a.iter().find(|x| matches!(x, Action::Play(_))) else {
        panic!("a phrase");
    };
    assert_eq!(item.source, Source::Phrase { set: PhraseSet::Acknowledgement, index: 0 });
}
```

`rust/bridge/voice/tests/logging.rs`:

```rust
//! No log call of the bridge names a phone number, a text, a key or a password (lib.rs, Logging).
use std::path::Path;

const MACROS: [&str; 5] = ["info!(", "warn!(", "error!(", "debug!(", "trace!("];
const FORBIDDEN: [&str; 11] = [
    "text", "e164", "to_e164", "dial", "transcript", "password", "key", "body", "url", "phone", "number",
];

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

#[test]
fn no_log_call_names_a_number_a_text_or_a_secret() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in files.into_iter().filter(|p| p.extension().is_some_and(|e| e == "rs")) {
        let code = std::fs::read_to_string(&file).unwrap();
        for m in MACROS {
            let mut rest = code.as_str();
            while let Some(at) = rest.find(m) {
                let call = &rest[at..];
                let end = call.find(");").unwrap_or(call.len());
                for w in words(&call[..end]) {
                    assert!(
                        !FORBIDDEN.contains(&w.as_str()),
                        "{}: a log call names `{w}`: {}",
                        file.display(),
                        &call[..end]
                    );
                }
                checked += 1;
                rest = &call[m.len()..];
            }
        }
    }
    // Not vacuous once the run loop exists (task D2): it logs.
    assert!(checked > 0 || !dir.join("run_loop.rs").exists(), "no log call found");
}
```

Run (Windows works): `cargo test -p jeeta-voice-bridge`
Expected: FAIL to compile (`could not find g711 in jeeta_voice_bridge` …).

- [ ] **Step 5: Write `g711.rs`**

```rust
//! G.711 A-law and μ-law (ITU-T G.711), the line's codecs: one byte per 8 kHz sample, 160 bytes a
//! 20 ms frame. Asterisk's `MEDIA_START` names which one the call uses.

/// The codec of a call's media.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Alaw,
    Ulaw,
}

impl Codec {
    /// The codec of an Asterisk format name (`alaw`, `ulaw`).
    pub fn from_format(format: &str) -> Option<Codec> {
        match format {
            "alaw" => Some(Codec::Alaw),
            "ulaw" => Some(Codec::Ulaw),
            _ => None,
        }
    }

    pub fn encode(self, pcm: &[i16]) -> Vec<u8> {
        match self {
            Codec::Alaw => pcm.iter().map(|s| alaw_encode(*s)).collect(),
            Codec::Ulaw => pcm.iter().map(|s| ulaw_encode(*s)).collect(),
        }
    }

    pub fn decode(self, bytes: &[u8]) -> Vec<i16> {
        match self {
            Codec::Alaw => bytes.iter().map(|b| alaw_decode(*b)).collect(),
            Codec::Ulaw => bytes.iter().map(|b| ulaw_decode(*b)).collect(),
        }
    }
}

const ULAW_BIAS: i32 = 0x84;
const ULAW_CLIP: i32 = 32_635;

pub fn ulaw_encode(sample: i16) -> u8 {
    let mut pcm = i32::from(sample);
    let sign = if pcm < 0 {
        pcm = -pcm;
        0x80
    } else {
        0
    };
    pcm = pcm.min(ULAW_CLIP) + ULAW_BIAS;
    let mut exponent = 7;
    let mut mask = 0x4000;
    while exponent > 0 && pcm & mask == 0 {
        exponent -= 1;
        mask >>= 1;
    }
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    !((sign | (exponent << 4) | mantissa) as u8)
}

pub fn ulaw_decode(byte: u8) -> i16 {
    let u = !byte;
    let exponent = i32::from((u >> 4) & 0x07);
    let mantissa = i32::from(u & 0x0F);
    let magnitude = (((mantissa << 3) + ULAW_BIAS) << exponent) - ULAW_BIAS;
    (if u & 0x80 != 0 { -magnitude } else { magnitude }) as i16
}

const ALAW_SEGMENT_END: [i32; 8] = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];

pub fn alaw_encode(sample: i16) -> u8 {
    let mut pcm = i32::from(sample) >> 3;
    let mask = if pcm >= 0 {
        0xD5
    } else {
        pcm = -pcm - 1;
        0x55
    };
    let segment = ALAW_SEGMENT_END.iter().position(|end| pcm <= *end).unwrap_or(8) as i32;
    if segment >= 8 {
        return (0x7F ^ mask) as u8;
    }
    let mut value = segment << 4;
    value |= if segment < 2 { (pcm >> 1) & 0x0F } else { (pcm >> segment) & 0x0F };
    (value ^ mask) as u8
}

pub fn alaw_decode(byte: u8) -> i16 {
    let a = i32::from(byte ^ 0x55);
    let mut t = (a & 0x0F) << 4;
    let segment = (a & 0x70) >> 4;
    match segment {
        0 => t += 8,
        1 => t += 0x108,
        _ => {
            t += 0x108;
            t <<= segment - 1;
        }
    }
    (if a & 0x80 != 0 { t } else { -t }) as i16
}
```

- [ ] **Step 6: Write `text.rs` and `netgsm.rs`**

`rust/bridge/voice/src/text.rs`:

```rust
//! Sentences of a text to speak, with their character offsets (so a cut can say how much was
//! heard), and the caller's acknowledgement words. Synthesis and the phrase cache work sentence by
//! sentence; a number, a clock time or an abbreviation is never split.

/// A sentence: characters `[start, end)` of the original text, and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sentence {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

const ABBREVIATIONS: [&str; 18] = [
    "dr", "sn", "av", "prof", "doç", "yrd", "no", "tel", "vb", "vs", "ltd", "şti", "cad", "sok", "mah",
    "apt", "bul", "st",
];
/// A sentence longer than this is cut at its next comma.
const MAX_SENTENCE_CHARS: usize = 220;
const BACKCHANNEL: [&str; 19] = [
    "hı", "hıhı", "ıhı", "hı-hı", "evet", "tamam", "aynen", "he", "hee", "anladım", "peki", "tabii",
    "tabi", "olur", "ha", "hm", "hmm", "ok", "okey",
];

fn lower_tr(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'I' => 'ı',
            'İ' => 'i',
            _ => c.to_lowercase().next().unwrap_or(c),
        })
        .collect()
}

fn ends_abbreviation(chars: &[char], start: usize, dot: usize) -> bool {
    let word: String = chars[start..dot]
        .iter()
        .rev()
        .take_while(|c| c.is_alphabetic())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    !word.is_empty() && ABBREVIATIONS.contains(&lower_tr(&word).as_str())
}

fn push(out: &mut Vec<Sentence>, chars: &[char], mut start: usize, mut end: usize) {
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    if start < end {
        out.push(Sentence { start, end, text: chars[start..end].iter().collect() });
    }
}

/// `text` cut after `.`, `!`, `?` and `…` followed by a space or the end, except after an
/// abbreviation; a sentence past 220 characters is also cut after its next comma.
pub fn sentences(text: &str) -> Vec<Sentence> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..chars.len() {
        let at_break = i + 1 >= chars.len() || chars[i + 1].is_whitespace();
        let mark = matches!(chars[i], '.' | '!' | '?' | '…');
        let sentence_end = mark && at_break && !(chars[i] == '.' && ends_abbreviation(&chars, start, i));
        let long_comma = chars[i] == ',' && at_break && i + 1 - start >= MAX_SENTENCE_CHARS;
        if sentence_end || long_comma {
            push(&mut out, &chars, start, i + 1);
            start = i + 1;
        }
    }
    push(&mut out, &chars, start, chars.len());
    out
}

/// How many characters of the text the caller heard: every sentence before `finished` (the
/// sentences whose end was reported played) and `fraction` of sentence `finished`.
pub fn heard_chars(sentences: &[Sentence], finished: usize, fraction: f64) -> u32 {
    let Some(current) = sentences.get(finished) else {
        return sentences.last().map_or(0, |s| s.end as u32);
    };
    let share = ((current.end - current.start) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    (current.start + share) as u32
}

/// Whether `text` is only acknowledgement words ("hı hı", "evet", "tamam", ...).
pub fn is_backchannel(text: &str) -> bool {
    let lowered = lower_tr(text);
    let words: Vec<&str> = lowered
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .filter(|w| !w.is_empty())
        .collect();
    !words.is_empty() && words.iter().all(|w| BACKCHANNEL.contains(w))
}
```

Check: in "Bir iki. Üç dört beş." the second sentence starts at 9 and ends at 21 (12 characters), so half of it is 6 → 15, as the test says.

`rust/bridge/voice/src/netgsm.rs`:

```rust
//! The line's rules: extension 102 may call Turkish numbers only (Dahili, Şehiriçi, GSM; no
//! international), dialled in national form; Asterisk's Q.850 causes become the core's words.

/// `+90XXXXXXXXXX` as the PBX dials it (`0XXXXXXXXXX`); `None` for any other number.
pub fn dial_string(e164: &str) -> Option<String> {
    let national = e164.strip_prefix("+90")?;
    (national.len() == 10 && national.bytes().all(|b| b.is_ascii_digit()))
        .then(|| format!("0{national}"))
}

/// The core's word for why a line closed (`jt_calls` reads `busy`, `failed`, `congestion`, and any
/// other word before the answer as no answer): after the answer always `normal`.
pub fn hangup_cause(q850: Option<u32>, answered: bool) -> &'static str {
    if answered {
        return "normal";
    }
    match q850 {
        Some(17 | 21) => "busy",
        Some(1 | 3 | 28) => "failed",
        Some(34 | 38 | 41 | 42 | 44 | 58) => "congestion",
        _ => "no_answer",
    }
}
```

- [ ] **Step 7: Write `talker.rs`**

```rust
//! The talker: what one call does on its own between the core's commands (design addendum §3).
//! Pure: it is told what happened and when (milliseconds since the call was answered, on the
//! bridge's monotonic clock) and answers what to do. It plays only texts it was given: the core's
//! sentences, and the policy's phrases ([`BridgePhrases`]), which it picks by set and rotation.

use std::collections::VecDeque;

use jt_calls::{BridgePhrases, PhraseSet};

/// Milliseconds since the call was answered.
pub type Ms = u64;

/// When the talker covers a silence (design addendum §3; tuned on real calls).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub ack_after_ms: Ms,
    pub filler_after_ms: Ms,
    pub long_wait_after_ms: Ms,
    pub still_there_after_ms: Ms,
    /// No phrase starts sooner than this after the last one ended.
    pub phrase_gap_ms: Ms,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            ack_after_ms: 600,
            filler_after_ms: 2_700,
            long_wait_after_ms: 8_000,
            still_there_after_ms: 9_000,
            phrase_gap_ms: 1_000,
        }
    }
}

/// Where an item's text comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// A command of the core: the agent's `say` (`agent`) or a `play` of the plan or policy.
    Core { seq: u32, agent: bool },
    /// One of the policy's phrases.
    Phrase { set: PhraseSet, index: u8 },
}

/// Something to play.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: u64,
    pub source: Source,
    pub text: String,
    pub barge_in: bool,
}

/// What happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Speak { seq: u32, text: String, barge_in: bool, agent: bool },
    /// The core asked to hang up: once everything queued has played.
    HangupWhenDone,
    /// The caller started (or resumed) speaking.
    SpeechStart,
    SpeechEnd,
    /// The caller's turn ended with words (reported to the core).
    Final,
    /// The caller spoke but no words were recognised.
    Unheard,
    /// Item `id` played to its end.
    Played { id: u64 },
    /// The core is unreachable.
    CoreLost,
    Tick,
}

/// What to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Play(Item),
    /// Stop `item` now (flush the line), and drop what was queued behind it.
    Cut { item: Item, dropped: Vec<Item> },
    /// `item` played to its end.
    Done(Item),
    /// Raise (or lower) the listener's echo guard: something is (no longer) playing.
    EchoGuard(bool),
    Hangup,
}

pub struct Talker {
    timing: Timing,
    phrases: BridgePhrases,
    next_id: u64,
    queue: VecDeque<Item>,
    playing: Option<Item>,
    guard: bool,
    owed_since: Option<Ms>,
    stage: u8,
    awaiting_since: Option<Ms>,
    still_there_done: bool,
    last_phrase_end: Option<Ms>,
    speaking: bool,
    hangup_when_done: bool,
    hung_up: bool,
    rotation: [usize; PhraseSet::ALL.len()],
}

impl Talker {
    pub fn new(timing: Timing, phrases: BridgePhrases) -> Talker {
        Talker {
            timing,
            phrases,
            next_id: 1,
            queue: VecDeque::new(),
            playing: None,
            guard: false,
            owed_since: None,
            stage: 0,
            awaiting_since: None,
            still_there_done: false,
            last_phrase_end: None,
            speaking: false,
            hangup_when_done: false,
            hung_up: false,
            rotation: [0; PhraseSet::ALL.len()],
        }
    }

    /// Nothing plays and nothing is queued.
    pub fn is_idle(&self) -> bool {
        self.playing.is_none() && self.queue.is_empty()
    }

    /// The item playing now.
    pub fn playing(&self) -> Option<&Item> {
        self.playing.as_ref()
    }

    /// What to do about `input` at `now`.
    pub fn on(&mut self, input: Input, now: Ms) -> Vec<Action> {
        let mut out = Vec::new();
        if self.hung_up {
            return out;
        }
        match input {
            Input::Speak { seq, text, barge_in, agent } => {
                if agent {
                    self.owed_since = None;
                    self.stage = 0;
                    self.awaiting_since = None;
                    self.still_there_done = false;
                }
                let id = self.id();
                self.queue.push_back(Item { id, source: Source::Core { seq, agent }, text, barge_in });
                self.start_next(&mut out);
            }
            Input::HangupWhenDone => {
                self.hangup_when_done = true;
                self.finish(&mut out);
            }
            Input::SpeechStart => {
                self.speaking = true;
                self.awaiting_since = None;
                self.cut(false, &mut out);
            }
            Input::SpeechEnd => {
                self.speaking = false;
                self.start_next(&mut out);
            }
            Input::Final => {
                self.speaking = false;
                self.owed_since = Some(now);
                self.stage = 0;
                self.awaiting_since = None;
                self.still_there_done = false;
                self.start_next(&mut out);
            }
            Input::Unheard => {
                self.speaking = false;
                if self.is_idle() && self.owed_since.is_none() {
                    self.phrase(PhraseSet::NotHeard, &mut out);
                }
            }
            Input::Played { id } => {
                if self.playing.as_ref().is_some_and(|p| p.id == id) {
                    let item = self.playing.take().expect("checked above");
                    if matches!(item.source, Source::Phrase { .. }) {
                        self.last_phrase_end = Some(now);
                    }
                    let agent_spoke = matches!(item.source, Source::Core { agent: true, .. });
                    out.push(Action::Done(item));
                    if agent_spoke && self.queue.is_empty() && self.owed_since.is_none() {
                        self.awaiting_since = Some(now);
                        self.still_there_done = false;
                    }
                    self.start_next(&mut out);
                    self.lower_guard_if_idle(&mut out);
                    self.finish(&mut out);
                }
            }
            Input::CoreLost => {
                self.cut(true, &mut out);
                self.queue.clear();
                self.owed_since = None;
                self.awaiting_since = None;
                self.phrase(PhraseSet::Fault, &mut out);
                self.hangup_when_done = true;
                self.finish(&mut out);
            }
            Input::Tick => self.cover(now, &mut out),
        }
        out
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn start_next(&mut self, out: &mut Vec<Action>) {
        if self.playing.is_some() || self.speaking {
            return;
        }
        if let Some(item) = self.queue.pop_front() {
            if !self.guard {
                self.guard = true;
                out.push(Action::EchoGuard(true));
            }
            self.playing = Some(item.clone());
            out.push(Action::Play(item));
        }
    }

    fn lower_guard_if_idle(&mut self, out: &mut Vec<Action>) {
        if self.guard && self.is_idle() {
            self.guard = false;
            out.push(Action::EchoGuard(false));
        }
    }

    /// Cuts what plays when the caller speaks over it (or always, with `force`).
    fn cut(&mut self, force: bool, out: &mut Vec<Action>) {
        let cuttable = self.playing.as_ref().is_some_and(|p| force || p.barge_in);
        if !cuttable {
            return;
        }
        let item = self.playing.take().expect("checked above");
        if matches!(item.source, Source::Phrase { .. }) {
            self.last_phrase_end = None;
        }
        let dropped: Vec<Item> = self.queue.drain(..).collect();
        out.push(Action::Cut { item, dropped });
        self.lower_guard_if_idle(out);
    }

    fn finish(&mut self, out: &mut Vec<Action>) {
        if self.hangup_when_done && self.is_idle() && !self.hung_up {
            self.hung_up = true;
            out.push(Action::Hangup);
        }
    }

    /// Covers a silence with the next phrase that is due (see the module docs).
    fn cover(&mut self, now: Ms, out: &mut Vec<Action>) {
        if !self.is_idle() || self.speaking || self.hangup_when_done {
            return;
        }
        if self
            .last_phrase_end
            .is_some_and(|end| now.saturating_sub(end) < self.timing.phrase_gap_ms)
        {
            return;
        }
        if let Some(since) = self.owed_since {
            let waited = now.saturating_sub(since);
            let due = if waited >= self.timing.long_wait_after_ms {
                3
            } else if waited >= self.timing.filler_after_ms {
                2
            } else if waited >= self.timing.ack_after_ms {
                1
            } else {
                0
            };
            if due > self.stage {
                self.stage = due;
                let set = match due {
                    1 => PhraseSet::Acknowledgement,
                    2 => PhraseSet::Filler,
                    _ => PhraseSet::LongWait,
                };
                self.phrase(set, out);
            }
            return;
        }
        if let Some(since) = self.awaiting_since
            && !self.still_there_done
            && now.saturating_sub(since) >= self.timing.still_there_after_ms
        {
            self.still_there_done = true;
            self.phrase(PhraseSet::StillThere, out);
        }
    }

    /// Queues the next phrase of `set` (rotating), if the policy has one.
    fn phrase(&mut self, set: PhraseSet, out: &mut Vec<Action>) {
        let count = self.phrases.set(set).len();
        if count == 0 {
            return;
        }
        let slot = set.position();
        let index = self.rotation[slot] % count;
        self.rotation[slot] += 1;
        let text = self.phrases.set(set)[index].clone();
        let id = self.id();
        self.queue.push_back(Item {
            id,
            source: Source::Phrase { set, index: u8::try_from(index).unwrap_or(u8::MAX) },
            text,
            barge_in: true,
        });
        self.start_next(out);
    }
}
```

- [ ] **Step 8: Run the tests and lints**

Run: `cargo test -p jeeta-voice-bridge` then `cargo clippy -p jeeta-voice-bridge --all-targets -- -D warnings` then `cargo fmt --all -- --check`
Expected: `g711` 3 passed, `text` 6 passed, `netgsm` 2 passed, `talker` 12 passed, `logging` 1 passed; clippy and fmt clean.

- [ ] **Step 9: Commit**

```bash
git add rust/Cargo.toml rust/Cargo.lock rust/deny.toml rust/bridge/voice rust/crates/jt_archtest/tests/dependency_boundaries.rs
git commit -m "feat(voice-bridge): the worker crate, its codecs, sentences and the talker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

CI then runs `jt_archtest` (Expected: `voice_bridge_depends_on_no_server_crate` and `no_crate_but_outbound_names_reqwest` pass) and `cargo deny --locked check` (Expected: pass; if a new transitive licence of `tungstenite` is flagged, add it to `[licenses].allow` in `rust/deny.toml` with a one-line reason in the same commit series).

**B4 as built (2026-10-29, commit `6640635f`).** The steps ran as written, test first; the code is the plan's, reflowed by rustfmt. What differs:
- Step 2 also ran on Windows, with `jt_pg/src/wal.rs`'s two unix-only lines removed for the build only (never committed): `voice_bridge_depends_on_no_server_crate` failed `jeeta-voice-bridge is a workspace package` and `no_crate_but_outbound_names_reqwest` `left: 25, right: 24`. After Step 3, all 17 of `dependency_boundaries` pass.
- Step 4 failed with E0583 (`file not found for module g711`, ...), not "could not find g711": Step 3's `lib.rs` already declares the modules.
- The archtest also asserts that the bridge is the only direct user of `tokio-tungstenite`, so the workspace manifest's "(deny.toml, archtest)" is true. The test sits beside the device bridge's, not at the file's end. `deny.toml`'s comment now names two other reqwest users.
- Docs only: one line on each codec function and each `Timing` field; the talker's module docs list its rules (`cover` points to them); `text::ABBREVIATIONS` names its twin in the speak service (`speech/speak/jeeta_speak.py`).
- `cargo deny` 0.19.9 on Windows: advisories, bans, licences and sources ok. No new licence. tungstenite 0.30 adds `sha1` 0.11 (sqlx-mysql's `sha1` 0.10 is outside the checked graph) and uses the workspace's `rand` 0.10 and `thiserror` 2, so there is no new duplicate and no `skip` entry.
- The talker's `Action::Hangup` and `EchoGuard(false)` are immediate. The plan leaves the timing around them to later tasks: the 400 ms after the closing (B6 `HANGUP_TAIL`), the echo guard's 400 ms tail (the listener's `guard_tail_ms`, B3 I3) and the 5 s without the core before `CoreLost` (D2 `CORE_LOST_AFTER`).
- Checks: `cargo test -p jeeta-voice-bridge` g711 3, text 6, netgsm 2, talker 12, logging 1; clippy (`--all-targets -D warnings`), `cargo fmt --all -- --check` and `cargo doc --no-deps` (`-D warnings`) clean; `jt_archtest` clippy clean.

**B4 review (2026-10-29): what changed.** The reviewer reproduced each finding in a scratch crate. Each fix began with a failing test of its scenario. Steps 4 to 7 above are the first draft: the committed `talker.rs`, `text.rs`, `netgsm.rs` and `tests/logging.rs` supersede them.
- C1, a cut ending never hung up: the caller talking over the closing or the fault sentence left the line open, and the pacer kept its RTP alive. Every input now ends with `finish`, so a line that is to close (the core's `hangup`, or a loss of the core) closes once nothing is left to play, whether the last item played to its end or was cut. B6 now plays `PlayKind::Closing` with `barge_in: false`, so the closing is heard to its end; the talker's fix holds regardless. Tests: a closing, then a fault sentence, each cut and hung up.
- I1, `unheard` without a `speech_end` (the listener's 30 s cut, a processing failure) left the queue held back and the guard up. `Unheard` now closes the turn like `Final` and starts what was queued. The echo guard is down whenever nothing plays, even while the caller holds a queue back. Tests: a queued sentence after `unheard`; a `barge_in: false` item that ends while the caller speaks; a loss of the core while the caller speaks still ends in a hangup.
- I2, a second `CoreLost` cut and restarted the fault sentence. The talker now takes the first only, and none at all once a hangup was asked for. B6's listen arm restarted the loop at once after its stream ended (an `Error` and a `CoreLost` on every pass), so it is now disabled when the stream ends (`listening`). D2 resets `lost` after any post that succeeds, so a flapping core can send `CoreLost` again; a comment there says the talker covers it.
- I3, fillers played in the pauses of an open turn: `SpeechEnd` is the listener's pause, and the previous `Final`'s wait kept counting. A `turn_open` flag now runs from `SpeechStart` to `Final` or `Unheard`, and no acknowledgement, filler, long wait or "still there" plays while it is set. Test: the reviewer's replay (an acknowledgement, then the caller goes on and pauses at 4 s): nothing until the turn's final.
- I4, "still there" played between the core's holding lines. Fix in B4: a line of the core (`Speak { agent: false }`, such as a holding line while the agent works on after `expect_reply: false`) ends the wait for the caller. Test: an agent sentence, a holding line at 5.5 s, then nothing for 20 s. Cleaner later, and noted for phase C: carry `expect_reply` on `Command::Say` (jt_calls wire, serde default `true`), so the talker waits only after a sentence that expects a reply. That would also hold if a policy's `slow_agent_s` reached 9 s, where the first holding line would come after "still there".
- I5, sentences:
  - The worker cut "3. katta" and "1. seçenek". A period after a number written in digits, before a word in lower case, now ends no sentence.
  - The worker also sent "Evet. Tamam. Yarın görüşürüz." as three requests, while the speak service keeps it whole. It now joins a piece of fewer than three words to the next one, and the last such piece to the one before it, as the speak service does.
  - Both now cut after "…".
  - The speak service (`jeeta_speak.py`) gained the ordinal rule and "…" in its splitter, `PIPELINE_VERSION` 2, and the ordinal rule in `pipeline()`, so its voice id changes. Its image is to be rebuilt (the coordinator's step; the server is untouched).
  - One table, `speech/speak/tests/speak_sentence_cases.py` (19 cases, one JSON array per line), is read by pytest (parametrized) and by the worker's `texts_are_cut_where_the_speak_service_cuts_them`. 3,5, 14:00, 14.30, 1.250, Dr., Prof.Dr. and ?! keep their behaviour.
- I6, `dial_string` took any ten digits after +90. It now takes national numbers starting 2, 3, 4 or 5 (geographic and mobile), 800 and 850, and refuses the rest: 0 (abroad through the national prefix), 1, 6, 7, 9 and the other 8xx (the coordinator's decision, the owner informed). D2's refusal line and log, and the slice's usage line, say so.
- I7, logging: an allowlist instead of a denylist of eleven words, over sources that had no log call.
  - `tests/logging.rs` reads every file under `src/`. A log call (the level macros, `event!` and the `span!` family) carries only fields on a list (call, command, kind, state, cause, reason, status, count, ms, seq, set, index, error), and formats with `Debug` only cause, status, state, kind and set. Its message is a literal with no interpolation, and no value names a text word (text, texts, transcript, sentence, sentences, utterance, words, digit, digits, e164, to_e164, dial, phone, number, password, key, url, body, hotwords, pcm, audio).
  - `#[instrument]` needs `skip_all`. `dbg!` is never allowed. Print macros appear only in `main.rs` and `slice.rs`, and print no text there but the slice's opt-in `println!("caller: {text}")`. A file that names `reqwest::Error` must call `without_url`.
  - The rules are checked on 15 samples taken from B6's and D2's calls (all pass) and on 20 leaks (all caught), so the test proves something before the bridge logs.
  - `talker::Item`, `talker::Input` and `text::Sentence` print a text's length in `Debug` (`text::Redacted`, `<36 chars>`), held by `tests/redaction.rs`.
  - jt_calls' `Command` and `BridgeEvent` keep their derived `Debug` (they are the core's types); the `?` rule keeps them out of the bridge's logs. B5's `Heard` already prints no word.
- M1: a loss of the core with nothing playing now reports what was queued as `Action::Dropped` (B6 sends `said{seq, 0}` for each line of the core), and a closing already asked for plays to its end instead of being replaced by the fault sentence.
- M2: the talker's module docs and the design's §3 rules say which phrases wait for the 1 s gap ("not heard" and the fault sentence do not). The spec's "≤ 1.5 s" is corrected from B2's TIMING: the long wait is about 3 s.
- M3: `bul`, `tel`, `sok` and `no` stay abbreviations, for parity with the speak service. A note says what that costs, and a table case ("Kutuyu rafa sok. …") shows it.
- M4: G.711's ends of scale are pinned (μ-law ±32767 to 0x80/0x00, A-law to 0xAA/0x2A, and back). All 256 code words survive a round trip (μ-law 0x7F comes back as 0xFF). Every one of the 65 536 samples comes back within half its segment's step, where the old bound let more than a step through. In a mutation pass of three edits to `g711.rs`, two fail these tests; the third (μ-law's clip at 32 000 instead of 32 635) gives the same code words, so no test can tell it apart.
- M5: Q.850 1, 3 and 28 before the answer are `netgsm::permanent_failure`, a `permanent: bridge: …` line. B6 reports it as the call's `error`, the distinction jt_calls already has: a failure line's kind, the same one D2 uses for a refused number. A `hangup` would read as the transient `failed`.
- Plan and spec text corrected so later tasks keep these fixes:
  - B6 `call.rs`: the closing's `barge_in`, the `Dropped` arm, the listen arm's `listening` guard, `permanent_failure` before the answer, `PlayKind` imported; the slice's `SLICE_TO` line.
  - D2: the refusal line and its log, and the `lost` comment.
  - Design §3: the "still there" row, the rules, playback and closing.
- Checks after the round: `cargo test -p jeeta-voice-bridge` g711 5, logging 3, netgsm 4, redaction 4, talker 22, text 10 (48); clippy, fmt and doc clean. The speech tests (Windows, a scratch venv with the pinned pytest, numpy and websockets) give 200 passed and 28 skipped, against 180 and 28 before.

**B4 re-review (2026-10-30): what changed.** All 13 findings above were confirmed fixed, and `finish` hangs nothing up early. One more Important finding and four Minor ones; each fix again began with a failing test.
- N1, the caller talking over the fault sentence hung up within half a second: a natural "Alo?" (more than the 256 ms of guarded speech) cut it, and the caller never heard the promise to call back. The fault sentence is now queued with `barge_in: false`, like the closing. When the core is lost in a pause of an open turn, the sentence waits for the turn to close, `FAULT_WAIT_MS` (3 s) at most, and then plays to its end even if the caller speaks again. The test that pinned the cut became "the fault sentence plays to its end then hangs up even if the caller talks", with two more for the wait and its cap. Design §3 notes the exception.
- N2, a `say` that came after the loss played after the fault sentence. It is now reported as `Dropped` (B6 sends `said{seq, 0}`), and nothing is queued.
- N3, a turn whose final or unheard words never came (B6 passed over a listener message it could not read) blocked every acknowledgement, filler, long wait and "still there" for the rest of the call. Two fixes: the talker closes a turn still open `TURN_LIMIT_MS` (35 s, beyond the listener's own 30 s cut) after it began, as unheard words; and B6 takes a listener message it cannot read inside an open turn as `Unheard` (`Talker::turn_open`; the hello comes before any turn).
- N4, an ordinal before a capitalised word was still cut ("Bizim yeni ofisimiz 4. Levent'te …", "3. Kat"). Both cutters now also keep a number's period before one of nine words that follow ordinals in capitals in addresses and sports: kat, blok, etap, levent, bölge, lig, dünya, cadde, sokak (`text::ORDINAL_NOUNS`; `ORDINAL_NOUNS` and `PIPELINE_VERSION` 3 in the speak service, both in its pipeline and so its voice id). The shared table gains a `LISTS` line that both tests check their abbreviations and ordinal nouns against, and eight cases. The known limit is a case too: before any other capitalised word the period ends the sentence, which is right for "Kapı numarası 12. Ondan sonra …" and wrong for "Sultan 4. Murat …".
- N5, the logging allowlist checked names, not values: `kind = ?command` (jt_calls' derived `Debug` prints the sentence), `cause = ?event`, `state = ?ari_event` (the key pressed) and `reason = %t` passed. Now:
  - A field's value must be a bare path that ends in the field's own name or `id` (`cause`, `self.id`, `out.status`, `c.kind`), and `error` takes `%e` or `%err` alone.
  - A span's first literal is its name, so `info_span!("call", call = %id)` passes.
  - Calls in `{ }` and `[ ]` are scanned too.
  - The samples (now 19, all of B6's and D2's shapes) pass, and the leaks (now 29) are caught.
- Checks after the round: `cargo test -p jeeta-voice-bridge` g711 5, logging 3, netgsm 4, redaction 4, talker 26, text 11 (53); clippy, fmt and doc clean. The speech tests give 209 passed and 28 skipped.

### Task B5: The worker's adapters (config, phrase cache, trace, ARI, media, speech)

**Files:**
- Create: `rust/bridge/voice/src/config.rs`, `src/cache.rs`, `src/trace.rs`, `src/ari.rs`, `src/media.rs`, `src/speech.rs`
- Create: `rust/bridge/voice/tests/adapters.rs`, `tests/pacer.rs` (the media pacer, B1 review)
- Modify: `rust/bridge/voice/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

`rust/bridge/voice/tests/adapters.rs`:

```rust
//! The adapters' pure parts: configuration, cache keys, traces and the wire parsers.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use jeeta_voice_bridge::ari::{AriEvent, parse_event};
use jeeta_voice_bridge::cache::{PhraseCache, key};
use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::media::{MediaEvent, command, parse_control};
use jeeta_voice_bridge::speech::{Endpoint, Heard};
use jeeta_voice_bridge::trace::{AudioClock, TurnMarks, read_traces, TraceFile};
use jt_calls::EndpointBy;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
    move |k| map.get(k).cloned()
}

#[test]
fn configuration_reads_the_environment_and_hides_secrets() {
    let c = Config::from_env(
        env(&[
            ("JEETA_BASE_URL", "http://127.0.0.1:8091"),
            ("JEETA_BRIDGE_KEY", "jeeta_secret"),
            ("ARI_PASSWORD", "ari-secret"),
            ("VOICE_ACK_MS", "500"),
        ]),
        true,
    )
    .unwrap();
    assert_eq!(c.extension, "102");
    assert_eq!(c.ari_url, "http://127.0.0.1:8188");
    assert_eq!(c.timing.ack_after_ms, 500);
    assert_eq!(c.listen, Endpoint::Unix("/run/jeeta-voice/listen/listen.sock".into()));
    let shown = format!("{c:?}");
    assert!(!shown.contains("jeeta_secret") && !shown.contains("ari-secret"), "{shown}");
    assert!(Config::from_env(env(&[("ARI_PASSWORD", "x")]), true).is_err());
    assert!(Config::from_env(env(&[("ARI_PASSWORD", "x")]), false).is_ok());
}

#[test]
fn endpoints_parse() {
    assert_eq!("tcp:127.0.0.1:7071".parse::<Endpoint>().unwrap(), Endpoint::Tcp("127.0.0.1:7071".into()));
    assert!("http://x".parse::<Endpoint>().is_err());
}

#[test]
fn the_cache_keeps_policy_sentences_on_disk_and_call_sentences_in_memory() {
    let dir = std::env::temp_dir().join(format!("voice-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut a = PhraseCache::new(dir.clone(), "ema-test");
    a.put("Hı hı.", vec![1, 2, 3], true);
    a.put("Ada Hanım ile mi görüşüyorum?", vec![4, 5], false);
    let mut b = PhraseCache::new(dir.clone(), "ema-test");
    assert_eq!(b.get("Hı hı.").as_deref(), Some(&vec![1i16, 2, 3]));
    assert_eq!(b.get("Ada Hanım ile mi görüşüyorum?"), None);
    assert_eq!(a.get("Ada Hanım ile mi görüşüyorum?").as_deref(), Some(&vec![4i16, 5]));
    assert_ne!(key("ema-test", "Hı hı."), key("ema-other", "Hı hı."));
    assert_eq!(key("v", "t").len(), 64);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_audio_clock_maps_positions_to_arrival() {
    let mut clock = AudioClock::default();
    let t0 = Instant::now();
    for i in 0..10u64 {
        clock.push(20, t0 + Duration::from_millis(20 * i));
    }
    assert_eq!(clock.position_ms(), 200);
    assert_eq!(clock.at(0), Some(t0));
    assert_eq!(clock.at(100), Some(t0 + Duration::from_millis(100)));
    assert_eq!(clock.at(119), Some(t0 + Duration::from_millis(100)));
    assert_eq!(clock.at(500), None);
}

#[test]
fn marks_become_a_trace_and_traces_go_to_their_file() {
    let t0 = Instant::now();
    let mut m = TurnMarks::new(t0, 260, EndpointBy::SmartTurn, t0 + Duration::from_millis(310));
    m.delivered = Some(t0 + Duration::from_millis(340));
    m.ack = Some(t0 + Duration::from_millis(620));
    m.first_audio = Some(t0 + Duration::from_millis(4_760));
    m.reply_seq = Some(4);
    let trace = m.trace();
    assert_eq!((trace.endpoint_ms, trace.stt_final_ms), (260, 310));
    assert_eq!(trace.reply_seq, Some(4));
    assert_eq!((trace.ack_ms, trace.first_audio_ms), (Some(620), Some(4_760)));
    let path = std::env::temp_dir().join(format!("voice-traces-{}.jsonl", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let file = TraceFile::new(path.clone());
    file.append("c-1", &trace).unwrap();
    file.append("c-1", &trace).unwrap();
    let read = read_traces(&path, None).unwrap();
    assert_eq!(read, vec![trace.clone(), trace]);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains('+'), "{text}");
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn ari_events_are_read() {
    assert_eq!(
        parse_event(r#"{"type":"StasisStart","args":["out"],"channel":{"id":"c-1","state":"Up"}}"#),
        AriEvent::Answered { channel: "c-1".into(), inbound: false }
    );
    assert_eq!(
        parse_event(r#"{"type":"StasisStart","args":["in"],"channel":{"id":"x"}}"#),
        AriEvent::Answered { channel: "x".into(), inbound: true }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelStateChange","channel":{"id":"c-1","state":"Ringing"}}"#),
        AriEvent::Ringing { channel: "c-1".into() }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelDtmfReceived","digit":"5","channel":{"id":"c-1"}}"#),
        AriEvent::Dtmf { channel: "c-1".into(), digit: "5".into() }
    );
    assert_eq!(
        parse_event(r#"{"type":"ChannelDestroyed","cause":17,"channel":{"id":"c-1"}}"#),
        AriEvent::Gone { channel: "c-1".into(), cause: Some(17) }
    );
    assert_eq!(parse_event(r#"{"type":"StasisStart","args":[],"channel":{"id":"c-1-m"}}"#), AriEvent::Other);
    assert_eq!(parse_event("not json"), AriEvent::Other);
}

#[test]
fn media_control_is_read_and_written_as_json() {
    assert_eq!(
        parse_control(r#"{"event":"MEDIA_START","connection_id":"k","channel":"WebSocket/x","channel_id":"c-1-m","format":"alaw","optimal_frame_size":160,"ptime":20}"#),
        MediaEvent::Start { format: "alaw".into(), frame_bytes: 160 }
    );
    assert_eq!(
        parse_control(r#"{"event":"MEDIA_MARK_PROCESSED","channel_id":"c-1-m","correlation_id":"7:2"}"#),
        MediaEvent::MarkProcessed { correlation: "7:2".into() }
    );
    assert_eq!(parse_control(r#"{"event":"MEDIA_XOFF","channel_id":"c"}"#), MediaEvent::Xoff);
    assert_eq!(parse_control(r#"{"event":"MEDIA_XON","channel_id":"c"}"#), MediaEvent::Xon);
    assert_eq!(command("FLUSH_MEDIA", None), r#"{"command":"FLUSH_MEDIA"}"#);
    assert_eq!(
        command("MARK_MEDIA", Some("7:2")),
        r#"{"command":"MARK_MEDIA","correlation_id":"7:2"}"#
    );
}

#[test]
fn listener_events_are_read_and_never_printed_with_their_words() {
    let h: Heard = serde_json::from_str(
        r#"{"type":"final","text":"evet perşembe","speech_end_ms":900,"endpoint_ms":1160,"endpoint_by":"smart_turn","stt_ms":45}"#,
    )
    .unwrap();
    assert!(matches!(h, Heard::Final { endpoint_ms: 1160, .. }));
    assert!(!format!("{h:?}").contains("perşembe"));
    let s: Heard = serde_json::from_str(r#"{"type":"speech_start","audio_ms":420}"#).unwrap();
    assert!(matches!(s, Heard::SpeechStart { audio_ms: 420 }));
}
```

Run: `cargo test -p jeeta-voice-bridge --test adapters`
Expected: FAIL to compile (modules missing).

- [ ] **Step 2: Write `config.rs`**

```rust
//! The bridge's configuration, from its environment (systemd `EnvironmentFile`s
//! `/etc/jeeta-voice/ari.env` and `/etc/jeeta-voice/bridge.env`). `Debug` hides the key and the
//! ARI password.

use std::path::PathBuf;

use crate::speech::Endpoint;
use crate::talker::Timing;

#[derive(Clone)]
pub struct Config {
    pub jeeta_base_url: String,
    pub bridge_key: String,
    pub extension: String,
    pub ari_url: String,
    pub ari_user: String,
    pub ari_password: String,
    pub listen: Endpoint,
    pub speak: Endpoint,
    pub cache_dir: PathBuf,
    pub trace_file: PathBuf,
    pub timing: Timing,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("jeeta_base_url", &self.jeeta_base_url)
            .field("extension", &self.extension)
            .field("ari_url", &self.ari_url)
            .field("listen", &self.listen)
            .field("speak", &self.speak)
            .field("cache_dir", &self.cache_dir)
            .field("timing", &self.timing)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{0} is not valid")]
    Invalid(&'static str),
}

fn ms(get: &impl Fn(&str) -> Option<String>, name: &'static str, default: u64) -> Result<u64, ConfigError> {
    match get(name) {
        Some(v) => v.trim().parse().map_err(|_| ConfigError::Invalid(name)),
        None => Ok(default),
    }
}

impl Config {
    /// The configuration from `get` (the environment). `need_core`: the core's address and the key
    /// must be set (`run`); the slice and the checks run without them.
    pub fn from_env(get: impl Fn(&str) -> Option<String>, need_core: bool) -> Result<Config, ConfigError> {
        let required = |name: &'static str| get(name).filter(|v| !v.trim().is_empty()).ok_or(ConfigError::Missing(name));
        let (jeeta_base_url, bridge_key) = if need_core {
            (required("JEETA_BASE_URL")?, required("JEETA_BRIDGE_KEY")?)
        } else {
            (get("JEETA_BASE_URL").unwrap_or_default(), get("JEETA_BRIDGE_KEY").unwrap_or_default())
        };
        let endpoint = |name: &'static str, default: &str| -> Result<Endpoint, ConfigError> {
            get(name).unwrap_or_else(|| default.to_owned()).parse().map_err(|_| ConfigError::Invalid(name))
        };
        let base = Timing::default();
        Ok(Config {
            jeeta_base_url: jeeta_base_url.trim_end_matches('/').to_owned(),
            bridge_key,
            extension: get("VOICE_EXTENSION").unwrap_or_else(|| "102".into()),
            ari_url: get("ARI_URL").unwrap_or_else(|| "http://127.0.0.1:8188".into()),
            ari_user: get("ARI_USER").unwrap_or_else(|| "jeeta-voice".into()),
            ari_password: required("ARI_PASSWORD")?,
            listen: endpoint("LISTEN_SOCKET", "unix:/run/jeeta-voice/listen/listen.sock")?,
            speak: endpoint("SPEAK_SOCKET", "unix:/run/jeeta-voice/speak.sock")?,
            cache_dir: get("VOICE_CACHE_DIR").unwrap_or_else(|| "/var/lib/jeeta-voice/cache".into()).into(),
            trace_file: get("VOICE_TRACE_FILE").unwrap_or_else(|| "/var/lib/jeeta-voice/traces.jsonl".into()).into(),
            timing: Timing {
                ack_after_ms: ms(&get, "VOICE_ACK_MS", base.ack_after_ms)?,
                filler_after_ms: ms(&get, "VOICE_FILLER_MS", base.filler_after_ms)?,
                long_wait_after_ms: ms(&get, "VOICE_LONG_WAIT_MS", base.long_wait_after_ms)?,
                still_there_after_ms: ms(&get, "VOICE_STILL_THERE_MS", base.still_there_after_ms)?,
                phrase_gap_ms: ms(&get, "VOICE_PHRASE_GAP_MS", base.phrase_gap_ms)?,
            },
        })
    }
}
```

- [ ] **Step 3: Write `cache.rs` and `trace.rs`**

`rust/bridge/voice/src/cache.rs`:

```rust
//! Synthesised sentences, by the SHA-256 of the voice and the text: policy sentences (openings,
//! notice, phrases: owner-approved, no personal data) are kept on disk as raw PCM16 8 kHz; a call's
//! own sentences (its plan, the agent's) only in that call's memory, dropped at hang-up. The voice
//! is the speak service's voice id, from the `hello` it sends first on every connection (B2): it
//! names everything that decides how a text sounds, so audio of another voice is never played.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};

/// The cache key of `text` spoken by `voice`.
pub fn key(voice: &str, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(voice.as_bytes());
    h.update([0u8]);
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

pub struct PhraseCache {
    dir: PathBuf,
    voice: String,
    memory: HashMap<String, Arc<Vec<i16>>>,
}

impl PhraseCache {
    pub fn new(dir: PathBuf, voice: &str) -> PhraseCache {
        PhraseCache { dir, voice: voice.to_owned(), memory: HashMap::new() }
    }

    /// The voice id this cache keys by.
    pub fn voice(&self) -> &str {
        &self.voice
    }

    /// The audio of `text`: from this call's memory, else from disk (then kept in memory too).
    pub fn get(&mut self, text: &str) -> Option<Arc<Vec<i16>>> {
        let k = key(&self.voice, text);
        if let Some(pcm) = self.memory.get(&k) {
            return Some(pcm.clone());
        }
        let bytes = std::fs::read(self.dir.join(format!("{k}.pcm"))).ok()?;
        let pcm: Arc<Vec<i16>> =
            Arc::new(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect());
        self.memory.insert(k, pcm.clone());
        Some(pcm)
    }

    /// Keeps `pcm` as the audio of `text`; on disk too when `persist` (a policy sentence).
    pub fn put(&mut self, text: &str, pcm: Vec<i16>, persist: bool) {
        let k = key(&self.voice, text);
        if persist && std::fs::create_dir_all(&self.dir).is_ok() {
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            let tmp = self.dir.join(format!("{k}.tmp"));
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, self.dir.join(format!("{k}.pcm")));
            }
        }
        self.memory.insert(k, Arc::new(pcm));
    }
}
```

`rust/bridge/voice/src/trace.rs`:

```rust
//! The per-turn trace on the bridge's monotonic clock (design addendum §7): the listener reports
//! audio positions, which [`AudioClock`] maps to the instants the bridge forwarded those frames;
//! [`TurnMarks`] collects a turn's instants and gives its [`TurnTrace`]; [`TraceFile`] keeps one JSON
//! line per trace (numbers and the call id only) for `jeeta-voice-bridge report`.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use jt_calls::{EndpointBy, TurnTrace};
use time::OffsetDateTime;

/// How much audio history the clock keeps, in milliseconds.
const KEEP_MS: u64 = 60_000;

/// Inbound audio positions and when they arrived.
#[derive(Debug, Default)]
pub struct AudioClock {
    entries: VecDeque<(u64, Instant)>,
    position_ms: u64,
}

impl AudioClock {
    /// `ms` more audio arrived at `at`.
    pub fn push(&mut self, ms: u64, at: Instant) {
        self.entries.push_back((self.position_ms, at));
        self.position_ms += ms;
        while self.entries.front().is_some_and(|(p, _)| self.position_ms - p > KEEP_MS) {
            self.entries.pop_front();
        }
    }

    pub fn position_ms(&self) -> u64 {
        self.position_ms
    }

    /// When the frame holding audio position `ms` arrived.
    pub fn at(&self, ms: u64) -> Option<Instant> {
        if ms >= self.position_ms {
            return None;
        }
        self.entries.iter().rev().find(|(p, _)| *p <= ms).map(|(_, at)| *at)
    }
}

fn since(base: Instant, at: Option<Instant>) -> Option<u32> {
    at.map(|t| u32::try_from(t.saturating_duration_since(base).as_millis()).unwrap_or(u32::MAX))
}

/// One turn's instants.
#[derive(Clone, Debug)]
pub struct TurnMarks {
    pub speech_end: Instant,
    pub endpoint_ms: u32,
    pub endpoint_by: EndpointBy,
    pub stt_final: Instant,
    pub delivered: Option<Instant>,
    pub say: Option<Instant>,
    pub tts_first: Option<Instant>,
    pub first_audio: Option<Instant>,
    pub ack: Option<Instant>,
    /// The `seq` of the agent `say` that `say` timed (the trace's `reply_seq`).
    pub reply_seq: Option<u32>,
    pub barge_in_stop_ms: Option<u32>,
    pub backchannel_cut: bool,
}

impl TurnMarks {
    pub fn new(speech_end: Instant, endpoint_ms: u32, endpoint_by: EndpointBy, stt_final: Instant) -> TurnMarks {
        TurnMarks {
            speech_end,
            endpoint_ms,
            endpoint_by,
            stt_final,
            delivered: None,
            say: None,
            tts_first: None,
            first_audio: None,
            ack: None,
            reply_seq: None,
            barge_in_stop_ms: None,
            backchannel_cut: false,
        }
    }

    pub fn trace(&self) -> TurnTrace {
        let base = self.speech_end;
        TurnTrace {
            endpoint_ms: self.endpoint_ms,
            endpoint_by: Some(self.endpoint_by),
            stt_final_ms: since(base, Some(self.stt_final)).unwrap_or_default(),
            delivered_ms: since(base, self.delivered),
            say_ms: since(base, self.say),
            tts_first_ms: since(base, self.tts_first),
            first_audio_ms: since(base, self.first_audio),
            ack_ms: since(base, self.ack),
            barge_in_stop_ms: self.barge_in_stop_ms,
            backchannel_cut: self.backchannel_cut,
            reply_seq: self.reply_seq,
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Line {
    #[serde(with = "time::serde::rfc3339")]
    at: OffsetDateTime,
    call: String,
    trace: TurnTrace,
}

/// The bridge's own trace log.
#[derive(Clone, Debug)]
pub struct TraceFile {
    path: PathBuf,
}

impl TraceFile {
    pub fn new(path: PathBuf) -> TraceFile {
        TraceFile { path }
    }

    pub fn append(&self, call: &str, trace: &TurnTrace) -> std::io::Result<()> {
        let line = Line { at: OffsetDateTime::now_utc(), call: call.to_owned(), trace: trace.clone() };
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
        writeln!(file, "{}", serde_json::to_string(&line).map_err(std::io::Error::other)?)
    }
}

/// The traces of `path` written at or after `since` (all of them without), unreadable lines skipped.
pub fn read_traces(path: &Path, since: Option<OffsetDateTime>) -> std::io::Result<Vec<TurnTrace>> {
    let text = std::fs::read_to_string(path)?;
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str::<Line>(l).ok())
        .filter(|l| since.is_none_or(|s| l.at >= s))
        .map(|l| l.trace)
        .collect())
}
```

- [ ] **Step 4: Write `ari.rs`, `media.rs` and `speech.rs`**

`rust/bridge/voice/src/ari.rs`:

```rust
//! The Asterisk REST Interface on loopback (design addendum §2): originate, external media over
//! `chan_websocket` (Asterisk's own HTTP server, the INCOMING mode: the bridge connects in), mixing
//! bridges, hangup, and the application's events. Errors never carry a URL, a query or a body.

use std::time::Duration;

use base64::Engine as _;
use reqwest::Method;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

/// The bridge's Stasis application.
pub const APP: &str = "jeeta-voice";

#[derive(Debug, thiserror::Error)]
pub enum AriError {
    #[error("ARI answered {0}")]
    Status(u16),
    #[error("ARI unreachable")]
    Transport,
    #[error("ARI's answer is unreadable")]
    Decode,
}

pub type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// An ARI event the bridge acts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AriEvent {
    Ringing { channel: String },
    /// The channel entered the application: an outbound call was answered, or an inbound one rang.
    Answered { channel: String, inbound: bool },
    Dtmf { channel: String, digit: String },
    Gone { channel: String, cause: Option<u32> },
    Other,
}

/// Reads one event of the application's stream.
pub fn parse_event(text: &str) -> AriEvent {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return AriEvent::Other;
    };
    let channel = v["channel"]["id"].as_str().unwrap_or_default().to_owned();
    match v["type"].as_str() {
        Some("StasisStart") => match v["args"].get(0).and_then(Value::as_str) {
            Some("out") => AriEvent::Answered { channel, inbound: false },
            Some("in") => AriEvent::Answered { channel, inbound: true },
            _ => AriEvent::Other,
        },
        Some("ChannelStateChange") if v["channel"]["state"] == "Ringing" => AriEvent::Ringing { channel },
        Some("ChannelDtmfReceived") => AriEvent::Dtmf {
            channel,
            digit: v["digit"].as_str().unwrap_or_default().to_owned(),
        },
        Some("ChannelDestroyed") => AriEvent::Gone {
            channel,
            cause: v["cause"].as_u64().and_then(|c| u32::try_from(c).ok()),
        },
        _ => AriEvent::Other,
    }
}

pub struct Ari {
    http: reqwest::Client,
    base: String,
    user: String,
    password: String,
}

impl Ari {
    pub fn new(base: &str, user: &str, password: &str) -> Ari {
        Ari {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default(),
            base: base.trim_end_matches('/').to_owned(),
            user: user.to_owned(),
            password: password.to_owned(),
        }
    }

    async fn call(&self, method: Method, path: &str, query: &[(&str, &str)]) -> Result<Value, AriError> {
        let response = self
            .http
            .request(method, format!("{}/ari{path}", self.base))
            .basic_auth(&self.user, Some(&self.password))
            .query(query)
            .send()
            .await
            .map_err(|_| AriError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(AriError::Status(status.as_u16()));
        }
        let text = response.text().await.map_err(|_| AriError::Transport)?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| AriError::Decode)
    }

    fn gone_is_fine(r: Result<Value, AriError>) -> Result<(), AriError> {
        match r {
            Ok(_) | Err(AriError::Status(404)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Dials `endpoint` (`PJSIP/05…@netgsm`) as channel `channel_id`; it enters the application when
    /// answered.
    pub async fn originate(&self, channel_id: &str, endpoint: &str, timeout_s: u32) -> Result<(), AriError> {
        let timeout = timeout_s.to_string();
        self.call(
            Method::POST,
            "/channels",
            &[("endpoint", endpoint), ("app", APP), ("appArgs", "out"), ("channelId", channel_id), ("timeout", &timeout)],
        )
        .await
        .map(drop)
    }

    /// A media channel `channel_id` the bridge connects to over WebSocket, in `format`.
    pub async fn external_media(&self, channel_id: &str, format: &str) -> Result<(), AriError> {
        self.call(
            Method::POST,
            "/channels/externalMedia",
            &[
                ("app", APP),
                ("channelId", channel_id),
                ("external_host", "INCOMING"),
                ("transport", "websocket"),
                ("encapsulation", "none"),
                ("connection_type", "server"),
                ("format", format),
                ("transport_data", "f(json)"),
            ],
        )
        .await
        .map(drop)
    }

    pub async fn variable(&self, channel: &str, name: &str) -> Result<String, AriError> {
        let v = self.call(Method::GET, &format!("/channels/{channel}/variable"), &[("variable", name)]).await?;
        v.get("value").and_then(Value::as_str).map(str::to_owned).ok_or(AriError::Decode)
    }

    /// A mixing bridge `bridge_id` holding `channels`.
    pub async fn mix(&self, bridge_id: &str, channels: &[&str]) -> Result<(), AriError> {
        self.call(Method::POST, "/bridges", &[("type", "mixing"), ("bridgeId", bridge_id)]).await?;
        let list = channels.join(",");
        self.call(Method::POST, &format!("/bridges/{bridge_id}/addChannel"), &[("channel", &list)])
            .await
            .map(drop)
    }

    pub async fn hangup(&self, channel: &str) -> Result<(), AriError> {
        Self::gone_is_fine(self.call(Method::DELETE, &format!("/channels/{channel}"), &[("reason", "normal")]).await)
    }

    /// Refuses a ringing channel as busy.
    pub async fn refuse(&self, channel: &str) -> Result<(), AriError> {
        Self::gone_is_fine(self.call(Method::DELETE, &format!("/channels/{channel}"), &[("reason", "busy")]).await)
    }

    pub async fn destroy_bridge(&self, bridge_id: &str) -> Result<(), AriError> {
        Self::gone_is_fine(self.call(Method::DELETE, &format!("/bridges/{bridge_id}"), &[]).await)
    }

    pub async fn redirect(&self, channel: &str, endpoint: &str) -> Result<(), AriError> {
        self.call(Method::POST, &format!("/channels/{channel}/redirect"), &[("endpoint", endpoint)])
            .await
            .map(drop)
    }

    /// The channels Asterisk has now.
    pub async fn channel_ids(&self) -> Result<Vec<String>, AriError> {
        let v = self.call(Method::GET, "/channels", &[]).await?;
        Ok(v.as_array()
            .map(|a| a.iter().filter_map(|c| c["id"].as_str().map(str::to_owned)).collect())
            .unwrap_or_default())
    }

    /// Asterisk's version line (the `check` command).
    pub async fn info(&self) -> Result<String, AriError> {
        let v = self.call(Method::GET, "/asterisk/info", &[]).await?;
        Ok(v["system"]["version"].as_str().unwrap_or("?").to_owned())
    }

    fn ws_base(&self) -> String {
        self.base.replacen("http", "ws", 1)
    }

    async fn connect(&self, url: String) -> Result<Socket, AriError> {
        let mut request = url.into_client_request().map_err(|_| AriError::Transport)?;
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", self.user, self.password));
        let header = HeaderValue::from_str(&format!("Basic {token}")).map_err(|_| AriError::Transport)?;
        request.headers_mut().insert("Authorization", header);
        tokio_tungstenite::connect_async(request).await.map(|(s, _)| s).map_err(|_| AriError::Transport)
    }

    /// The application's event stream.
    pub async fn events(&self) -> Result<Socket, AriError> {
        self.connect(format!("{}/ari/events?app={APP}&subscribeAll=false", self.ws_base())).await
    }

    /// The media of an external media channel, by its `MEDIA_WEBSOCKET_CONNECTION_ID`.
    pub async fn media(&self, connection_id: &str) -> Result<Socket, AriError> {
        self.connect(format!("{}/media/{connection_id}", self.ws_base())).await
    }
}
```

`rust/bridge/voice/src/media.rs`:

```rust
//! `chan_websocket`'s control messages in JSON mode (`f(json)`; Asterisk ≥ 22.8): the events the
//! bridge reads and the commands it writes. Audio goes as binary messages of whole frames, at most
//! [`MAX_MESSAGE_BYTES`] (Asterisk closes the call above 65 500 bytes).

use serde_json::{Value, json};

pub const MAX_MESSAGE_BYTES: usize = 64_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaEvent {
    Start { format: String, frame_bytes: usize },
    MarkProcessed { correlation: String },
    Xoff,
    Xon,
    Dtmf { digit: String },
    Other,
}

pub fn parse_control(text: &str) -> MediaEvent {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return MediaEvent::Other;
    };
    match v["event"].as_str() {
        Some("MEDIA_START") => MediaEvent::Start {
            format: v["format"].as_str().unwrap_or("ulaw").to_owned(),
            frame_bytes: v["optimal_frame_size"].as_u64().map_or(160, |n| n as usize),
        },
        Some("MEDIA_MARK_PROCESSED") => MediaEvent::MarkProcessed {
            correlation: v["correlation_id"].as_str().unwrap_or_default().to_owned(),
        },
        Some("MEDIA_XOFF") => MediaEvent::Xoff,
        Some("MEDIA_XON") => MediaEvent::Xon,
        Some("DTMF_END") => MediaEvent::Dtmf { digit: v["digit"].as_str().unwrap_or_default().to_owned() },
        _ => MediaEvent::Other,
    }
}

/// A control command (`FLUSH_MEDIA`, `MARK_MEDIA`, `HANGUP`, ...), with its correlation id.
pub fn command(name: &str, correlation: Option<&str>) -> String {
    match correlation {
        Some(c) => json!({ "command": name, "correlation_id": c }),
        None => json!({ "command": name }),
    }
    .to_string()
}

/// `pcm` padded with silence to whole frames of `frame_samples`.
pub fn pad_to_frames(mut pcm: Vec<i16>, frame_samples: usize) -> Vec<i16> {
    let frame = frame_samples.max(1);
    let rest = pcm.len() % frame;
    if rest != 0 {
        pcm.resize(pcm.len() + frame - rest, 0);
    }
    pcm
}
```

**The pacer (B1 review, 2026-10-29).** Since Asterisk 22.9, chan_websocket sends nothing to the line when the worker writes nothing ("chan_websocket: Remove silence generation and frame padding", ChangeLog-22.9.0). So the worker must pace the media itself, for the whole call, from `MEDIA_START`:
- one frame every 20 ms: the queued audio's next frame, or a silence frame (0xD5 A-law, 0xFF μ-law) when the worker's own buffer is empty;
- at most `LEAD_FRAMES` (3) frames queued in Asterisk ahead of real time, so a barge-in's `FLUSH_MEDIA` drops at most 60 ms;
- paused on `MEDIA_XOFF`; resumed with a fresh lead on `MEDIA_XON`, and at once after a flush;
- whole frames only: a sentence's tail is padded with silence, and a remainder waits for the rest of its sentence (a streamed synthesis chunk is not padded on its own);
- `MARK_MEDIA` right after the sentence's last real frame. Silence frames carry no mark and count toward nothing but the clock.

It is pure (the call task feeds it its monotonic milliseconds), so it is tested on Windows.

Add `use std::collections::VecDeque;` to `media.rs`'s imports, and append:

```rust
/// The line's frame: 20 ms, `MEDIA_START`'s `optimal_frame_size` bytes (160 for G.711).
pub const FRAME_MS: u64 = 20;
/// Frames kept queued in Asterisk ahead of real time: enough to ride out a late tick, few enough
/// that a barge-in's `FLUSH_MEDIA` drops at most 60 ms.
pub const LEAD_FRAMES: u64 = 3;
/// Owing more frames than this (the worker's loop was held up) restarts the clock: the lead is
/// written again instead of a burst that would queue the stall's length in Asterisk.
const MAX_OWED_FRAMES: u64 = 2 * LEAD_FRAMES;

/// What the pacer writes to Asterisk, in this order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    /// One whole frame: queued audio, or silence (`silence: true`) when none is queued.
    Frame { bytes: Vec<u8>, silence: bool },
    /// A `MARK_MEDIA` with this correlation id, right after the last real frame queued before it.
    Mark(String),
}

#[derive(Debug)]
enum Queued {
    Frame(Vec<u8>),
    Mark(String),
}

/// The worker's playout buffer and its 20 ms clock (design addendum §3, B1 review). Since 22.9
/// `chan_websocket` sends nothing when the worker writes nothing, so the pacer writes one frame per
/// 20 ms from `MEDIA_START` for the whole call: the queued audio's next frame, or a silence frame
/// when none is queued. Pure: the call task feeds it its own monotonic milliseconds.
#[derive(Debug)]
pub struct Pacer {
    frame_bytes: usize,
    silence: Vec<u8>,
    queue: VecDeque<Queued>,
    /// The current sentence's bytes short of a whole frame.
    partial: Vec<u8>,
    /// Frames written since the clock's origin.
    written: u64,
    /// When frame 0 was due, in the caller's milliseconds (before 0 after a restart).
    origin_ms: i128,
    paused: bool,
}

impl Pacer {
    /// The pacer of a call whose media started at `now_ms`. `silence_byte` is the codec's encoding
    /// of a zero sample: 0xD5 (A-law) or 0xFF (μ-law).
    pub fn new(frame_bytes: usize, silence_byte: u8, now_ms: u64) -> Pacer {
        let frame_bytes = frame_bytes.max(1);
        Pacer {
            frame_bytes,
            silence: vec![silence_byte; frame_bytes],
            queue: VecDeque::new(),
            partial: Vec::new(),
            written: 0,
            origin_ms: i128::from(now_ms),
            paused: false,
        }
    }

    /// Queues encoded audio as whole frames; a remainder waits for the rest of its sentence.
    pub fn audio(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let whole = self.partial.len() / self.frame_bytes * self.frame_bytes;
        let rest = self.partial.split_off(whole);
        for frame in self.partial.chunks(self.frame_bytes) {
            self.queue.push_back(Queued::Frame(frame.to_vec()));
        }
        self.partial = rest;
    }

    /// Ends a sentence: its last frame is padded with silence, then the mark is queued after it.
    pub fn mark(&mut self, correlation: impl Into<String>) {
        if !self.partial.is_empty() {
            let mut last = std::mem::take(&mut self.partial);
            last.resize(self.frame_bytes, self.silence[0]);
            self.queue.push_back(Queued::Frame(last));
        }
        self.queue.push_back(Queued::Mark(correlation.into()));
    }

    /// Whether any real audio or mark is still queued.
    pub fn is_idle(&self) -> bool {
        self.queue.is_empty() && self.partial.is_empty()
    }

    /// A barge-in: drops everything queued (the caller sends `FLUSH_MEDIA`, which drops the at
    /// most `LEAD_FRAMES` Asterisk holds) and restarts the clock, so the next `due` writes the lead
    /// of silence at once.
    pub fn flush(&mut self, now_ms: u64) {
        self.queue.clear();
        self.partial.clear();
        self.restart(now_ms);
    }

    /// `MEDIA_XOFF`: nothing is written until [`Pacer::resume`].
    pub fn pause(&mut self) {
        self.paused = true;
    }

    /// `MEDIA_XON`: writing resumes with a fresh lead, not a burst of the paused time.
    pub fn resume(&mut self, now_ms: u64) {
        self.paused = false;
        self.restart(now_ms);
    }

    /// What is due at `now_ms`: frames until `LEAD_FRAMES` ahead of the clock, real ones first and
    /// silence when none is queued, each mark right after the frame before it. Silence frames carry
    /// no mark and count toward nothing but the clock.
    pub fn due(&mut self, now_ms: u64) -> Vec<Out> {
        let mut out = Vec::new();
        if self.paused {
            return out;
        }
        if self.target(now_ms) > self.written + MAX_OWED_FRAMES {
            self.restart(now_ms);
        }
        let target = self.target(now_ms);
        self.marks(&mut out);
        while self.written < target {
            let frame = match self.queue.front() {
                Some(Queued::Frame(_)) => match self.queue.pop_front() {
                    Some(Queued::Frame(bytes)) => Out::Frame {
                        bytes,
                        silence: false,
                    },
                    _ => unreachable!("the front was a frame"),
                },
                _ => Out::Frame {
                    bytes: self.silence.clone(),
                    silence: true,
                },
            };
            out.push(frame);
            self.written += 1;
            self.marks(&mut out);
        }
        out
    }

    fn target(&self, now_ms: u64) -> u64 {
        let elapsed = (i128::from(now_ms) - self.origin_ms).max(0) / i128::from(FRAME_MS);
        u64::try_from(elapsed)
            .unwrap_or(u64::MAX)
            .saturating_add(LEAD_FRAMES)
    }

    fn restart(&mut self, now_ms: u64) {
        self.origin_ms = i128::from(now_ms) - i128::from(self.written) * i128::from(FRAME_MS);
    }

    fn marks(&mut self, out: &mut Vec<Out>) {
        while let Some(Queued::Mark(_)) = self.queue.front() {
            if let Some(Queued::Mark(m)) = self.queue.pop_front() {
                out.push(Out::Mark(m));
            }
        }
    }
}
```

`pad_to_frames` stays for its callers, but B6 no longer pads before the pacer: the pacer pads at the sentence's end.

`rust/bridge/voice/tests/pacer.rs`:

```rust
//! The media pacer (B1 review): one frame per 20 ms from `MEDIA_START`, silence when nothing is
//! queued, at most the lead ahead of Asterisk, paused by XOFF, back at once after a flush.
use jeeta_voice_bridge::media::{Out, Pacer};

fn frames(out: &[Out]) -> Vec<bool> {
    out.iter()
        .filter_map(|o| match o {
            Out::Frame { silence, .. } => Some(*silence),
            Out::Mark(_) => None,
        })
        .collect()
}

#[test]
fn silence_flows_from_media_start_one_frame_per_20_ms() {
    let mut p = Pacer::new(160, 0xD5, 1_000);
    let first = p.due(1_000);
    assert_eq!(first.len(), 3, "the lead at once");
    assert!(first.iter().all(|o| *o
        == Out::Frame {
            bytes: vec![0xD5; 160],
            silence: true
        }));
    assert!(p.due(1_019).is_empty());
    assert_eq!(frames(&p.due(1_020)), [true]);
    assert_eq!(
        frames(&p.due(1_100)),
        [true; 4],
        "8 written by 100 ms: 5 periods and the lead"
    );
    assert_eq!(
        Pacer::new(160, 0xFF, 0).due(0)[0],
        Out::Frame {
            bytes: vec![0xFF; 160],
            silence: true
        }
    );
}

#[test]
fn audio_goes_in_whole_frames_and_a_sentence_tail_is_padded_before_its_mark() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 250]);
    p.audio(&[0x22; 150]); // 400 bytes: two whole frames and 80 waiting for the sentence's end
    p.mark("7:0");
    let out = p.due(0);
    let mut tail = vec![0x22; 80];
    tail.resize(160, 0xD5);
    let mut second = vec![0x11; 90];
    second.extend([0x22; 70]);
    assert_eq!(
        out,
        [
            Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            },
            Out::Frame {
                bytes: second,
                silence: false
            },
            Out::Frame {
                bytes: tail,
                silence: false
            },
            Out::Mark("7:0".into()),
        ]
    );
    assert!(p.is_idle());
    assert_eq!(
        frames(&p.due(20)),
        [true],
        "silence again, and no mark for it"
    );
}

#[test]
fn asterisk_never_holds_more_than_the_lead() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 1_600]);
    p.mark("1:0");
    assert_eq!(frames(&p.due(0)), [false; 3]);
    for t in 1..=6 {
        assert_eq!(
            p.due(t * 20),
            [Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            }],
            "one per period"
        );
    }
    // The tenth and last frame at 140 ms, its mark right after it; then silence.
    assert_eq!(
        p.due(140),
        [
            Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            },
            Out::Mark("1:0".into())
        ]
    );
    assert_eq!(frames(&p.due(160)), [true]);
}

#[test]
fn a_flush_drops_the_queue_and_writes_the_lead_of_silence_at_once() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 1_600]);
    p.mark("1:0");
    p.due(0);
    p.due(20);
    p.audio(&[0x33; 10]);
    p.flush(30);
    assert!(p.is_idle());
    let out = p.due(30);
    assert_eq!(
        frames(&out),
        [true; 3],
        "no real frame and no mark survive the flush"
    );
    assert!(p.due(49).is_empty());
    assert_eq!(frames(&p.due(50)), [true]);
}

#[test]
fn xoff_pauses_and_xon_resumes_with_the_lead_not_a_burst() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    p.pause();
    assert!(p.due(400).is_empty());
    p.resume(600);
    assert_eq!(frames(&p.due(600)), [true; 3]);
    assert_eq!(frames(&p.due(620)), [true]);
}

#[test]
fn a_held_up_loop_restarts_the_clock_instead_of_bursting() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    assert_eq!(frames(&p.due(60)).len(), 3, "a late tick is caught up");
    assert_eq!(
        frames(&p.due(2_000)).len(),
        3,
        "a 2 s stall: the lead again, not 97 frames"
    );
    assert_eq!(frames(&p.due(2_020)).len(), 1);
}

#[test]
fn a_mark_with_nothing_queued_goes_out_at_once() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    p.mark("2:0");
    assert_eq!(p.due(0), [Out::Mark("2:0".into())]);
}
```

`rust/bridge/voice/src/speech.rs`:

```rust
//! The two local speech services (design addendum §6): where they listen (a unix socket in
//! production, TCP loopback in tests) and their messages. `Heard`'s `Debug` never prints a word.

use std::path::PathBuf;
use std::pin::Pin;
use std::str::FromStr;

use jt_calls::EndpointBy;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Unix(PathBuf),
    Tcp(String),
}

impl FromStr for Endpoint {
    type Err = ();
    fn from_str(s: &str) -> Result<Endpoint, ()> {
        if let Some(path) = s.strip_prefix("unix:") {
            return Ok(Endpoint::Unix(path.into()));
        }
        if let Some(addr) = s.strip_prefix("tcp:") {
            return Ok(Endpoint::Tcp(addr.to_owned()));
        }
        Err(())
    }
}

pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

pub type Socket = WebSocketStream<Pin<Box<dyn Stream>>>;

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("the speech service is unreachable")]
    Unreachable,
    #[error("unix sockets are not available on this system")]
    Unsupported,
    #[error("the speak service did not say hello")]
    NoHello,
    #[error("the speech service's socket is held by another user")]
    WrongPeer,
}

/// The users the speech services run as (B3 uid 1501, B2 uid 1502). A unix socket whose peer is
/// another user is refused: a service that took the other's socket name is never talked to (the
/// B3 review, I4; listen also sits in a directory of its own that speak cannot write).
pub const LISTEN_UID: u32 = 1501;
pub const SPEAK_UID: u32 = 1502;

/// A WebSocket to the service at `endpoint`; on a unix socket its peer must run as `owner`.
pub async fn connect(endpoint: &Endpoint, owner: u32) -> Result<Socket, SpeechError> {
    let stream: Pin<Box<dyn Stream>> = match endpoint {
        Endpoint::Tcp(addr) => {
            let _ = owner; // loopback TCP is for tests only; it carries no peer credential
            Box::pin(tokio::net::TcpStream::connect(addr).await.map_err(|_| SpeechError::Unreachable)?)
        }
        #[cfg(unix)]
        Endpoint::Unix(path) => {
            let s = tokio::net::UnixStream::connect(path).await.map_err(|_| SpeechError::Unreachable)?;
            if s.peer_cred().map(|c| c.uid()).ok() != Some(owner) {
                return Err(SpeechError::WrongPeer);
            }
            Box::pin(s)
        }
        #[cfg(not(unix))]
        Endpoint::Unix(_) => return Err(SpeechError::Unsupported),
    };
    tokio_tungstenite::client_async("ws://localhost/", stream)
        .await
        .map(|(s, _)| s)
        .map_err(|_| SpeechError::Unreachable)
}

/// How long the speak service may take to send its `hello`.
const HELLO_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// A WebSocket to the speak service and the voice id of its `hello`.
pub async fn connect_speaker(endpoint: &Endpoint) -> Result<(Socket, String), SpeechError> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let mut socket = connect(endpoint, SPEAK_UID).await?;
    match tokio::time::timeout(HELLO_WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<Spoken>(&t) {
            Ok(Spoken::Hello { voice_id }) => Ok((socket, voice_id)),
            _ => Err(SpeechError::NoHello),
        },
        _ => Err(SpeechError::NoHello),
    }
}

/// What the listener heard.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Heard {
    SpeechStart { audio_ms: u64 },
    SpeechEnd { audio_ms: u64 },
    Resume { audio_ms: u64 },
    Partial { text: String },
    Final {
        text: String,
        #[serde(default)]
        confidence: Option<f32>,
        speech_end_ms: u64,
        endpoint_ms: u64,
        endpoint_by: EndpointBy,
        stt_ms: u32,
    },
    Unheard { audio_ms: u64 },
}

impl std::fmt::Debug for Heard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Heard::SpeechStart { audio_ms } => write!(f, "SpeechStart({audio_ms})"),
            Heard::SpeechEnd { audio_ms } => write!(f, "SpeechEnd({audio_ms})"),
            Heard::Resume { audio_ms } => write!(f, "Resume({audio_ms})"),
            Heard::Partial { .. } => write!(f, "Partial"),
            Heard::Final { endpoint_ms, endpoint_by, .. } => {
                write!(f, "Final(endpoint_ms: {endpoint_ms}, by: {endpoint_by:?})")
            }
            Heard::Unheard { audio_ms } => write!(f, "Unheard({audio_ms})"),
        }
    }
}

/// To the listener.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToListener {
    Start { sample_rate: u32, hotwords: Vec<String> },
    Playback { active: bool },
}

/// To the speaker.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToSpeaker {
    Synth { id: String, text: String },
    Cancel { id: String },
}

/// From the speaker (besides the binary PCM16 chunks). Every frame of a synthesis comes before its
/// terminal message (`done`, `cancelled` or `error`), and a synthesis starts only after the previous
/// one's: after a cancel the client drops frames until that id's terminal message, whichever it is
/// (a cancel can lose the race to `done`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Spoken {
    /// The first message on every connection: the voice id keys the phrase cache.
    Hello { voice_id: String },
    Done { id: String, synth_ms: u32, audio_ms: u32 },
    Cancelled { id: String },
    Error {
        #[serde(default)]
        id: Option<String>,
        reason: String,
    },
}
```

The peer check (B3 review, I4) has a `cfg(unix)` test of its own in `tests/adapters.rs`: a
`tokio::net::UnixListener` the test binds in a temporary directory; `connect(&Endpoint::Unix(path),
own_uid)` succeeds and `connect(&Endpoint::Unix(path), own_uid + 1)` is `SpeechError::WrongPeer`
(`own_uid` from `std::os::unix::fs::MetadataExt::uid` of the socket file, so no `libc` is needed).

In `lib.rs` add the modules and extend the module map:

```rust
pub mod ari;
pub mod cache;
pub mod config;
pub mod media;
pub mod speech;
pub mod trace;
```

```rust
//! - [`config`], [`cache`], [`trace`]: the environment, the phrase cache, the turn traces.
//! - [`ari`], [`media`], [`speech`]: Asterisk's REST and events, `chan_websocket` media control,
//!   the local speech services.
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p jeeta-voice-bridge` and `cargo clippy -p jeeta-voice-bridge --all-targets -- -D warnings`
Expected: `adapters` 8 passed, `pacer` 7 passed, the earlier files unchanged, clippy clean.

- [ ] **Step 6: Commit**

```bash
git add rust/bridge/voice
git commit -m "feat(voice-bridge): configuration, phrase cache, turn traces, ARI, media and speech adapters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**B5 as built (2026-10-30, commits `14652911` and `aade9c37`).** The steps ran as written, test first; the code is the plan's, reflowed by rustfmt. What differs:
- Step 1 failed with E0432 (`could not find ari in jeeta_voice_bridge`, and the same for the other five modules). The pacer went into a commit of its own: with the rest of `media.rs` in place, `tests/pacer.rs` failed with E0432 on `media::Out` and `media::Pacer` before the pacer was written.
- `tests/adapters.rs` has two more tests. One is the `cfg(unix)` peer check that the text above asks for (`a_unix_socket_held_by_another_user_is_refused`: the socket file's owner connects, and that uid plus one is `WrongPeer`). The other, `the_speakers_hello_names_its_voice` (TCP, both systems), checks that the voice id comes from the `hello`, and that a service whose first message is anything else is `NoHello`. So `adapters` is 9 on Windows and 10 on Linux, not 8.
- Code, against the draft:
  - `parse_control` reads `optimal_frame_size` with `usize::try_from`, not `as`.
  - `Pacer::due` takes the front frame after a `matches!` check instead of `unreachable!`, so the pacer cannot panic.
  - `Ari::connect` marks the `Authorization` header sensitive (`HeaderValue::set_sensitive`), so a `Debug` of the request shows no credential.
  - Docs only: `config.rs` lists every variable and its default, each public item has a doc line, and `lib.rs`'s Logging paragraph names `speech::Heard` (no word) and `config::Config` (no key, no password).
- No manifest change: B4's `Cargo.toml` already holds every dependency B5 uses.
- B5 makes no log call yet, and `tests/logging.rs` passes on the six new files. `AriEvent` and `MediaEvent` keep their derived `Debug`, which holds the key pressed, as `tests/logging.rs` expects: its `?` rule keeps them out of the logs.
- Not done here: design §2 and the B3 review (I4) say speak's socket moves to a directory of its own "with B5". B5's steps have no such step, and D2's `bridge.env.example` keeps `SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock`, the config's default. The move is server work (speak's unit, tmpfiles, its mount and its tests), so it stays open for the coordinator. Until then the bridge finds speak through `SPEAK_SOCKET`, and the peer check (uid 1502) holds.
- Carried over from B4's re-review (commit `a2aaa925`): the talker's docs and design §3 said the fault sentence waits "3 s at most". In fact `start_next` starts nothing while the caller speaks. So the sentence waits for the caller's pause (200 ms of silence). In a pause of an open turn, it waits for the turn to close, until `FAULT_WAIT_MS` after the loss; after that it starts at the next pause. A caller who never pauses holds it back until the listener's 30 s cut. The behaviour stays (playing over a talking caller is worse). The docs now say so, and `the_fault_sentence_waits_for_the_callers_pause_past_three_seconds` pins it.
- Checks on Windows: `cargo test -p jeeta-voice-bridge` gives adapters 9, g711 5, logging 3, netgsm 4, pacer 7, redaction 4, talker 27 and text 11 (70). Clippy (`--all-targets -D warnings`), `cargo fmt --all -- --check` and `cargo doc --no-deps` (`-D warnings`) are clean. On Linux (CI on PR #382, run 40963551097), `rust-checks` (fmt, workspace clippy, doc, deny) and `rust-test` pass, with adapters 10 (the unix peer test included) and the same counts otherwise (71).


### Task B6: One call's task, and the standalone `slice`

**Files:**
- Create: `rust/bridge/voice/src/call.rs`
- Create: `rust/bridge/voice/src/slice.rs`
- Create: `rust/bridge/voice/src/main.rs`
- Create: `rust/bridge/voice/tests/support/mod.rs`
- Create: `rust/bridge/voice/tests/call.rs`
- Modify: `rust/bridge/voice/src/ari.rs` (a separate WebSocket base for tests)
- Modify: `rust/bridge/voice/src/lib.rs`

- [ ] **Step 1: Let ARI's WebSocket base be set apart (tests serve REST and WebSocket on two ports)**

In `ari.rs`, add a field `ws_base: String` to `Ari`, set it in `new` to `base.trim_end_matches('/').replacen("http", "ws", 1)`, replace the body of `fn ws_base(&self)` with `self.ws_base.clone()`, and add:

```rust
    /// The same ARI with its WebSocket endpoints (events, media) at `ws_base` (`ws://host:port`).
    pub fn with_ws_base(mut self, ws_base: &str) -> Ari {
        self.ws_base = ws_base.trim_end_matches('/').to_owned();
        self
    }
```

- [ ] **Step 2: Write the test fakes and the failing call test**

`rust/bridge/voice/tests/support/mod.rs`:

```rust
//! Fakes of Asterisk (ARI over HTTP, media over WebSocket) and of the two speech services.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

pub type Log = Arc<Mutex<Vec<String>>>;

/// A fake ARI REST surface; every request is logged as `METHOD path query`.
pub async fn fake_ari() -> (String, Log) {
    let log: Log = Arc::default();
    async fn record(State(log): State<Log>, line: String) {
        log.lock().unwrap().push(line);
    }
    let app = Router::new()
        .route(
            "/ari/channels",
            post(|State(log): State<Log>, Query(q): Query<Vec<(String, String)>>| async move {
                record(State(log), format!("POST /ari/channels {q:?}")).await;
                axum::Json(json!({ "id": "c-1" }))
            })
            .get(|| async { axum::Json(json!([])) }),
        )
        .route(
            "/ari/channels/externalMedia",
            post(|State(log): State<Log>| async move {
                record(State(log), "POST externalMedia".into()).await;
                axum::Json(json!({}))
            }),
        )
        .route(
            "/ari/channels/{id}/variable",
            get(|| async { axum::Json(json!({ "value": "conn-1" })) }),
        )
        .route("/ari/channels/{id}", delete(|State(log): State<Log>, Path(id): Path<String>| async move {
            record(State(log), format!("DELETE channel {id}")).await;
            StatusCode::NO_CONTENT
        }))
        .route("/ari/bridges", post(|| async { axum::Json(json!({})) }))
        .route("/ari/bridges/{id}/addChannel", post(|| async { StatusCode::NO_CONTENT }))
        .route("/ari/bridges/{id}", delete(|| async { StatusCode::NO_CONTENT }))
        .with_state(log.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, log)
}

/// A WebSocket server handing every accepted connection to the test.
pub async fn ws_server() -> (String, mpsc::Receiver<WebSocketStream<TcpStream>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                let _ = tx.send(ws).await;
            }
        }
    });
    (addr, rx)
}

/// Says hello, then answers every `synth` on every connection with 160 samples of silence and `done`.
pub fn serve_speaker(mut conns: mpsc::Receiver<WebSocketStream<TcpStream>>) {
    tokio::spawn(async move {
        while let Some(mut ws) = conns.recv().await {
            tokio::spawn(async move {
                let hello = json!({ "type": "hello", "voice_id": "test-voice", "sample_rate": 8000, "format": "pcm16le" });
                let _ = ws.send(Message::Text(hello.to_string().into())).await;
                while let Some(Ok(Message::Text(t))) = ws.next().await {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["type"] == "synth" {
                        let _ = ws.send(Message::Binary(vec![0u8; 320].into())).await;
                        let done = json!({ "type": "done", "id": v["id"], "synth_ms": 5, "audio_ms": 20 });
                        let _ = ws.send(Message::Text(done.to_string().into())).await;
                    }
                }
            });
        }
    });
}

/// Starts the media of the first connection (`MEDIA_START`, A-law) and answers each `MARK_MEDIA`
/// with `MEDIA_MARK_PROCESSED`; the control commands it received go to the returned channel.
pub fn serve_media(mut conns: mpsc::Receiver<WebSocketStream<TcpStream>>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        let Some(mut ws) = conns.recv().await else { return };
        let start = json!({ "event": "MEDIA_START", "connection_id": "conn-1", "channel": "WebSocket/x",
            "channel_id": "c-1-m", "format": "alaw", "optimal_frame_size": 160, "ptime": 20 });
        ws.send(Message::Text(start.to_string().into())).await.unwrap();
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                let name = v["command"].as_str().unwrap_or_default().to_owned();
                if name == "MARK_MEDIA" {
                    let done = json!({ "event": "MEDIA_MARK_PROCESSED", "channel_id": "c-1-m",
                        "correlation_id": v["correlation_id"] });
                    ws.send(Message::Text(done.to_string().into())).await.unwrap();
                }
                let _ = tx.send(name).await;
            }
        }
    });
    rx
}
```

`rust/bridge/voice/tests/call.rs`:

```rust
//! One call against fake Asterisk and speech services: dial, answer, the core's opening played to
//! its mark, a caller turn reported and acknowledged, the agent's sentence, the closing hang-up.
mod support;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jeeta_voice_bridge::ari::{Ari, AriEvent};
use jeeta_voice_bridge::call::{CallDeps, CallSetup, Report, ToCall, run_call};
use jeeta_voice_bridge::speech::Endpoint;
use jeeta_voice_bridge::talker::Timing;
use jt_calls::{BridgeEvent, Command, DialScript, PhraseSet, PlayKind};
use serde_json::json;
use support::*;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

async fn next(reports: &mut mpsc::Receiver<Report>) -> Report {
    tokio::time::timeout(Duration::from_secs(3), reports.recv()).await.expect("a report in time").expect("open")
}

#[tokio::test]
async fn a_call_dials_plays_hears_acknowledges_and_hangs_up() {
    let (ari_base, log) = fake_ari().await;
    let (media_addr, media_conns) = ws_server().await;
    let (listen_addr, mut listen_conns) = ws_server().await;
    let (speak_addr, speak_conns) = ws_server().await;
    serve_speaker(speak_conns);
    let mut controls = serve_media(media_conns);
    let cache = std::env::temp_dir().join(format!("voice-call-{}", std::process::id()));
    let deps = Arc::new(CallDeps {
        ari: Arc::new(Ari::new(&ari_base, "u", "p").with_ws_base(&format!("ws://{media_addr}"))),
        listen: Endpoint::Tcp(listen_addr),
        speak: Endpoint::Tcp(speak_addr),
        cache_dir: cache.clone(),
        timing: Timing::default(),
        traces: None,
    });
    let (to_call, rx) = mpsc::channel(16);
    let (reports_tx, mut reports) = mpsc::channel(64);
    let setup = CallSetup {
        bridge_call_id: "c-1".into(),
        dial: "05321234567".into(),
        script: DialScript::default(),
        plan_lines: vec!["Ada Hanım ile mi görüşüyorum?".into()],
    };
    let task = tokio::spawn(run_call(deps, setup, rx, reports_tx));

    // The dial goes to the PBX in national form.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let dialled = log.lock().unwrap().join("\n");
    assert!(dialled.contains("PJSIP/05321234567@netgsm"), "{dialled}");

    to_call.send(ToCall::Ari(AriEvent::Answered { channel: "c-1".into(), inbound: false })).await.unwrap();
    assert_eq!(next(&mut reports).await.event, BridgeEvent::Answered);
    let mut listener = tokio::time::timeout(Duration::from_secs(3), listen_conns.recv()).await.unwrap().unwrap();
    let start = listener.next().await.unwrap().unwrap();
    assert!(matches!(start, Message::Text(ref t) if t.contains("\"start\"")));
    let (mut listen_tx, mut listen_rx) = listener.split();
    tokio::spawn(async move { while listen_rx.next().await.is_some() {} });

    // The core's opening plays to its mark.
    let opening = Command::Play { seq: 2, clip: PlayKind::Opening, index: 0, text: "Ada Hanım ile mi görüşüyorum?".into() };
    to_call.send(ToCall::Command(opening)).await.unwrap();
    let said = next(&mut reports).await.event;
    assert_eq!(said, BridgeEvent::Said { seq: 2, interrupted_at_char: None, tts_ms: None });

    // The caller's turn is reported, then acknowledged by the bridge on its own.
    let final_ = json!({ "type": "final", "text": "evet benim", "speech_end_ms": 0, "endpoint_ms": 260,
        "endpoint_by": "smart_turn", "stt_ms": 40 });
    listen_tx.send(Message::Text(final_.to_string().into())).await.unwrap();
    let utterance = next(&mut reports).await;
    assert!(matches!(utterance.event, BridgeEvent::Utterance { ref text, is_final: true, .. } if text == "evet benim"));
    utterance.taken.unwrap().send(()).unwrap();
    let ack = next(&mut reports).await.event;
    assert_eq!(ack, BridgeEvent::Phrase { set: PhraseSet::Acknowledgement, index: 0 });

    // The agent speaks, then the core hangs up.
    to_call.send(ToCall::Command(Command::Say { seq: 4, text: "Harika.".into(), allow_barge_in: true })).await.unwrap();
    assert_eq!(next(&mut reports).await.event, BridgeEvent::Said { seq: 4, interrupted_at_char: None, tts_ms: None });
    to_call.send(ToCall::Command(Command::Hangup)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(log.lock().unwrap().iter().any(|l| l == "DELETE channel c-1"));
    to_call.send(ToCall::Ari(AriEvent::Gone { channel: "c-1".into(), cause: Some(16) })).await.unwrap();
    assert_eq!(next(&mut reports).await.event, BridgeEvent::Hangup { cause: "normal".into() });
    let BridgeEvent::Trace { trace } = next(&mut reports).await.event else { panic!("a trace") };
    assert_eq!(trace.endpoint_ms, 260);
    assert!(trace.ack_ms.is_some() && trace.say_ms.is_some() && trace.first_audio_ms.is_some());
    assert_eq!(trace.reply_seq, Some(4));
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    let sent: Vec<String> = std::iter::from_fn(|| controls.try_recv().ok()).collect();
    assert!(sent.iter().any(|c| c == "MARK_MEDIA"));
    let _ = std::fs::remove_dir_all(cache);
}
```

Run: `cargo test -p jeeta-voice-bridge --test call`
Expected: FAIL to compile (`could not find call in jeeta_voice_bridge`).

- [ ] **Step 3: Write `call.rs`**

```rust
//! One call's task (design addendum §3): it dials through ARI, waits for the answer, connects the
//! call's media (`chan_websocket`), the listener and the speaker, and runs the talker until the line
//! closes, reporting each event as a [`Report`] (to the core in `run`, to the console in `slice`).
//! It never logs a number or a word.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use jt_calls::{BridgeEvent, Command, DialScript, PhraseSet, PlayKind};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::ari::{self, Ari, AriEvent};
use crate::cache::PhraseCache;
use crate::g711::Codec;
use crate::media::{self, MediaEvent};
use crate::netgsm;
use crate::speech::{self, Endpoint, Heard, Spoken, ToListener, ToSpeaker};
use crate::talker::{Action, Input, Item, Source, Talker, Timing};
use crate::text::{self, Sentence};
use crate::trace::{AudioClock, TraceFile, TurnMarks};

/// How long after the closing's end the line is hung up.
const HANGUP_TAIL: Duration = Duration::from_millis(400);
/// How long the answered line may take to bring its media up.
const MEDIA_SETUP: Duration = Duration::from_secs(3);
/// How long the PBX may ring.
const RING_TIMEOUT_S: u32 = 45;
const SAMPLE_RATE: u64 = 8_000;

pub struct CallDeps {
    pub ari: Arc<Ari>,
    pub listen: Endpoint,
    pub speak: Endpoint,
    pub cache_dir: PathBuf,
    pub timing: Timing,
    pub traces: Option<TraceFile>,
}

pub struct CallSetup {
    pub bridge_call_id: String,
    /// The number as the PBX dials it (`netgsm::dial_string`).
    pub dial: String,
    pub script: DialScript,
    /// The plan's sentences (opening first), synthesised ahead into this call's memory.
    pub plan_lines: Vec<String>,
}

pub enum ToCall {
    Command(Command),
    Ari(AriEvent),
    CoreLost,
}

/// An event of the call, and a way to hear when it was taken (the core answered its report).
pub struct Report {
    pub bridge_call_id: String,
    pub event: BridgeEvent,
    pub taken: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct Reporter {
    id: String,
    tx: mpsc::Sender<Report>,
}

impl Reporter {
    async fn send(&self, event: BridgeEvent) {
        let _ = self.tx.send(Report { bridge_call_id: self.id.clone(), event, taken: None }).await;
    }

    async fn send_taken(&self, event: BridgeEvent) -> oneshot::Receiver<()> {
        let (taken, rx) = oneshot::channel();
        let _ = self.tx.send(Report { bridge_call_id: self.id.clone(), event, taken: Some(taken) }).await;
        rx
    }
}

fn text_message<T: Serialize>(value: &T) -> Message {
    Message::Text(serde_json::to_string(value).unwrap_or_default().into())
}

fn pcm16(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
}

fn audio_duration(samples: usize) -> Duration {
    Duration::from_millis(samples as u64 * 1_000 / SAMPLE_RATE)
}

fn parse_mark(correlation: &str) -> Option<(u64, usize)> {
    let (item, index) = correlation.split_once(':')?;
    Some((item.parse().ok()?, index.parse().ok()?))
}

/// The sentences of the policy's texts: kept on disk once synthesised.
fn policy_sentences(script: &DialScript) -> HashSet<String> {
    script
        .lines
        .iter()
        .map(String::as_str)
        .chain(script.phrases.all())
        .flat_map(|t| text::sentences(t).into_iter().map(|s| s.text))
        .collect()
}

/// What to synthesise ahead, most urgent first: the plan's opening, the policy's lines, the
/// phrases (acknowledgements first), then the rest of the plan.
fn presynth_order(setup: &CallSetup) -> Vec<String> {
    let mut out: Vec<String> = setup.plan_lines.iter().take(1).cloned().collect();
    out.extend(setup.script.lines.iter().cloned());
    out.extend(setup.script.phrases.all().map(str::to_owned));
    out.extend(setup.plan_lines.iter().skip(1).cloned());
    out
}

async fn presynthesize(socket: speech::Socket, cache: Arc<Mutex<PhraseCache>>, persist: Arc<HashSet<String>>, texts: Vec<String>) {
    let (mut tx, mut rx) = socket.split();
    let mut n = 0u32;
    for t in texts {
        for sentence in text::sentences(&t) {
            let cached = cache.lock().map(|mut c| c.get(&sentence.text).is_some()).unwrap_or(false);
            if cached {
                continue;
            }
            n += 1;
            let id = format!("pre:{n}");
            if tx.send(text_message(&ToSpeaker::Synth { id, text: sentence.text.clone() })).await.is_err() {
                return;
            }
            let mut pcm = Vec::new();
            loop {
                match rx.next().await {
                    Some(Ok(Message::Binary(b))) => pcm.extend(pcm16(&b)),
                    Some(Ok(Message::Text(m))) => {
                        if let Ok(spoken) = serde_json::from_str::<Spoken>(&m) {
                            if matches!(spoken, Spoken::Done { .. }) && !pcm.is_empty() {
                                if let Ok(mut c) = cache.lock() {
                                    c.put(&sentence.text, std::mem::take(&mut pcm), persist.contains(&sentence.text));
                                }
                            }
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => return,
                }
            }
        }
    }
}

/// Runs call `setup` until its line closes (see the module docs).
pub async fn run_call(deps: Arc<CallDeps>, setup: CallSetup, mut rx: mpsc::Receiver<ToCall>, reports: mpsc::Sender<Report>) {
    let id = setup.bridge_call_id.clone();
    let reporter = Reporter { id: id.clone(), tx: reports };
    // The speaker's hello names the voice this call's cache keys by; without a speaker, no dial.
    let Ok((pre, voice)) = speech::connect_speaker(&deps.speak).await else {
        warn!(call = %id, "the speaker is unreachable");
        reporter.send(BridgeEvent::Error { failure_line: "transient: bridge: the speaker is unreachable".into() }).await;
        return;
    };
    let cache = Arc::new(Mutex::new(PhraseCache::new(deps.cache_dir.clone(), &voice)));
    let persist = Arc::new(policy_sentences(&setup.script));
    tokio::spawn(presynthesize(pre, cache.clone(), persist.clone(), presynth_order(&setup)));
    let endpoint = format!("PJSIP/{}@netgsm", setup.dial);
    if deps.ari.originate(&id, &endpoint, RING_TIMEOUT_S).await.is_err() {
        warn!(call = %id, "Asterisk refused the dial");
        reporter
            .send(BridgeEvent::Error { failure_line: "transient: bridge: the line refused the dial".into() })
            .await;
        return;
    }
    info!(call = %id, "dialling");
    let mut early = Vec::new();
    loop {
        match rx.recv().await {
            None => {
                let _ = deps.ari.hangup(&id).await;
                return;
            }
            Some(ToCall::Ari(AriEvent::Ringing { channel })) if channel == id => reporter.send(BridgeEvent::Ringing).await,
            Some(ToCall::Ari(AriEvent::Answered { channel, .. })) if channel == id => break,
            Some(ToCall::Ari(AriEvent::Gone { channel, cause })) if channel == id => {
                info!(call = %id, cause = ?cause, "the line closed before an answer");
                // A number that cannot be called at all fails for good (B4 review M5).
                let event = match netgsm::permanent_failure(cause, false) {
                    Some(line) => BridgeEvent::Error { failure_line: line.into() },
                    None => BridgeEvent::Hangup { cause: netgsm::hangup_cause(cause, false).into() },
                };
                reporter.send(event).await;
                return;
            }
            Some(ToCall::Command(Command::Hangup)) => {
                let _ = deps.ari.hangup(&id).await;
            }
            Some(ToCall::Command(c)) => early.push(c),
            Some(_) => {}
        }
    }
    reporter.send(BridgeEvent::Answered).await;
    info!(call = %id, "answered");
    match Live::connect(&deps, &setup, cache, persist, reporter.clone()).await {
        Ok(live) => live.run(rx, early).await,
        Err(reason) => {
            warn!(call = %id, reason, "the call's media did not come up");
            reporter.send(BridgeEvent::Error { failure_line: format!("transient: bridge: {reason}") }).await;
            let _ = deps.ari.hangup(&id).await;
        }
    }
    let _ = deps.ari.destroy_bridge(&format!("{id}-b")).await;
    let _ = deps.ari.hangup(&format!("{id}-m")).await;
}

struct InFlight {
    index: usize,
    id: String,
    pcm: Vec<i16>,
}

struct Playing {
    item: Item,
    sentences: Vec<Sentence>,
    next: usize,
    in_flight: Option<InFlight>,
    marked: usize,
    mark_at: Instant,
    audio_started: Option<Instant>,
    durations: Vec<Duration>,
}

type MediaSink = SplitSink<ari::Socket, Message>;
type SpeechSink = SplitSink<speech::Socket, Message>;

struct Live {
    deps: Arc<CallDeps>,
    id: String,
    reporter: Reporter,
    cache: Arc<Mutex<PhraseCache>>,
    persist: Arc<HashSet<String>>,
    talker: Talker,
    started: Instant,
    codec: Codec,
    frame_bytes: usize,
    media_tx: MediaSink,
    media_rx: Option<SplitStream<ari::Socket>>,
    listen_tx: SpeechSink,
    listen_rx: Option<SplitStream<speech::Socket>>,
    speak_tx: SpeechSink,
    speak_rx: Option<SplitStream<speech::Socket>>,
    /// The id of a cancelled synthesis whose terminal message has not come yet: until it does,
    /// every binary frame from the speaker is that synthesis's and is dropped.
    draining: Option<String>,
    xoff: bool,
    held: Vec<Message>,
    playing: Option<Playing>,
    clock: AudioClock,
    marks: Option<TurnMarks>,
    onset: Option<Instant>,
    cut_reply: bool,
    pending_delivered: Option<oneshot::Receiver<()>>,
    pending_hangup: bool,
    /// When the line was answered, and whether the first audio after it was logged.
    answered: Instant,
    opening_logged: bool,
}

impl Live {
    async fn connect(
        deps: &Arc<CallDeps>,
        setup: &CallSetup,
        cache: Arc<Mutex<PhraseCache>>,
        persist: Arc<HashSet<String>>,
        reporter: Reporter,
    ) -> Result<Live, &'static str> {
        let answered = Instant::now();
        let id = setup.bridge_call_id.clone();
        let media_id = format!("{id}-m");
        deps.ari.external_media(&media_id, "alaw").await.map_err(|_| "external media refused")?;
        let connection = deps
            .ari
            .variable(&media_id, "MEDIA_WEBSOCKET_CONNECTION_ID")
            .await
            .map_err(|_| "no media connection id")?;
        deps.ari.mix(&format!("{id}-b"), &[&id, &media_id]).await.map_err(|_| "the mixing bridge was refused")?;
        let media = deps.ari.media(&connection).await.map_err(|_| "media unreachable")?;
        let (media_tx, mut media_rx) = media.split();
        let started = tokio::time::timeout(MEDIA_SETUP, async {
            while let Some(Ok(msg)) = media_rx.next().await {
                if let Message::Text(t) = msg
                    && let MediaEvent::Start { format, frame_bytes } = media::parse_control(&t)
                {
                    return Codec::from_format(&format).map(|c| (c, frame_bytes));
                }
            }
            None
        })
        .await;
        let (codec, frame_bytes) = started.ok().flatten().ok_or("no media start")?;
        let listen = speech::connect(&deps.listen, speech::LISTEN_UID).await.map_err(|_| "listener unreachable")?;
        let (mut listen_tx, listen_rx) = listen.split();
        let start = ToListener::Start { sample_rate: 8_000, hotwords: setup.script.hotwords.clone() };
        listen_tx.send(text_message(&start)).await.map_err(|_| "listener refused the call")?;
        let (speak, live_voice) = speech::connect_speaker(&deps.speak).await.map_err(|_| "speaker unreachable")?;
        if let Ok(mut c) = cache.lock()
            && c.voice() != live_voice
        {
            // The speak service was replaced while the line rang: this call's audio is the new voice's.
            warn!(call = %id, "the speaker's voice changed during the call");
            *c = PhraseCache::new(deps.cache_dir.clone(), &live_voice);
        }
        let (speak_tx, speak_rx) = speak.split();
        Ok(Live {
            deps: deps.clone(),
            id,
            reporter,
            cache,
            persist,
            talker: Talker::new(deps.timing, setup.script.phrases.clone()),
            started: Instant::now(),
            codec,
            frame_bytes,
            media_tx,
            media_rx: Some(media_rx),
            listen_tx,
            listen_rx: Some(listen_rx),
            speak_tx,
            speak_rx: Some(speak_rx),
            draining: None,
            xoff: false,
            held: Vec::new(),
            playing: None,
            clock: AudioClock::default(),
            marks: None,
            onset: None,
            cut_reply: false,
            pending_delivered: None,
            pending_hangup: false,
            answered,
            opening_logged: false,
        })
    }

    async fn run(mut self, mut rx: mpsc::Receiver<ToCall>, early: Vec<Command>) {
        let mut media_rx = self.media_rx.take().expect("connected");
        let mut listen_rx = self.listen_rx.take().expect("connected");
        let mut speak_rx = self.speak_rx.take().expect("connected");
        for c in early {
            self.command(c).await;
        }
        let mut delivered: Option<oneshot::Receiver<()>> = None;
        let mut hangup_at: Option<tokio::time::Instant> = None;
        // A closed listener's stream resolves at once on every pass: its arm is disabled once it
        // ends, so the fault sentence it asks for plays instead of a tight loop (B4 review I2).
        let mut listening = true;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                m = media_rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => self.inbound_audio(&b).await,
                    Some(Ok(Message::Text(t))) => self.media_control(&t).await,
                    Some(Ok(_)) => {}
                    _ => {
                        warn!(call = %self.id, "the media closed");
                        break;
                    }
                },
                m = listen_rx.next(), if listening => match m {
                    Some(Ok(Message::Text(t))) => match serde_json::from_str::<Heard>(&t) {
                        Ok(h) => self.heard(h).await,
                        // A message this build cannot read inside a turn (an `error`, a kind it
                        // lacks): the turn's words are lost, so it ends as unheard (B4 re-review
                        // N3; the talker also closes a turn left open 35 s). The hello comes
                        // before any turn.
                        Err(_) if self.talker.turn_open() => self.input(Input::Unheard).await,
                        Err(_) => {}
                    },
                    Some(Ok(_)) => {}
                    _ => {
                        listening = false;
                        warn!(call = %self.id, "the listener closed");
                        let failure_line = "transient: bridge: the listener stopped during the call".to_owned();
                        self.reporter.send(BridgeEvent::Error { failure_line }).await;
                        self.input(Input::CoreLost).await;
                    }
                },
                m = speak_rx.next() => match m {
                    Some(Ok(Message::Binary(b))) => self.synth_chunk(&b).await,
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(s) = serde_json::from_str::<Spoken>(&t) {
                            self.synth_event(s).await;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => {
                        warn!(call = %self.id, "the speaker closed");
                        break;
                    }
                },
                c = rx.recv() => match c {
                    Some(ToCall::Command(c)) => self.command(c).await,
                    Some(ToCall::Ari(AriEvent::Dtmf { channel, digit })) if channel == self.id => {
                        self.reporter.send(BridgeEvent::Dtmf { digit }).await;
                    }
                    Some(ToCall::Ari(AriEvent::Gone { channel, .. })) if channel == self.id => {
                        self.reporter.send(BridgeEvent::Hangup { cause: "normal".into() }).await;
                        break;
                    }
                    Some(ToCall::Ari(_)) => {}
                    Some(ToCall::CoreLost) => {
                        // Reported first, so the core ends the session as failed when it is back.
                        let failure_line = "transient: bridge: the core was unreachable during the call".to_owned();
                        self.reporter.send(BridgeEvent::Error { failure_line }).await;
                        self.input(Input::CoreLost).await;
                    }
                    None => break,
                },
                r = async { delivered.as_mut().expect("guarded").await }, if delivered.is_some() => {
                    delivered = None;
                    if r.is_ok() && let Some(m) = self.marks.as_mut() {
                        m.delivered = Some(Instant::now());
                    }
                },
                _ = async { tokio::time::sleep_until(hangup_at.expect("guarded")).await }, if hangup_at.is_some() => {
                    hangup_at = None;
                    let _ = self.deps.ari.hangup(&self.id).await;
                },
                _ = tick.tick() => self.input(Input::Tick).await,
            }
            if let Some(r) = self.pending_delivered.take() {
                delivered = Some(r);
            }
            if std::mem::take(&mut self.pending_hangup) {
                hangup_at = Some(tokio::time::Instant::now() + HANGUP_TAIL);
            }
        }
        self.finish_turn().await;
        info!(call = %self.id, "ended");
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    async fn input(&mut self, input: Input) {
        let now = self.now_ms();
        for action in self.talker.on(input, now) {
            self.act(action).await;
        }
    }

    async fn act(&mut self, action: Action) {
        match action {
            Action::EchoGuard(active) => {
                let _ = self.listen_tx.send(text_message(&ToListener::Playback { active })).await;
            }
            Action::Play(item) => {
                if let Source::Phrase { set, index } = item.source {
                    self.reporter.send(BridgeEvent::Phrase { set, index }).await;
                }
                let mut sentences = text::sentences(&item.text);
                if sentences.is_empty() {
                    sentences.push(Sentence { start: 0, end: item.text.chars().count(), text: item.text.clone() });
                }
                self.playing = Some(Playing {
                    item,
                    sentences,
                    next: 0,
                    in_flight: None,
                    marked: 0,
                    mark_at: Instant::now(),
                    audio_started: None,
                    durations: Vec::new(),
                });
                self.advance().await;
            }
            Action::Done(item) => {
                if let Source::Core { seq, .. } = item.source {
                    self.reporter.send(BridgeEvent::Said { seq, interrupted_at_char: None, tts_ms: None }).await;
                }
            }
            Action::Cut { item, dropped } => self.cut(item, dropped).await,
            // Queued while the caller held them back, and dropped when the core was lost (B4 review M1).
            Action::Dropped(items) => {
                for d in items {
                    if let Source::Core { seq, .. } = d.source {
                        self.reporter.send(BridgeEvent::Said { seq, interrupted_at_char: Some(0), tts_ms: None }).await;
                    }
                }
            }
            Action::Hangup => self.pending_hangup = true,
        }
    }

    async fn send_media(&mut self, message: Message) {
        if self.xoff {
            self.held.push(message);
        } else {
            let _ = self.media_tx.send(message).await;
        }
    }

    /// Marks the turn's first sounds: the reply's first audio, a covering phrase's first audio.
    fn first_audio_marks(&mut self) {
        let Some(p) = self.playing.as_ref() else { return };
        if p.audio_started.is_some() {
            return;
        }
        let reply = matches!(p.item.source, Source::Core { agent: true, .. });
        let cover = matches!(
            p.item.source,
            Source::Phrase { set: PhraseSet::Acknowledgement | PhraseSet::Filler | PhraseSet::LongWait, .. }
        );
        let now = Instant::now();
        if let Some(m) = self.marks.as_mut() {
            if reply && m.first_audio.is_none() {
                m.first_audio = Some(now);
                m.tts_first.get_or_insert(now);
            }
            if cover && m.ack.is_none() {
                m.ack = Some(now);
            }
        }
    }

    async fn write_pcm(&mut self, pcm: &[i16]) {
        self.first_audio_marks();
        if !self.opening_logged {
            self.opening_logged = true;
            let ms = u64::try_from(self.answered.elapsed().as_millis()).unwrap_or(u64::MAX);
            info!(call = %self.id, ms, "first audio after the answer");
        }
        if let Some(p) = self.playing.as_mut()
            && p.audio_started.is_none()
        {
            let now = Instant::now();
            p.audio_started = Some(now);
            p.mark_at = now;
        }
        let frame = self.frame_bytes.max(1);
        let bytes = self.codec.encode(&media::pad_to_frames(pcm.to_vec(), frame));
        for chunk in bytes.chunks((media::MAX_MESSAGE_BYTES / frame).max(1) * frame) {
            self.send_media(Message::Binary(chunk.to_vec().into())).await;
        }
    }

    async fn mark(&mut self, item: u64, index: usize) {
        let correlation = format!("{item}:{index}");
        self.send_media(Message::Text(media::command("MARK_MEDIA", Some(&correlation)).into())).await;
    }

    /// Writes the playing item's next sentences from the cache, or asks the speaker for the next one
    /// (at most one sentence ahead of what was heard).
    async fn advance(&mut self) {
        loop {
            let Some(p) = self.playing.as_mut() else { return };
            if p.in_flight.is_some() || p.next >= p.sentences.len() || p.next > p.marked + 1 {
                return;
            }
            let index = p.next;
            let sentence = p.sentences[index].text.clone();
            let item = p.item.id;
            let hit = self.cache.lock().ok().and_then(|mut c| c.get(&sentence));
            match hit {
                Some(pcm) => {
                    if let Some(p) = self.playing.as_mut() {
                        p.next += 1;
                        p.durations.push(audio_duration(pcm.len()));
                    }
                    self.write_pcm(&pcm).await;
                    self.mark(item, index).await;
                }
                None => {
                    let id = format!("{item}:{index}");
                    if let Some(p) = self.playing.as_mut() {
                        p.in_flight = Some(InFlight { index, id: id.clone(), pcm: Vec::new() });
                    }
                    let _ = self.speak_tx.send(text_message(&ToSpeaker::Synth { id, text: sentence })).await;
                    return;
                }
            }
        }
    }

    async fn synth_chunk(&mut self, bytes: &[u8]) {
        if self.draining.is_some() {
            return; // a cancelled synthesis's frame (its terminal message has not come yet)
        }
        let pcm = pcm16(bytes);
        let Some(f) = self.playing.as_mut().and_then(|p| p.in_flight.as_mut()) else { return };
        f.pcm.extend_from_slice(&pcm);
        self.write_pcm(&pcm).await;
    }

    async fn synth_event(&mut self, spoken: Spoken) {
        let terminal = match &spoken {
            Spoken::Done { id, .. } | Spoken::Cancelled { id } => Some(id.as_str()),
            Spoken::Error { id, .. } => id.as_deref(),
            Spoken::Hello { .. } => None,
        };
        if terminal.is_some() && terminal == self.draining.as_deref() {
            // The cancelled synthesis has ended: done, cancelled or error (a cancel can lose the race).
            self.draining = None;
            return;
        }
        let (id, ok) = match spoken {
            Spoken::Done { id, .. } => (id, true),
            Spoken::Error { id: Some(id), .. } => (id, false),
            _ => return,
        };
        let Some(p) = self.playing.as_mut() else { return };
        if p.in_flight.as_ref().is_none_or(|f| f.id != id) {
            return;
        }
        let f = p.in_flight.take().expect("checked above");
        let sentence = p.sentences[f.index].text.clone();
        let item = p.item.id;
        p.durations.push(audio_duration(f.pcm.len()));
        p.next = f.index + 1;
        if !ok {
            warn!(call = %self.id, "a sentence could not be synthesised");
        } else if !f.pcm.is_empty()
            && let Ok(mut c) = self.cache.lock()
        {
            c.put(&sentence, f.pcm, self.persist.contains(&sentence));
        }
        self.mark(item, f.index).await;
        self.advance().await;
    }

    async fn media_control(&mut self, control: &str) {
        match media::parse_control(control) {
            MediaEvent::MarkProcessed { correlation } => {
                let Some((item, index)) = parse_mark(&correlation) else { return };
                let finished = match self.playing.as_mut() {
                    Some(p) if p.item.id == item => {
                        p.marked = index + 1;
                        p.mark_at = Instant::now();
                        p.marked >= p.sentences.len()
                    }
                    _ => return,
                };
                if finished {
                    self.input(Input::Played { id: item }).await;
                } else {
                    self.advance().await;
                }
            }
            MediaEvent::Xoff => self.xoff = true,
            MediaEvent::Xon => {
                self.xoff = false;
                for m in std::mem::take(&mut self.held) {
                    let _ = self.media_tx.send(m).await;
                }
            }
            // DTMF is read from ARI (`ChannelDtmfReceived`), once.
            MediaEvent::Dtmf { .. } | MediaEvent::Start { .. } | MediaEvent::Other => {}
        }
    }

    async fn cut(&mut self, item: Item, dropped: Vec<Item>) {
        self.held.clear();
        let _ = self.media_tx.send(Message::Text(media::command("FLUSH_MEDIA", None).into())).await;
        let mut heard = 0;
        if let Some(mut p) = self.playing.take() {
            if p.item.id == item.id {
                if let Some(f) = p.in_flight.take() {
                    let _ = self.speak_tx.send(text_message(&ToSpeaker::Cancel { id: f.id.clone() })).await;
                    self.draining = Some(f.id);
                }
                let fraction = match (p.audio_started, p.durations.get(p.marked)) {
                    (Some(_), Some(d)) if !d.is_zero() => p.mark_at.elapsed().as_secs_f64() / d.as_secs_f64(),
                    (Some(_), _) => 0.5,
                    (None, _) => 0.0,
                };
                heard = text::heard_chars(&p.sentences, p.marked, fraction);
            } else {
                self.playing = Some(p);
            }
        }
        if let Source::Core { seq, agent } = item.source {
            self.reporter.send(BridgeEvent::Said { seq, interrupted_at_char: Some(heard), tts_ms: None }).await;
            if agent && let (Some(onset), Some(m)) = (self.onset, self.marks.as_mut()) {
                m.barge_in_stop_ms = Some(u32::try_from(onset.elapsed().as_millis()).unwrap_or(u32::MAX));
                self.cut_reply = true;
            }
        }
        for d in dropped {
            if let Source::Core { seq, .. } = d.source {
                self.reporter.send(BridgeEvent::Said { seq, interrupted_at_char: Some(0), tts_ms: None }).await;
            }
        }
    }

    async fn inbound_audio(&mut self, bytes: &[u8]) {
        let pcm = self.codec.decode(bytes);
        self.clock.push(pcm.len() as u64 * 1_000 / SAMPLE_RATE, Instant::now());
        let out: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        let _ = self.listen_tx.send(Message::Binary(out.into())).await;
    }

    async fn heard(&mut self, heard: Heard) {
        match heard {
            Heard::SpeechStart { audio_ms } | Heard::Resume { audio_ms } => {
                self.onset = Some(self.clock.at(audio_ms).unwrap_or_else(Instant::now));
                self.input(Input::SpeechStart).await;
            }
            Heard::SpeechEnd { .. } => self.input(Input::SpeechEnd).await,
            Heard::Partial { .. } => {}
            Heard::Unheard { .. } => self.input(Input::Unheard).await,
            Heard::Final { text, confidence, speech_end_ms, endpoint_ms, endpoint_by, stt_ms } => {
                if self.cut_reply && let Some(m) = self.marks.as_mut() {
                    m.backchannel_cut = text::is_backchannel(&text);
                }
                self.finish_turn().await;
                let now = Instant::now();
                let speech_end = self.clock.at(speech_end_ms).unwrap_or(now);
                let endpoint = u32::try_from(endpoint_ms.saturating_sub(speech_end_ms)).unwrap_or(u32::MAX);
                self.marks = Some(TurnMarks::new(speech_end, endpoint, endpoint_by, now));
                let utterance = BridgeEvent::Utterance { text, is_final: true, confidence, stt_ms: Some(stt_ms) };
                self.pending_delivered = Some(self.reporter.send_taken(utterance).await);
                self.input(Input::Final).await;
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Say { seq, text, allow_barge_in } => {
                if let Some(m) = self.marks.as_mut() {
                    m.say.get_or_insert_with(Instant::now);
                    // The key the core matches its own latency for this sentence by (`summarize`).
                    m.reply_seq.get_or_insert(seq);
                }
                self.input(Input::Speak { seq, text, barge_in: allow_barge_in, agent: true }).await;
            }
            Command::Play { seq, clip, text, .. } => {
                // The closing is heard to its end (B4 review C1; the talker hangs up after a cut
                // one all the same); every other line of the core may be cut.
                let barge_in = clip != PlayKind::Closing;
                self.input(Input::Speak { seq, text, barge_in, agent: false }).await;
            }
            Command::Hangup => self.input(Input::HangupWhenDone).await,
            Command::Transfer { to } => {
                if self.deps.ari.redirect(&self.id, &format!("PJSIP/{to}@netgsm")).await.is_err() {
                    warn!(call = %self.id, "Asterisk refused the transfer");
                    let failure_line = "transient: bridge: the transfer was refused".to_owned();
                    self.reporter.send(BridgeEvent::Error { failure_line }).await;
                }
            }
            Command::Record { .. } | Command::Answer { .. } | Command::Dial { .. } => {}
        }
    }

    /// Reports the turn's trace (to the core, and to the bridge's trace file).
    async fn finish_turn(&mut self) {
        let Some(marks) = self.marks.take() else {
            self.cut_reply = false;
            return;
        };
        self.cut_reply = false;
        let trace = marks.trace();
        if let Some(file) = &self.deps.traces
            && file.append(&self.id, &trace).is_err()
        {
            warn!(call = %self.id, "the trace file could not be written");
        }
        self.reporter.send(BridgeEvent::Trace { trace }).await;
    }
}
```

This task uses `DialScript`, `BridgeEvent::Phrase` and `BridgeEvent::Trace` from Task A5.

**The speaker's contract in the call (B2 review, 2026-10-29).** The code above already follows it:
- The voice id comes from the speak service, never from a constant: `speech::connect_speaker` reads the `hello` each connection starts with. `run_call` connects the pre-synthesis socket first, keys the call's `PhraseCache` by its voice id, and reports `error` without dialling when the speaker is unreachable. `Live::connect` compares the live socket's voice id and starts a fresh cache if the service was replaced while the line rang. Config has no `VOICE_ID`.
- A cancel can lose the race to `done`. `cut` remembers the cancelled id in `draining`; `synth_chunk` drops every binary frame while `draining` is set, and `synth_event` clears it on that id's terminal message, whichever it is (`done`, `cancelled` or `error`). One slot suffices: the service sends a synthesis's frames before its terminal message and starts the next only after it, so while the newest cancelled id is draining, every frame is stale.

**The pacer in the call (B1 review, 2026-10-29).** Where these differ from the code above, they win. They wire B5's `media::Pacer` in: the call writes one frame every 20 ms for its whole life, silence when nothing plays.
- `use crate::media::{self, MediaEvent, Out, Pacer};`
- `Live` loses `xoff` and `held` and gains `pacer: Pacer`. In `connect`, `pacer: Pacer::new(frame_bytes, codec.encode(&[0])[0], 0),` sits beside `started: Instant::now()` (the pacer's clock is `now_ms()`, 0 at `started`). `codec.encode(&[0])[0]` is 0xD5 for A-law and 0xFF for μ-law.
- In `run`, the tick arm paces before the talker ticks:

```rust
                _ = tick.tick() => {
                    self.pace().await;
                    self.input(Input::Tick).await;
                }
```

- `send_media` is deleted. `write_pcm` and `mark` only queue, and become plain `fn`s; their callers (`advance`, `synth_chunk`, `synth_event`) drop the `.await`:

```rust
    /// Queues the sentence's audio with the pacer, unpadded: the pacer pads at the sentence's end.
    fn write_pcm(&mut self, pcm: &[i16]) {
        let bytes = self.codec.encode(pcm);
        self.pacer.audio(&bytes);
    }

    fn mark(&mut self, item: u64, index: usize) {
        self.pacer.mark(format!("{item}:{index}"));
    }

    /// Writes what the pacer has due: one frame per 20 ms for the whole call, silence when
    /// nothing plays (Asterisk >= 22.9 sends nothing otherwise), each mark after its last frame.
    async fn pace(&mut self) {
        let now = self.now_ms();
        for out in self.pacer.due(now) {
            match out {
                Out::Frame { bytes, silence } => {
                    if !silence {
                        self.first_real_frame();
                    }
                    let _ = self.media_tx.send(Message::Binary(bytes.into())).await;
                }
                Out::Mark(correlation) => {
                    let mark = media::command("MARK_MEDIA", Some(&correlation));
                    let _ = self.media_tx.send(Message::Text(mark.into())).await;
                }
            }
        }
    }

    /// A real frame left for Asterisk. The turn's first-audio marks, the opening's log line and the
    /// item's audio clock start at its first one, not when the audio was queued.
    fn first_real_frame(&mut self) {
        self.first_audio_marks();
        if !self.opening_logged {
            self.opening_logged = true;
            let ms = u64::try_from(self.answered.elapsed().as_millis()).unwrap_or(u64::MAX);
            info!(call = %self.id, ms, "first audio after the answer");
        }
        if let Some(p) = self.playing.as_mut()
            && p.audio_started.is_none()
        {
            let now = Instant::now();
            p.audio_started = Some(now);
            p.mark_at = now;
        }
    }
```

- In `media_control`: `MediaEvent::Xoff => self.pacer.pause(),` and `MediaEvent::Xon => { let now = self.now_ms(); self.pacer.resume(now); }`.
- `cut` opens with the flush, then writes the fresh lead of silence at once, in place of `self.held.clear();` and its `FLUSH_MEDIA` send:

```rust
        let now = self.now_ms();
        self.pacer.flush(now);
        let _ = self.media_tx.send(Message::Text(media::command("FLUSH_MEDIA", None).into())).await;
        self.pace().await;
```

- Tests. `serve_media` (in `tests/support/mod.rs`) matches binary messages as well, with `let mut silence_seen = false;` before its loop. It reports `silence frame` the first time a frame of all 0xD5 arrives, and `frame of N bytes` (`try_send`, never blocking) for any frame that is not 160 bytes. At 50 frames a second, it never reports each frame: the channel holds 64.

```rust
            match msg {
                Message::Binary(b) => {
                    if !silence_seen && b.iter().all(|&x| x == 0xD5) {
                        silence_seen = true;
                        let _ = tx.try_send("silence frame".to_owned());
                    }
                    if b.len() != 160 {
                        let _ = tx.try_send(format!("frame of {} bytes", b.len()));
                    }
                }
                Message::Text(t) => { /* as before: answer MARK_MEDIA, send the command's name */ }
                _ => {}
            }
```

`a_call_dials_plays_hears_acknowledges_and_hangs_up` ends with:

```rust
    assert!(sent.iter().any(|c| c == "silence frame"), "silence fills the gaps: {sent:?}");
    assert!(!sent.iter().any(|c| c.starts_with("frame of")), "whole 160-byte frames only: {sent:?}");
```

- [ ] **Step 4: Write `slice.rs` and `main.rs`**

`rust/bridge/voice/src/slice.rs`:

```rust
//! `jeeta-voice-bridge slice`: the vertical slice of plan task B6, without the core. It dials the
//! number in `SLICE_TO` (+90…, read from the environment so it is in no command line), plays the
//! opening when answered, waits for one caller turn, lets `--think-ms` pass (the bridge covers it
//! with its own acknowledgement and filler, as with a thinking agent), plays the reply and the
//! approved closing, hangs up, and prints every turn's trace as JSON. `--show-transcript` prints the
//! caller's words to this terminal only (never to the log).

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use jt_calls::{BridgeEvent, BridgePhrases, CLOSING, Command, DialScript, PlayKind};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::ari::{self, Ari};
use crate::call::{CallDeps, CallSetup, ToCall, run_call};
use crate::config::Config;
use crate::netgsm;
use crate::trace::TraceFile;

struct Args {
    opening: String,
    reply: String,
    think: Duration,
    show_transcript: bool,
}

fn parse(args: &[String]) -> Option<Args> {
    let mut a = Args { opening: String::new(), reply: String::new(), think: Duration::from_millis(3_000), show_transcript: false };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--opening" => a.opening = it.next()?.clone(),
            "--reply" => a.reply = it.next()?.clone(),
            "--think-ms" => a.think = Duration::from_millis(it.next()?.parse().ok()?),
            "--show-transcript" => a.show_transcript = true,
            _ => return None,
        }
    }
    (!a.opening.is_empty() && !a.reply.is_empty()).then_some(a)
}

pub async fn main(args: &[String]) -> ExitCode {
    let Some(args) = parse(args) else {
        eprintln!("usage: jeeta-voice-bridge slice --opening TEXT --reply TEXT [--think-ms N] [--show-transcript]");
        return ExitCode::from(2);
    };
    let Some(dial) = std::env::var("SLICE_TO").ok().as_deref().and_then(netgsm::dial_string) else {
        eprintln!("SLICE_TO must hold a number the line may call (+90 and 2, 3, 4, 5, 800 or 850)");
        return ExitCode::from(2);
    };
    let config = match Config::from_env(|k| std::env::var(k).ok(), false) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let ari = Arc::new(Ari::new(&config.ari_url, &config.ari_user, &config.ari_password));
    let deps = Arc::new(CallDeps {
        ari: ari.clone(),
        listen: config.listen.clone(),
        speak: config.speak.clone(),
        cache_dir: config.cache_dir.clone(),
        timing: config.timing,
        traces: Some(TraceFile::new(config.trace_file.clone())),
    });
    let (to_call, rx) = mpsc::channel(64);
    let (reports_tx, mut reports) = mpsc::channel(64);
    let events = match ari.events().await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("ARI events: {e}");
            return ExitCode::FAILURE;
        }
    };
    let forward = to_call.clone();
    tokio::spawn(async move {
        let mut events = events;
        while let Some(Ok(Message::Text(t))) = events.next().await {
            let _ = forward.send(ToCall::Ari(ari::parse_event(&t))).await;
        }
    });
    let id = uuid::Uuid::now_v7().to_string();
    let setup = CallSetup {
        bridge_call_id: id,
        dial,
        script: DialScript { lines: vec![args.opening.clone()], phrases: BridgePhrases::default(), hotwords: Vec::new() },
        plan_lines: vec![args.reply.clone(), CLOSING.to_owned()],
    };
    tokio::spawn(run_call(deps, setup, rx, reports_tx));
    let mut seq = 0u32;
    let mut replied = false;
    while let Some(report) = reports.recv().await {
        if let Some(taken) = report.taken {
            let _ = taken.send(());
        }
        match report.event {
            BridgeEvent::Answered => {
                println!("answered");
                seq += 1;
                let play = Command::Play { seq, clip: PlayKind::Opening, index: 0, text: args.opening.clone() };
                let _ = to_call.send(ToCall::Command(play)).await;
            }
            BridgeEvent::Utterance { text, .. } if !replied => {
                replied = true;
                if args.show_transcript {
                    println!("caller: {text}");
                }
                tokio::time::sleep(args.think).await;
                seq += 1;
                let say = Command::Say { seq, text: args.reply.clone(), allow_barge_in: true };
                let _ = to_call.send(ToCall::Command(say)).await;
                seq += 1;
                let closing = Command::Play { seq, clip: PlayKind::Closing, index: 0, text: CLOSING.to_owned() };
                let _ = to_call.send(ToCall::Command(closing)).await;
                let _ = to_call.send(ToCall::Command(Command::Hangup)).await;
            }
            BridgeEvent::Phrase { set, index } => println!("phrase {set:?} {index}"),
            BridgeEvent::Said { seq, interrupted_at_char, .. } => println!("said {seq} cut at {interrupted_at_char:?}"),
            BridgeEvent::Trace { trace } => println!("trace {}", serde_json::to_string(&trace).unwrap_or_default()),
            BridgeEvent::Hangup { cause } => {
                println!("hangup {cause}");
            }
            BridgeEvent::Error { failure_line } => {
                eprintln!("error: {failure_line}");
                return ExitCode::FAILURE;
            }
            _ => {}
        }
    }
    ExitCode::SUCCESS
}
```

`rust/bridge/voice/src/main.rs`:

```rust
//! `jeeta-voice-bridge [run | slice … | report [--since RFC3339] | check]`.
//!
//! - `run` (default): the workspace's line (task D2).
//! - `slice`: one test call without the core (`slice.rs`).
//! - `report`: p50/p95 of the traces in `VOICE_TRACE_FILE`, optionally since a time.
//! - `check`: reaches ARI and both speech services, and says which answer.
//!
//! The log filter is `JEETA_VOICE_BRIDGE_LOG` (default `info`).

use std::process::ExitCode;

use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::trace::read_traces;
use jeeta_voice_bridge::{ari::Ari, slice, speech};
use time::OffsetDateTime;
use tracing_subscriber::EnvFilter;

const USAGE: &str = "usage: jeeta-voice-bridge [run | slice --opening TEXT --reply TEXT [--think-ms N] [--show-transcript] | report [--since RFC3339] | check]";

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_env("JEETA_VOICE_BRIDGE_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread().enable_all().build() else {
        return ExitCode::FAILURE;
    };
    match args.first().map(String::as_str).unwrap_or("run") {
        "slice" => runtime.block_on(slice::main(&args[1..])),
        "report" => report(&args[1..]),
        "check" => runtime.block_on(check()),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn report(args: &[String]) -> ExitCode {
    let since = match args {
        [flag, at] if flag == "--since" => {
            match OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339) {
                Ok(t) => Some(t),
                Err(_) => {
                    eprintln!("--since takes an RFC 3339 time");
                    return ExitCode::from(2);
                }
            }
        }
        [] => None,
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let path = std::env::var("VOICE_TRACE_FILE").unwrap_or_else(|_| "/var/lib/jeeta-voice/traces.jsonl".into());
    match read_traces(std::path::Path::new(&path), since) {
        Ok(traces) => {
            // The worker alone cannot see the core's latencies: `agent` and `transport` stay empty here
            // (the call view, `calls.get`, has them).
            let summary = jt_calls::summarize(&traces, &[], &[]);
            println!("{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(_) => {
            eprintln!("the trace file cannot be read");
            ExitCode::FAILURE
        }
    }
}

async fn check() -> ExitCode {
    let config = match Config::from_env(|k| std::env::var(k).ok(), false) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let ari = Ari::new(&config.ari_url, &config.ari_user, &config.ari_password);
    let mut ok = true;
    match ari.info().await {
        Ok(v) => println!("ari: ok (Asterisk {v})"),
        Err(e) => {
            ok = false;
            println!("ari: {e}");
        }
    }
    match speech::connect(&config.listen, speech::LISTEN_UID).await {
        Ok(_) => println!("listen: ok"),
        Err(e) => {
            ok = false;
            println!("listen: {e}");
        }
    }
    match speech::connect_speaker(&config.speak).await {
        Ok((_, voice)) => println!("speak: ok (voice {voice})"),
        Err(e) => {
            ok = false;
            println!("speak: {e}");
        }
    }
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
```

In `lib.rs` add `pub mod call;` and `pub mod slice;` and to the module map: "- [`call`]: one call's task; [`slice`]: the standalone test call."

- [ ] **Step 5: Run the tests and lints**

Run: `cargo test -p jeeta-voice-bridge` then `cargo clippy -p jeeta-voice-bridge --all-targets -- -D warnings`
Expected: `call` 1 passed (about 3 s), every earlier test still passing, `logging` passing (the log calls of `call.rs` name only `call`, `reason`, `cause`), clippy clean.

- [ ] **Step 6: Commit**

```bash
git add rust/bridge/voice
git commit -m "feat(voice-bridge): one call's task over ARI and the speech services, and the standalone slice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task B7: [OWNER] The vertical-slice call

The go/no-go for the whole stack. Needs the owner's mobile and about 3 minutes of the NetGSM package.

**Files:** none (records results in the task notes and in `docs/operations/voice-bridge.md` in E4).

- [ ] **Step 1: [COORDINATOR, server] Install the worker binary**

CI builds the Linux artifact (task D3 adds the job; until then build on the host with the workspace's toolchain: `docker run --rm -v /root/jeeta-voice-src/rust:/w -w /w rust:1.96.0-bookworm cargo build --locked --release -p jeeta-voice-bridge` after copying the whole `rust/` tree with `git archive HEAD rust`). Then:

```bash
SHA=<the commit's short sha>
install -d -m 0755 /opt/jeeta-voice/releases/$SHA
install -m 0755 <path to the built jeeta-voice-bridge> /opt/jeeta-voice/releases/$SHA/jeeta-voice-bridge
ln -sfn /opt/jeeta-voice/releases/$SHA /opt/jeeta-voice/current
install -d -m 0750 -o jeeta-voice-bridge -g jeeta-voice-bridge /var/lib/jeeta-voice /var/lib/jeeta-voice/cache
set -a; . /etc/jeeta-voice/ari.env; set +a
sudo -E -u jeeta-voice-bridge -g jeeta-voice-bridge --preserve-env=ARI_PASSWORD /opt/jeeta-voice/current/jeeta-voice-bridge check
```

Expected: `ari: ok (Asterisk 22.11.0)`, `listen: ok`, `speak: ok (voice <the id in the speak journal>)`. (`sudo -g` gives the `jeeta-voice` supplementary group through the user's membership; if a socket is refused, run `id jeeta-voice-bridge` and confirm `jeeta-voice` is listed.)

- [ ] **Step 2: [OWNER] Agree the time; the owner gives the number for this call only**

The owner tells the coordinator the mobile number privately; the coordinator writes it to a 0600 file and never echoes it:

```bash
umask 077; read -r -s TO; printf '%s' "$TO" > /root/jeeta-voice-slice-to; unset TO
```

- [ ] **Step 3: [OWNER + COORDINATOR] Place the call**

```bash
set -a; . /etc/jeeta-voice/ari.env; set +a
SLICE_TO="$(cat /root/jeeta-voice-slice-to)" VOICE_TRACE_FILE=/var/lib/jeeta-voice/slice-traces.jsonl \
  sudo -E -u jeeta-voice-bridge --preserve-env=ARI_PASSWORD,SLICE_TO,VOICE_TRACE_FILE \
  /opt/jeeta-voice/current/jeeta-voice-bridge slice \
  --opening "Merhaba, ben Jeeta'nın dijital asistanıyım. Görüşmemiz hizmet kalitesi için yazıya dökülmektedir. Bu bir deneme aramasıdır, lütfen bir cümle söyleyin." \
  --reply "Teşekkürler, sizi duydum." --think-ms 9000 --show-transcript
shred -u /root/jeeta-voice-slice-to
```

`--think-ms 9000` holds the reply 9 s after the owner's turn, an agent gap long enough for the long wait (8 s) and the silence check below.

In a second root terminal, start these just before the call. They print addresses, ports and counts, never a number or a payload:

```bash
timeout 120 tcpdump -nn -q -c 10 udp portrange 40000-40099
for i in $(seq 1 24); do date +%T; docker exec jeeta-asterisk asterisk -rx 'pjsip show channelstats' | grep -E 'netgsm-'; sleep 5; done
```

The owner answers, says one sentence (e.g. "Yarın saat on dörtte uygunum."), then listens to the end.

Expected on the terminal, in order: `answered`; `said 1 cut at None`; `caller: …` (the owner's words, close to what was said); `phrase Acknowledgement 0` about 0.6 s after the owner stopped; `phrase Filler 0` about 2.7 s after; `phrase LongWait 0` about 8 s after; `said 2 cut at None`; `said 3 cut at None`; `hangup normal`; one `trace {…}` line. The owner confirms: the opening began immediately and sounded like the chosen voice; "Hı hı.", the filler and the long wait were heard; the reply and the closing were heard; the line closed cleanly. Record the trace numbers (endpoint, stt_final, ack, first_audio).

Go criteria:
- two-way audio;
- the transcript is recognisable;
- a barge-in while the bridge plays needs 256 ms of speech before `speech_start` (eight 32 ms chunks over the guarded 250 ms, B3) and the guard lasts 400 ms past the playback: against the design's 300 ms barge-in alert (onset to `FLUSH_MEDIA`) that leaves under 50 ms for the worker. Record `barge_in_stop_ms` if the owner cuts in, and tune `LISTEN_GUARD_TAIL_MS` (200-800) or the guarded minimum only from that number;
- `ack_ms` ≤ 1 000 and `endpoint_ms` ≤ 1 800;
- **the line never goes quiet** (the B1 review). In the agent's 9 s gap, two `channelstats` rows 5 s apart show the Tx count up by about 250 (50 packets a second, from the pacer's silence frames and the phrases). Every other 5 s pair shows the same, and Rx rises too (two-way RTP).
- `tcpdump` shows packets in both directions between this host's address and NetGSM's media address.
  - Only outbound packets: NetGSM's RTP does not arrive. Check the SDP's `c=` address. If it is not this host's public address, set `external_media_address` (and `external_signaling_address`) on `[transport-udp]` and run `pjsip reload`. Otherwise apply the B1 Step 10 rule.
  - Inbound only, or Tx flat in the gap: the worker is not pacing (B5/B6).

After the call, a count-only check that no phone number reached Asterisk's journal: `journalctl -u jeeta-asterisk | grep -cE '[0-9]{10}'`. The expected count is 0. If it is not 0, look at the lines with the digits masked: `journalctl -u jeeta-asterisk | grep -E '[0-9]{10}' | sed -E 's/[0-9]{10,}/<n>/g' | sort | uniq -c`. A channel's unique id (epoch seconds) also has 10 digits. Report what logs a number.

Failure handling: one-way audio → B1 Step 10 rule, retry once; no `caller:` line → `journalctl -u jeeta-voice-listen -n 50` (errors only), check the echo-guard and VAD thresholds; garbled voice → compare `alaw`/`ulaw` in `MEDIA_START` with the PJSIP codec (`docker exec jeeta-asterisk asterisk -rx 'core show channels verbose'` during a call shows the format without numbers only with `verbose=0` off: do not enable verbose; use `pjsip show channelstats` instead). If two-way audio cannot be obtained, stop and report before Phase C.

### Task B8: Inbound investigation (non-blocking)

Gate V1 saw the PBX answer 0850 calls itself with silence and send no INVITE to the UA. This task finds out whether Asterisk on 102 receives an inbound INVITE. Nothing else waits for it.

**Files:** none (findings go to the task notes and to `docs/operations/voice-bridge.md` §Inbound in E4).

- [ ] **Step 1: [COORDINATOR, server] Watch for an inbound call without logging numbers**

With the worker not running (`systemctl is-active jeeta-voice-bridge` → `inactive`), open the ARI event stream in a terminal and print only the event type and the first Stasis argument:

```bash
set -a; . /etc/jeeta-voice/ari.env; set +a
python3 - <<'EOF'
import base64, json, os, socket
key = base64.b64encode(b"jeeta-voice:" + os.environ["ARI_PASSWORD"].encode()).decode()
s = socket.create_connection(("127.0.0.1", 8188))
s.sendall(("GET /ari/events?app=jeeta-voice HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
           f"Authorization: Basic {key}\r\n\r\n").encode())
buf = s.recv(4096)
print("connected" if b" 101 " in buf else "refused")
while True:
    head = s.recv(2)
    if len(head) < 2: break
    n = head[1] & 0x7F
    if n == 126: n = int.from_bytes(s.recv(2), "big")
    elif n == 127: n = int.from_bytes(s.recv(8), "big")
    data = b""
    while len(data) < n: data += s.recv(n - len(data))
    try:
        e = json.loads(data)
        print(e.get("type"), (e.get("args") or [None])[0])
    except ValueError:
        pass
EOF
```

Expected: `connected`.

- [ ] **Step 2: [OWNER] Route 0850 to 102 for the test and call it**

The owner (Netsantral portal, OTP login): Çağrı akışı / gelen route → Dahili 102; then calls 0850 840 73 03 from the mobile and waits 15 seconds.

Expected either `StasisStart in` in the terminal (the INVITE reached Asterisk: inbound works at the SIP level; Asterisk's dialplan sends it to the bridge application, which nothing answers yet, so the caller hears ringing until the PBX gives up) or nothing. Then the owner routes the line back to 101.

- [ ] **Step 3: [COORDINATOR] If nothing arrived**

Check the registration's contact as NetGSM sees it (`docker exec jeeta-asterisk asterisk -rx 'pjsip show registrations'` shows `Registered`; `pjsip show contacts` shows the AOR's qualify state) and that `identify` matches the PBX address (`pjsip show identifies`). Draft (do not send) a NetGSM support message for the owner: "Dahili 102 sip5.netsantral.com'a UDP ile kayıtlı (Registered); gelen çağrı yönlendirmesi 102'ye ayarlıyken INVITE gelmiyor. Gelen çağrıların 102'ye SIP INVITE olarak iletilmesi için hesapta bir ayar gerekiyor mu?". Record the result; V2 (inbound duty) depends on it, V1 does not.


---

## Phase C — core protocol additions (Rust core, MCP, panel; tests in Linux CI)

Phase C changes what the core plays and returns; every change is additive and existing callers keep working. `jt_calls` parts run on Windows; `jt_app`, `jt_mcp` and `jt_panel_http` tests run in CI only (section 2).

### Task C1: The workspace opening and the transcript notice come first (and the closing has a default)

**Files:**
- Modify: `rust/crates/domain/jt_calls/src/policy.rs`
- Modify: `rust/crates/domain/jt_calls/src/plan.rs` (`closing` optional; the stored plan reads tolerantly, `CallPlan::FIELDS`)
- Create: `rust/crates/domain/jt_calls/tests/policy_opening.rs`
- Modify: `rust/crates/jt_app/src/usecases/calls.rs`:
  - `policy_get`, `facts`, `place_agent`, a new `policy_of`;
  - `PolicyInput` (the keys the body named; unknown keys at any depth refused) and `PlaceInput` (its plan read strictly);
  - `policy_set` (the person-only texts).
- Modify: `calls/bridge.rs` (`apply_call`), `calls/session.rs` (`tick`).
- Modify: `rust/crates/jt_app/tests/calls_session.rs` (rig policy; two tests), and `calls_session.rs`, `calls_end.rs`, `calls_place.rs` wherever they build `PolicyInput(policy)`, which becomes `PolicyInput::from(policy)`.
- Create: `rust/crates/jt_app/tests/calls_policy.rs` (the person-only texts; strict input boundaries).
- Modify: `rust/crates/adapters/jt_mcp/src/tools/calls.rs` (`policy_schema`; the `calls.policy_get` and `calls.policy_set` descriptions).
- Modify: `rust/crates/adapters/jt_mcp/tests/calls_mcp.rs` (schema parity; person-only wording).

- [ ] **Step 1: Write the failing domain test**

`rust/crates/domain/jt_calls/tests/policy_opening.rs`:

```rust
//! The policy's own opening, notice and phrases (owner decisions of 2026-10-29).
use jt_calls::{BridgePhrases, CLOSING, CallPlan, CallPolicy, TRANSCRIPT_NOTICE};
use serde_json::json;

#[test]
fn the_workspace_fills_only_what_the_owner_left_unwritten() {
    let p = CallPolicy::default().with_workspace("Acme");
    assert_eq!(p.opening_outbound.as_deref(), Some("Merhaba, ben Acme'nin dijital asistanıyım."));
    assert_eq!(p.transcript_notice.as_deref(), Some(TRANSCRIPT_NOTICE));
    assert_eq!(p.closing.as_deref(), Some(CLOSING));
    assert_eq!(p.disclosure_sentence, "ben Acme'nin dijital asistanıyım");
    assert_eq!(
        p.greeting_inbound,
        "Merhaba, ben Acme'nin dijital asistanıyım. Size nasıl yardımcı olabilirim?"
    );
    let own = CallPolicy {
        opening_outbound: Some("Merhaba, Acme asistanı ben.".into()),
        transcript_notice: Some(String::new()),
        closing: Some("Hoşça kalın.".into()),
        disclosure_sentence: "Acme asistanı".into(),
        ..CallPolicy::default()
    }
    .with_workspace("Acme");
    assert_eq!(own.opening_outbound.as_deref(), Some("Merhaba, Acme asistanı ben."));
    assert_eq!(own.transcript_notice.as_deref(), Some(""));
    assert_eq!(own.closing.as_deref(), Some("Hoşça kalın."));
    assert_eq!(own.disclosure_sentence, "Acme asistanı");
    // An empty closing is the owner's "none", not "unwritten".
    let none = CallPolicy { closing: Some(String::new()), ..CallPolicy::default() }.with_workspace("Acme");
    assert_eq!(none.closing.as_deref(), Some(""));
}

#[test]
fn the_spoken_opening_is_the_workspaces_then_the_notice_then_the_plans() {
    let p = CallPolicy::default().with_workspace("Acme");
    let spoken = p.spoken_opening("Ada Hanım ile mi görüşüyorum?");
    assert_eq!(
        spoken,
        format!("Merhaba, ben Acme'nin dijital asistanıyım. {TRANSCRIPT_NOTICE} Ada Hanım ile mi görüşüyorum?")
    );
    assert!(p.discloses(&spoken));
    assert_eq!(
        p.opening_lines(None),
        ["Merhaba, ben Acme'nin dijital asistanıyım.", TRANSCRIPT_NOTICE]
    );
    let bare = CallPolicy {
        opening_outbound: Some(String::new()),
        transcript_notice: Some(String::new()),
        ..CallPolicy::default()
    }
    .with_workspace("Acme");
    assert_eq!(bare.spoken_opening("Ada Hanım?"), "Ada Hanım?");
    assert!(!bare.discloses(&bare.spoken_opening("Ada Hanım?")));
}

#[test]
fn openings_and_phrases_are_validated_and_read_tolerantly() {
    assert_eq!(CallPolicy::default().validate(), Ok(()));
    let mut p = CallPolicy::default();
    p.phrases.fillers.push("   ".into());
    assert_eq!(p.validate().unwrap_err().field, "phrases.fillers");
    let mut p = CallPolicy::default();
    p.phrases.acknowledgements = vec!["Tamam.".into(); 6];
    assert_eq!(p.validate().unwrap_err().field, "phrases.acknowledgements");
    let p = CallPolicy { opening_outbound: Some("x".repeat(601)), ..CallPolicy::default() };
    assert_eq!(p.validate().unwrap_err().field, "opening_outbound");
    let p = CallPolicy { closing: Some("x".repeat(601)), ..CallPolicy::default() };
    assert_eq!(p.validate().unwrap_err().field, "closing");
    let p = CallPolicy { closing: Some(String::new()), ..CallPolicy::default() };
    assert_eq!(p.validate(), Ok(()));
    let p: CallPolicy = serde_json::from_value(json!({})).unwrap();
    assert_eq!((p.opening_outbound, p.transcript_notice, p.closing), (None, None, None));
    assert_eq!(p.phrases, BridgePhrases::default());
}

#[test]
fn a_plan_may_leave_its_closing_to_the_policy() {
    let mut plan: CallPlan = serde_json::from_value(json!({
        "opening": "Ada Hanım ile mi görüşüyorum?",
        "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."],
        "max_duration_s": 60,
    }))
    .unwrap();
    assert_eq!(plan.closing, "");
    assert_eq!(plan.validate(), Ok(()));
    // The closing is played when there is one: an empty one is not a sentence the plan authors.
    assert_eq!(plan.playable().collect::<Vec<_>>(), ["Ada Hanım ile mi görüşüyorum?", "Bir saniye."]);
    plan.closing = "Hoşça kalın.".into();
    assert_eq!(plan.playable().last(), Some("Hoşça kalın."));
    plan.closing = "   ".into();
    assert!(plan.validate().is_err());
    plan.closing = "x".repeat(601);
    assert!(plan.validate().is_err());
}
```

Run: `cargo test -p jt_calls --test policy_opening`
Expected: FAIL to compile (`with_workspace` not found).

- [ ] **Step 2: Implement the policy changes**

In `rust/crates/domain/jt_calls/src/policy.rs` add the imports

```rust
use crate::opening::{CLOSING, TRANSCRIPT_NOTICE, disclosure, inbound_greeting, outbound_opening};
use crate::phrases::PhraseSet;
```

the fields (after `disclosure_sentence`):

```rust
    /// Played first when an outbound agent call is answered: the workspace's own opening, which
    /// discloses the assistant. `None`: the approved opening with the workspace's name
    /// ([`CallPolicy::with_workspace`]); empty: none (the plan's opening must then disclose).
    pub opening_outbound: Option<String>,
    /// Played after the opening on every agent call. `None`: the approved notice; empty: none.
    pub transcript_notice: Option<String>,
    /// Played before an agent's call is hung up when its plan brings no closing. `None`: the
    /// approved closing ([`CLOSING`], filled in by [`CallPolicy::with_workspace`]); empty: none (a
    /// plan must then bring its own).
    pub closing: Option<String>,
```

`opening_outbound: None, transcript_notice: None, closing: None,` in `Default`, and in `validate`, before the timers:

```rust
        if let Some(t) = &self.opening_outbound {
            optional_line(t, "opening_outbound")?;
        }
        if let Some(t) = &self.transcript_notice {
            optional_line(t, "transcript_notice")?;
        }
        if let Some(t) = &self.closing {
            optional_line(t, "closing")?;
        }
        for set in PhraseSet::ALL {
            let field = phrase_field(set);
            let list = self.phrases.set(set);
            if list.len() > MAX_HOLDING_LINES {
                return Err(refuse(field, "has more than 5 phrases"));
            }
            for p in list {
                line(p, field).map_err(PolicyError::from)?;
            }
        }
```

with, beside `refuse`:

```rust
fn phrase_field(set: PhraseSet) -> &'static str {
    match set {
        PhraseSet::Acknowledgement => "phrases.acknowledgements",
        PhraseSet::Filler => "phrases.fillers",
        PhraseSet::LongWait => "phrases.long_wait",
        PhraseSet::NotHeard => "phrases.not_heard",
        PhraseSet::StillThere => "phrases.still_there",
        PhraseSet::Fault => "phrases.fault",
    }
}
```

and the methods in `impl CallPolicy`:

```rust
    /// This policy with the workspace's own sentences where the owner wrote none: the approved
    /// outbound opening and inbound greeting with `business` in them, the approved transcript
    /// notice and closing, and the disclosure sentence both openings contain. The owner's own texts
    /// are kept (an empty one is the owner's "none").
    pub fn with_workspace(mut self, business: &str) -> CallPolicy {
        if self.opening_outbound.is_none() {
            self.opening_outbound = outbound_opening(business);
        }
        if self.transcript_notice.is_none() {
            self.transcript_notice = Some(TRANSCRIPT_NOTICE.to_owned());
        }
        if self.closing.is_none() {
            self.closing = Some(CLOSING.to_owned());
        }
        if self.disclosure_sentence.trim().is_empty()
            && let Some(d) = disclosure(business)
        {
            self.disclosure_sentence = d;
        }
        if self.greeting_inbound.trim().is_empty()
            && let Some(g) = inbound_greeting(business)
        {
            self.greeting_inbound = g;
        }
        self
    }

    /// What an outbound agent call plays when answered, in order: the workspace's opening, the
    /// transcript notice, and `plan_opening` when given; empty texts left out.
    pub fn opening_lines<'a>(&'a self, plan_opening: Option<&'a str>) -> Vec<&'a str> {
        [self.opening_outbound.as_deref(), self.transcript_notice.as_deref(), plan_opening]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect()
    }

    /// [`CallPolicy::opening_lines`] with the plan's opening, as one text.
    pub fn spoken_opening(&self, plan_opening: &str) -> String {
        self.opening_lines(Some(plan_opening)).join(" ")
    }
```

In `rust/crates/domain/jt_calls/src/plan.rs` a plan may leave its closing to the policy. In `CallPlan` the field becomes

```rust
    /// Played before the call is hung up. Empty: the call policy's `closing` (the core fills it in
    /// when the call is placed; a plan with neither is refused).
    #[serde(default)]
    pub closing: String,
```

in `validate` replace `line(&self.closing, "plan.closing")?;` with

```rust
        if !self.closing.is_empty() {
            line(&self.closing, "plan.closing")?;
        }
```

and in `playable` replace `.chain(std::iter::once(self.closing.as_str()))` with `.chain((!self.closing.is_empty()).then_some(self.closing.as_str()))`.

Run: `cargo test -p jt_calls`
Expected: all pass (`policy_opening` 4 new).

- [ ] **Step 3: Write the failing core tests**

In `rust/crates/jt_app/tests/calls_session.rs`, make the rig keep its single opening (every existing test relies on it): in `fn policy()` add

```rust
        opening_outbound: Some(String::new()),
        transcript_notice: Some(String::new()),
```

and add the tests:

```rust
#[tokio::test]
async fn the_workspace_opening_and_the_notice_precede_the_plans_opening() {
    // No disclosure sentence of the owner's: the workspace's own opening discloses.
    let r = rig_with(1, CallPolicy { disclosure_sentence: String::new(), ..CallPolicy::default() }).await;
    let mut asks = plan();
    asks.opening = "Ada Hanım ile mi görüşüyorum?".into();
    let call = r.place_at(0, asks).await;
    assert_eq!(kinds(&r.poll(1).await), ["dial"]);
    r.report(5, call, json!([{ "kind": "answered" }])).await;
    let play = r.poll(5).await;
    assert_eq!(kinds(&play), ["play"]);
    assert_eq!(
        play[0].payload["text"],
        format!(
            "Merhaba, ben Acme'nin dijital asistanıyım. {} Ada Hanım ile mi görüşüyorum?",
            jt_calls::TRANSCRIPT_NOTICE
        )
    );
}

#[tokio::test]
async fn policy_get_shows_the_workspaces_own_sentences() {
    let w = world().await;
    let p = calls::policy_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(p.opening_outbound.as_deref(), Some("Merhaba, ben Acme'nin dijital asistanıyım."));
    assert_eq!(p.closing.as_deref(), Some(jt_calls::CLOSING));
    assert_eq!(p.disclosure_sentence, "ben Acme'nin dijital asistanıyım");
    assert_eq!(p.phrases, jt_calls::BridgePhrases::default());
}

#[tokio::test]
async fn a_plan_without_a_closing_ends_with_the_policys_closing() {
    let mut brief = plan();
    brief.closing = String::new();
    brief.max_duration_s = 60;
    let r = rig().await;
    let call = r.place_at(0, brief).await;
    r.answer(call).await;
    r.timers(65).await;
    let queued = r.poll(65).await;
    let closing = queued.iter().find(|c| c.payload["clip"] == "closing").expect("a closing");
    assert_eq!(closing.payload["text"], jt_calls::CLOSING);
}

#[tokio::test]
async fn a_plan_without_a_closing_is_refused_when_the_policy_has_none() {
    let r = rig_with(1, CallPolicy { closing: Some(String::new()), ..policy() }).await;
    let mut brief = plan();
    brief.closing = String::new();
    let e = calls::place(&r.w.deps, &r.agent_at(0), place_input(&r, brief)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["field"], "plan.closing");
}
```

CI: `cargo test --locked -p jt_app --test calls_session`
Expected: FAIL (`the_workspace_opening…` plays only the plan's opening; `policy_get…` sees `None`).

- [ ] **Step 4: Implement the core changes**

In `rust/crates/jt_app/src/usecases/calls.rs` add, in the Policy section:

```rust
/// The call policy as calls use it: the stored one (the defaults while none is stored) with the
/// workspace's own opening, notice, disclosure and greeting where the owner wrote none
/// (`CallPolicy::with_workspace`, the owner-approved templates with the workspace's name).
pub(crate) async fn policy_of(r: &mut dyn TenantRepos) -> Result<CallPolicy, AppError> {
    let name = r.workspace().get().await?.name;
    Ok(r.calls().policy().await?.with_workspace(&name))
}
```

Replace `r.calls().policy().await` with `policy_of(r…).await` in: `policy_get` (its body becomes `policy_of(r.as_mut()).await`), `facts` (`let policy = policy_of(r).await?;`), `place_agent`, the two other reads in `calls.rs` that read the policy for a call (`grep -n "calls().policy()" rust/crates/jt_app/src/usecases/calls.rs`), `calls/bridge.rs` `apply_call` and `calls/session.rs` `tick`. Keep `policy_set`'s `let before = r.calls().policy().await?;` (it compares stored values) and `calls/say.rs`'s handoff-extension read.

In `facts`, the disclosure is read over the spoken opening:

```rust
        Line::Agent { opening } => (
            agent_line_busy(r, &capability, ctx.agent_connection_id, own).await?,
            policy.discloses(&policy.spoken_opening(opening)),
        ),
```

In `place_agent`, right after `plan.disclose_assistant |= policy.disclose_assistant;`:

```rust
    // The answer plays the workspace's opening and the transcript notice before the plan's own
    // opening, as one text: the bridge splits it into sentences and plays the cached ones at once.
    plan.opening = policy.spoken_opening(&plan.opening);
```

and, still in `place_agent`, right after `plan.disclose_assistant |= policy.disclose_assistant;` and before the session is built (a plan that brings no closing plays the policy's):

```rust
    if plan.closing.is_empty() {
        plan.closing = policy.closing.clone().filter(|c| !c.trim().is_empty())
            .ok_or_else(|| invalid("plan.closing", "is empty and the call policy has no closing"))?;
    }
```

- [ ] **Step 5: The stored plan reads tolerantly; `calls.place` reads it strictly**

This must land before E1. `CallPlan` carries `#[serde(deny_unknown_fields)]`, so every plan field added later makes stored sessions and queued dials unreadable to an older release (a rollback) and to a bridge built before it. Strictness belongs at the boundary where an agent hands a plan in, not on the stored type.

In `plan.rs`, delete `#[serde(deny_unknown_fields)]` from `CallPlan`, and add to `impl CallPlan`:

```rust
    /// Every field of a plan, as `calls.place` accepts them (an input naming another is refused;
    /// a stored plan reads whatever a later release added).
    pub const FIELDS: [&'static str; 9] = [
        "opening", "goal", "holding", "fallback", "closing", "max_duration_s", "language",
        "disclose_assistant", "hotwords",
    ];
```

In `policy_opening.rs`, add:

```rust
#[test]
fn a_stored_plan_reads_a_field_a_later_release_added() {
    let mut value = json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."], "max_duration_s": 60,
    });
    value["spoken_by"] = json!("a later release");
    assert!(serde_json::from_value::<CallPlan>(value).is_ok());
}

#[test]
fn the_plans_field_list_is_every_field_it_writes() {
    let p: CallPlan = serde_json::from_value(json!({
        "opening": "a", "goal": "b", "holding": ["c"], "fallback": ["d"], "closing": "e",
        "max_duration_s": 60, "hotwords": ["Ada"],
    }))
    .unwrap();
    let mut written: Vec<String> = serde_json::to_value(&p).unwrap().as_object().unwrap().keys().cloned().collect();
    written.sort();
    let mut fields: Vec<String> = CallPlan::FIELDS.iter().map(|f| (*f).to_owned()).collect();
    fields.sort();
    assert_eq!(written, fields);
}
```

In `calls.rs`, `PlaceInput.plan` becomes `#[serde(default, deserialize_with = "strict_plan")] pub plan: Option<CallPlan>`, with:

```rust
/// The plan as `calls.place` takes it: a field the plan does not have is refused (`unknown field
/// `plan.<key>``), though a stored plan reads tolerantly.
fn strict_plan<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<CallPlan>, D::Error> {
    let Some(raw) = Option::<Value>::deserialize(d)?.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    if let Some(unknown) = raw
        .as_object()
        .and_then(|o| o.keys().find(|k| !CallPlan::FIELDS.contains(&k.as_str())))
    {
        return Err(serde::de::Error::custom(format!("unknown field `plan.{unknown}`")));
    }
    serde_json::from_value(raw).map(Some).map_err(serde::de::Error::custom)
}
```

The rollback note in E1 Step 4 still applies: 047da0cd keeps its strict `CallPlan`.

- [ ] **Step 6: The approved texts are a person's to change; an agent reads them**

**Owner decision** (coordinator, 2026-10-29; widened in the A4/A5 review). These policy fields are **person-only**: `opening_outbound`, `transcript_notice`, `closing`, `phrases`, `disclosure_sentence` and `greeting_inbound`.
- The owner approved these texts word for word, and the notice is legal text.
- `disclosure_sentence` is what the fence's disclosure check (D3) looks for. An agent that could rewrite it could make any opening "disclose".
- `greeting_inbound` is the inbound twin of `opening_outbound`.
- An agent reads them: `calls.policy_get` shows them, and the schema describes them.
- An agent's `calls.policy_set` that leaves one out keeps the stored value, never the default.
- A read-back value counts as unchanged. An agent's `calls.policy_set` that sends a value as stored, or as `calls.policy_get` showed it (with the workspace's templates filled in), keeps the stored value. So a read sent back changes nothing and freezes no template.
- An agent's `calls.policy_set` that sends any other value is refused, naming the field.
- A person (the panel) changes them.

This reuses the mechanism that makes turning `disclose_assistant` off person-only (`policy_set`: `!matches!(ctx.actor, Actor::Human { .. })`, `FORBIDDEN`). There is no `opening_inbound`. The inbound greeting is the older `greeting_inbound`, person-only like the outbound opening.

`PolicyInput` keeps the keys its body named:

```rust
/// `calls.policy_set`'s body: a whole policy, read strictly (an unknown key is refused at any
/// depth, `phrases.filler` included), and the top-level keys it named.
#[derive(Clone, Debug)]
pub struct PolicyInput {
    pub policy: CallPolicy,
    /// The keys the body named; `None` for a policy built in code, which names every key.
    pub given: Option<BTreeSet<String>>,
}

impl From<CallPolicy> for PolicyInput {
    fn from(policy: CallPolicy) -> Self {
        PolicyInput { policy, given: None }
    }
}
```

Its `Deserialize` replaces the top-level known-keys check with the nested one below, and fills `given` with `raw.as_object().map(|o| o.keys().cloned().collect())`:

```rust
/// The first key of `given`, at any depth, that `known` (the default policy's encoding) lacks,
/// as a dotted path. Only objects are compared: a list or a scalar is its field's type to check.
fn unknown_key(given: &Value, known: &Value, prefix: &str) -> Option<String> {
    let (Some(given), Some(known)) = (given.as_object(), known.as_object()) else {
        return None;
    };
    given.iter().find_map(|(k, v)| {
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        match known.get(k) {
            None => Some(path),
            Some(inner) => unknown_key(v, inner, &path),
        }
    })
}
```

Do not add `deny_unknown_fields` to the stored `CallPolicy` or `BridgePhrases`: stored values stay tolerant, and only the input is strict.

Change `policy_set` in three ways:
- It takes `input: PolicyInput` and opens with `let PolicyInput { mut policy, given } = input;`.
- It reads `before` first.
- For an actor that is not a person, it merges the stored texts back before the disclosure check. Move `policy.validate()` after this merge, so it checks what will be stored:

```rust
    if !matches!(ctx.actor, Actor::Human { .. }) {
        let name = r.workspace().get().await?.name;
        let shown = before.clone().with_workspace(&name);
        keep_person_only(&mut policy, &before, &shown, given.as_ref())?;
    }
```

```rust
/// The call policy's texts only a person changes (owner decision 2026-10-29).
pub const PERSON_ONLY: [&str; 6] = [
    "opening_outbound", "transcript_notice", "closing", "phrases", "disclosure_sentence", "greeting_inbound",
];

/// An agent's policy with the person-only texts as stored. A text the body left out keeps the
/// stored value. A text sent as stored, or as `calls.policy_get` shows it (`shown`, the
/// workspace's templates filled in), also keeps the stored value, so a read sent back changes
/// nothing and freezes no template. Any other value is `FORBIDDEN` with
/// `details.reason = "person_only"` and `details.field` naming it.
fn keep_person_only(
    policy: &mut CallPolicy,
    stored: &CallPolicy,
    shown: &CallPolicy,
    given: Option<&BTreeSet<String>>,
) -> Result<(), AppError> {
    fn keep<T: PartialEq + Clone>(
        field: &'static str,
        sent: &mut T,
        stored: &T,
        shown: &T,
        named: bool,
    ) -> Result<(), AppError> {
        if !named || sent == stored || sent == shown {
            *sent = stored.clone();
            return Ok(());
        }
        Err(AppError {
            code: ErrorCode::Forbidden,
            message: format!("only a person changes the call policy's {field}"),
            details: json!({ "reason": "person_only", "field": field }),
        })
    }
    let named = |k: &str| given.is_none_or(|g| g.contains(k));
    keep("opening_outbound", &mut policy.opening_outbound, &stored.opening_outbound, &shown.opening_outbound, named("opening_outbound"))?;
    keep("transcript_notice", &mut policy.transcript_notice, &stored.transcript_notice, &shown.transcript_notice, named("transcript_notice"))?;
    keep("closing", &mut policy.closing, &stored.closing, &shown.closing, named("closing"))?;
    keep("phrases", &mut policy.phrases, &stored.phrases, &shown.phrases, named("phrases"))?;
    keep("disclosure_sentence", &mut policy.disclosure_sentence, &stored.disclosure_sentence, &shown.disclosure_sentence, named("disclosure_sentence"))?;
    keep("greeting_inbound", &mut policy.greeting_inbound, &stored.greeting_inbound, &shown.greeting_inbound, named("greeting_inbound"))
}
```

`disclosure_sentence` and `greeting_inbound` are also filled by `with_workspace`, and they get the same "as shown means unchanged" rule. Stored empty, `calls.policy_get` shows the template with the workspace's name. An agent that sends that back keeps the stored empty value, so the template keeps following the workspace's name. The same holds when the agent sends back an owner's own text exactly as stored. A person's save is stored as sent (unchanged here). A panel save of an untouched template therefore still freezes the name; that is C5's to avoid.

MCP, `jt_mcp/src/tools/calls.rs`. Extend `policy_schema`'s `properties` with:

```rust
            "opening_outbound": { "type": ["string", "null"], "maxLength": 600,
                "description": "Played first when an outbound agent call is answered (null: the approved opening with the workspace's name; empty: none). Person-only; agents may read." },
            "transcript_notice": { "type": ["string", "null"], "maxLength": 600,
                "description": "Played after the opening on every agent call (null: the approved notice; empty: none). Person-only; agents may read." },
            "closing": { "type": ["string", "null"], "maxLength": 600,
                "description": "Played before an agent's call is hung up when its plan brings no closing (null: the approved closing). Person-only; agents may read." },
            "phrases": {
                "type": "object",
                "description": "The phrases the voice bridge plays on its own, six lists. Person-only; agents may read.",
                "properties": {
                    "acknowledgements": phrase_list(), "fillers": phrase_list(), "long_wait": phrase_list(),
                    "not_heard": phrase_list(), "still_there": phrase_list(), "fault": phrase_list(),
                },
                "additionalProperties": false,
            },
```

with `fn phrase_list() -> Value { json!({ "type": "array", "maxItems": 5, "items": { "type": "string", "minLength": 1, "maxLength": 600 } }) }`. Replace the two existing entries:

```rust
            "greeting_inbound": text("Played when an agent on duty answers an inbound call (empty: the approved greeting with the workspace's name). Person-only; agents may read."),
            "disclosure_sentence": text("The sentence an agent-driven opening must contain (empty: the approved one with the workspace's name). Person-only; agents may read."),
```

Change the tool descriptions:
- `calls.policy_get` names the six texts after the existing fields: "…, and the texts only a person changes (you may read them): opening_outbound, transcript_notice, closing, phrases (the six lists of sentences the voice bridge plays on its own), disclosure_sentence and greeting_inbound".
- `calls.policy_set` becomes: "Replace the workspace's call policy with the given one (every field as jeeta.calls.policy_get returns it; a field left out takes its default, except opening_outbound, transcript_notice, closing, phrases, disclosure_sentence and greeting_inbound, which only a person changes: left out or sent as read, they keep their stored values; a different value is FORBIDDEN, details.reason person_only naming the field). Only a person may turn disclose_assistant off (FORBIDDEN for you). Returns the stored policy. [risk: WRITE]".

Tests. In `calls_mcp.rs`:

```rust
#[test]
fn the_policy_schema_names_every_policy_field_and_marks_the_approved_texts_person_only() {
    let tools = tools();
    let schema = tools["jeeta.calls.policy_set"].input_schema.as_value().clone();
    let props = &schema["properties"];
    let policy = serde_json::to_value(jt_calls::CallPolicy::default()).unwrap();
    for key in policy.as_object().unwrap().keys() {
        assert!(props.get(key).is_some(), "policy_schema lacks {key}");
    }
    let phrases = serde_json::to_value(jt_calls::BridgePhrases::default()).unwrap();
    for key in phrases.as_object().unwrap().keys() {
        assert!(props["phrases"]["properties"].get(key).is_some(), "phrases lacks {key}");
    }
    assert_eq!(props["phrases"]["additionalProperties"], false);
    let get = tools["jeeta.calls.policy_get"].description;
    let person_only =
        ["opening_outbound", "transcript_notice", "closing", "phrases", "disclosure_sentence", "greeting_inbound"];
    assert_eq!(jt_app::usecases::calls::PERSON_ONLY, person_only);
    for key in person_only {
        let text = props[key]["description"].as_str().unwrap();
        assert!(text.contains("Person-only; agents may read."), "{key}: {text}");
        assert!(get.contains(key), "calls.policy_get does not name {key}");
    }
}
```

`rust/crates/jt_app/tests/calls_policy.rs`:

```rust
//! The call policy at its input boundary: the texts the owner approved are a person's to change
//! (an agent reads them), and a body's unknown keys are refused at any depth.
mod support;

use jt_app::error::ErrorCode;
use jt_app::usecases::calls::{self, PlaceInput, PolicyInput};
use jt_calls::{BridgePhrases, CallPolicy};
use serde_json::{Value, json};
use support::*;

fn body(v: Value) -> PolicyInput {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn an_agent_reads_the_approved_texts_but_only_a_person_changes_them() {
    let w = world().await;
    let agent = w.agent(&["calls.work", "calls.manage"]).await;
    let own = CallPolicy { closing: Some("Hoşça kalın.".into()), ..CallPolicy::default() };
    calls::policy_set(&w.deps, &w.owner_ctx, PolicyInput::from(own)).await.unwrap();
    // What the agent read, sent back with a timer changed: stored, the texts as they were.
    let mut read = serde_json::to_value(calls::policy_get(&w.deps, &agent).await.unwrap()).unwrap();
    read["slow_agent_s"] = json!(5);
    // The read shows the templates with the workspace's name; sent back, they count as unchanged.
    assert_eq!(read["disclosure_sentence"], "ben Acme'nin dijital asistanıyım");
    let out = calls::policy_set(&w.deps, &agent, body(read)).await.unwrap();
    assert_eq!(out.slow_agent_s, 5);
    assert_eq!(out.closing.as_deref(), Some("Hoşça kalın."));
    assert_eq!(out.opening_outbound, None, "the template is not frozen into the stored policy");
    assert_eq!(out.disclosure_sentence, "", "the template is not frozen into the stored policy");
    assert_eq!(out.greeting_inbound, "", "the template is not frozen into the stored policy");
    // Left out: kept, never reset to the defaults.
    let out = calls::policy_set(&w.deps, &agent, body(json!({ "slow_agent_s": 6 }))).await.unwrap();
    assert_eq!(out.closing.as_deref(), Some("Hoşça kalın."));
    // Sent different: refused, naming the field, and nothing stored.
    for (field, value) in [
        ("opening_outbound", json!("Selam, ben bir asistanım.")),
        ("transcript_notice", json!("")),
        ("closing", json!("Görüşürüz.")),
        ("phrases", json!({ "fillers": ["Bekleyin."] })),
        ("disclosure_sentence", json!("Merhaba")),
        ("greeting_inbound", json!("Merhaba, buyurun.")),
    ] {
        let mut sent = serde_json::Map::new();
        sent.insert(field.into(), value);
        let e = calls::policy_set(&w.deps, &agent, body(Value::Object(sent))).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden, "{field}");
        assert_eq!(e.details["reason"], "person_only", "{field}");
        assert_eq!(e.details["field"], field);
    }
    assert_eq!(calls::policy_get(&w.deps, &w.owner_ctx).await.unwrap().slow_agent_s, 6);
    // A person changes them.
    let sent = json!({ "closing": "Görüşürüz.", "phrases": { "fillers": ["Bekleyin."] } });
    let out = calls::policy_set(&w.deps, &w.owner_ctx, body(sent)).await.unwrap();
    assert_eq!(out.closing.as_deref(), Some("Görüşürüz."));
    assert_eq!(out.phrases.fillers, ["Bekleyin."]);
    assert_eq!(out.phrases.acknowledgements, BridgePhrases::default().acknowledgements);
}

#[test]
fn a_policy_body_with_an_unknown_key_at_any_depth_is_refused() {
    for (sent, path) in [
        (json!({ "phrase": {} }), "phrase"),
        (json!({ "phrases": { "filler": ["Bir saniye."] } }), "phrases.filler"),
    ] {
        let e = serde_json::from_value::<PolicyInput>(sent).unwrap_err().to_string();
        assert!(e.contains(&format!("unknown field `{path}`")), "{e}");
    }
    assert!(serde_json::from_value::<PolicyInput>(json!({ "phrases": { "fillers": ["Bir saniye."] } })).is_ok());
}

#[test]
fn a_place_body_refuses_a_field_the_plan_does_not_have() {
    let plan = json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."], "max_duration_s": 60, "spoken_by": "x",
    });
    let e = serde_json::from_value::<PlaceInput>(json!({ "purpose": "service", "mode": "agent", "plan": plan }))
        .unwrap_err()
        .to_string();
    assert!(e.contains("unknown field `plan.spoken_by`"), "{e}");
}
```

- [ ] **Step 7: Run the core tests (CI) and commit**

CI: `cargo test --locked -p jt_app --test calls_session --test calls_place --test calls_bridge --test calls_end --test calls_policy` and `cargo test --locked -p jt_mcp --test calls_mcp`
Expected: all pass, including:
- the four new `calls_session` tests;
- `every_played_text_is_authored` (the rig's empty opening and notice leave the plan's opening alone);
- the three `calls_policy` tests and the MCP schema parity test.

```bash
git add rust/crates/domain/jt_calls rust/crates/jt_app rust/crates/adapters/jt_mcp
git commit -m "feat(calls): the workspace's approved opening and transcript notice open every agent call" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Steps 5 and 6 may be their own commits: `fix(calls): a stored plan reads tolerantly, calls.place reads it strictly` and `feat(calls): the approved texts are a person's to change`.)

### Task C2: The core fills the dial's script; the agent may pass hotwords

**Files:**
- Modify: `rust/crates/jt_app/src/usecases/calls.rs` (`place_agent`, the dial)
- Modify: `rust/crates/adapters/jt_mcp/src/tools/calls.rs` (`place_schema`, `calls.place` description)
- Modify: `rust/crates/jt_app/tests/calls_session.rs`, `rust/crates/adapters/jt_mcp/tests/calls_mcp.rs`

- [ ] **Step 1: Write the failing tests**

In `calls_session.rs`:

```rust
#[tokio::test]
async fn the_dial_carries_the_policys_lines_its_phrases_and_the_hotwords() {
    let r = rig_with(1, CallPolicy { disclosure_sentence: String::new(), ..CallPolicy::default() }).await;
    let mut p = plan();
    p.opening = "Ada Hanım ile mi görüşüyorum?".into();
    p.hotwords = vec!["Ada".into(), "perşembe".into()];
    r.place_at(0, p).await;
    let dial = r.poll(1).await;
    let script = &dial[0].payload["script"];
    assert_eq!(
        script["lines"],
        json!(["Merhaba, ben Acme'nin dijital asistanıyım.", jt_calls::TRANSCRIPT_NOTICE])
    );
    assert_eq!(script["phrases"], serde_json::to_value(jt_calls::BridgePhrases::default()).unwrap());
    assert_eq!(script["hotwords"], json!(["Ada", "perşembe", "Acme"]));
}
```

In `calls_mcp.rs`:

```rust
#[test]
fn place_takes_hotwords_and_tells_the_opening_order() {
    let tools = tools();
    let place = tools["jeeta.calls.place"].input_schema.as_value().clone();
    let hotwords = &place["properties"]["plan"]["properties"]["hotwords"];
    assert_eq!(hotwords["maxItems"], 19);
    assert_eq!(hotwords["items"]["maxLength"], 40);
    // The closing is optional: left out, the call policy's closing plays.
    let required = place["properties"]["plan"]["required"].as_array().unwrap();
    assert!(!required.iter().any(|r| r == "closing"), "{required:?}");
    assert!(required.iter().any(|r| r == "opening"), "{required:?}");
    let text = tools["jeeta.calls.place"].description;
    assert!(text.contains("transcript notice"), "{text}");
    assert!(text.contains("the call policy's closing plays"), "{text}");
    assert!(text.contains("Görüşmek üzere, iyi günler."), "{text}");
}
```

CI: `cargo test --locked -p jt_app --test calls_session the_dial_carries` and `-p jt_mcp --test calls_mcp place_takes`
Expected: FAIL (empty script; no `hotwords` in the schema).

- [ ] **Step 2: Implement**

In `place_agent`'s dialing transaction, replace the dial built in Task A5 with:

```rust
    let business = r.workspace().get().await?.name;
    let policy = r.calls().policy().await?.with_workspace(&business);
    let script = DialScript {
        lines: policy.opening_lines(None).into_iter().map(str::to_owned).collect(),
        phrases: policy.phrases.clone(),
        hotwords: jt_calls::call_hotwords(&plan.hotwords, &business),
    };
    // The phrases the bridge is told are the phrases the log will show (the reducer logs a
    // `phrase` event with `session.phrases`, not with whatever the policy says by then).
    session.phrases = script.phrases.clone();
    r.calls().update(session.clone(), ctx.now).await?;
    let dial = Command::Dial {
        to_e164: session.counterpart_e164.clone(),
        plan,
        script,
    };
```

In `jt_mcp/src/tools/calls.rs` `place_schema`, inside `plan.properties`, add:

```rust
                    "hotwords": {
                        "type": "array",
                        "maxItems": 19,
                        "items": { "type": "string", "minLength": 1, "maxLength": 40 },
                        "description": "Names and product words from your context the speech recognition should expect on this call (at most 19; the workspace's name is added)."
                    },
```

drop `"closing"` from the plan's `required` (`"required": ["opening", "goal", "holding", "max_duration_s"]`, currently `tools/calls.rs:244`), make the `closing` property's description `"Optional. Played before the call is hung up; left out, the call policy's closing plays."`, and change the plan part of the `calls.place` description to:

```text
mode agent: you talk to the person yourself through the workspace's voice bridge, with a plan
written before you dial: opening (played right after the workspace's own opening and the transcript
notice of the call policy, which already disclose the assistant; for example "Ada Hanım ile mi
görüşüyorum?"; the whole spoken opening must contain the policy's disclosure_sentence), goal (never
played), holding (1 to 5 phrases played while you think when the bridge's own fillers did not cover
it), fallback (0 to 3 lines played when you stay silent), closing (optional; played before the call
is hung up; left out, the call policy's closing plays, by default "Görüşmek üzere, iyi günler."),
max_duration_s (1 to 900), language tr, hotwords (at most 19 names or product words the speech
recognition should expect; the workspace's name is added); every sentence at most 600 characters.
```

(the rest of the description — the purposes, one live call per connection, the refusal reasons, the masked number, `jeeta.calls.end`, `[risk: SPEND]` — unchanged; the `plan.opening` schema description becomes "Played after the workspace's opening and the transcript notice.").

- [ ] **Step 3: Run (CI) and commit**

CI: `cargo test --locked -p jt_app --test calls_session` and `cargo test --locked -p jt_mcp --test calls_mcp`
Expected: all pass.

```bash
git add rust/crates/jt_app rust/crates/adapters/jt_mcp
git commit -m "feat(calls): the dial carries the policy's lines, its phrases and the call's hotwords" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C3: Bridge phrases and turn traces reach the turn log and the call view

**Files:**
- Modify: `rust/crates/jt_app/src/usecases/calls.rs` (`view`)
- Modify: `rust/crates/jt_app/tests/calls_session.rs`

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn a_bridge_filler_is_logged_with_the_dialled_text_and_the_core_plays_no_holding_over_it() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    r.utterance(10, call, "Perşembe uygun mu?").await;
    r.report(12, call, json!([{ "kind": "phrase", "set": "filler", "index": 0 }])).await;
    let shown = r.shown(call).await;
    let last = shown.turns.last().unwrap();
    assert_eq!(last.kind, jt_calls::TurnKind::Holding);
    assert_eq!(last.text, "Bir saniye, hemen bakıyorum.");
    r.timers(14).await;
    assert!(r.poll(14).await.is_empty());
}

#[tokio::test]
async fn a_phrase_is_logged_with_the_text_dialled_even_after_the_owner_edits_the_policy() {
    let mut dialled = jt_calls::BridgePhrases::default();
    dialled.fillers = vec!["Hemen bakıyorum.".into()];
    let r = rig_with(1, CallPolicy { phrases: dialled, ..policy() }).await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    // The owner rewrites the fillers while the call is live.
    let mut edited = policy();
    edited.phrases.fillers = vec!["Biraz bekleyin.".into()];
    calls::policy_set(&r.w.deps, &r.w.owner_ctx, PolicyInput::from(edited)).await.unwrap();
    r.utterance(10, call, "Perşembe uygun mu?").await;
    r.report(12, call, json!([{ "kind": "phrase", "set": "filler", "index": 0 }])).await;
    let shown = r.shown(call).await;
    // The caller heard the dialled filler; the log says so.
    assert_eq!(shown.turns.last().unwrap().text, "Hemen bakıyorum.");
}

#[tokio::test]
async fn a_turns_trace_is_kept_and_summarised_in_the_call_view() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    r.report(
        20,
        call,
        json!([{ "kind": "trace", "trace": {
            "endpoint_ms": 260, "endpoint_by": "smart_turn", "stt_final_ms": 310, "delivered_ms": 340,
            "say_ms": 4340, "first_audio_ms": 4760, "ack_ms": 620 } }]),
    )
    .await;
    let shown = r.shown(call).await;
    assert_eq!(shown.call["metrics"]["traces"].as_array().unwrap().len(), 1);
    assert_eq!(shown.call["latency"]["perceived"]["p50"], 620);
    assert_eq!(shown.call["latency"]["content"]["p95"], 4760);
    assert_eq!(shown.call["latency"]["alerts"], json!(["content_p95_over_3s"]));
    // No agent sentence was ever said, so nothing pairs.
    assert_eq!(shown.call["latency"]["transport"]["n"], 0);
}

#[tokio::test]
async fn the_transport_overhead_pairs_a_trace_with_its_reply_by_seq() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    r.utterance(10, call, "Perşembe uygun mu?").await;
    r.say_at(12, call, "Uygun.").await;
    let seq = r.shown(call).await.turns.last().unwrap().seq;
    // The bridge's trace names the say it timed: 2.06 s from the answered POST to the say.
    r.report(
        14,
        call,
        json!([{ "kind": "trace", "trace": {
            "endpoint_ms": 260, "stt_final_ms": 310, "delivered_ms": 340, "say_ms": 2400, "reply_seq": seq } }]),
    )
    .await;
    // A last turn nobody answered: a trace with no reply, which pairs with nothing.
    r.report(
        16,
        call,
        json!([{ "kind": "trace", "trace": { "endpoint_ms": 250, "stt_final_ms": 300, "delivered_ms": 320 } }]),
    )
    .await;
    let shown = r.shown(call).await;
    let latency = shown.call["metrics"]["agent_latency_ms"][0].as_u64().unwrap();
    assert_eq!(shown.call["metrics"]["agent_replies"][0]["seq"], seq);
    assert_eq!(shown.call["latency"]["turns"], 2);
    assert_eq!(shown.call["latency"]["transport"]["n"], 1);
    assert_eq!(shown.call["latency"]["transport"]["p95"], 2_060 - latency);
}

#[tokio::test]
async fn a_calls_view_carries_neither_its_clock_nor_its_dialled_phrases() {
    // The phrases are the reducer's source for the turn log (about ten sentences a call), not
    // something `calls.get` or `calls.list` should repeat on every call.
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    let shown = r.shown(call).await;
    for key in ["clock", "phrases"] {
        assert!(shown.call.get(key).is_none(), "calls.get shows {key}");
    }
    let listed = calls::list(&r.w.deps, &r.agent_at(5), calls::ListQuery::default()).await.unwrap();
    assert!(!listed.is_empty());
    for item in &listed {
        for key in ["clock", "phrases"] {
            assert!(item.get(key).is_none(), "calls.list shows {key}");
        }
    }
}
```

CI: `cargo test --locked -p jt_app --test calls_session a_turns_trace the_transport a_calls_view`
Expected: FAIL (`latency` is null; `transport` is missing; the view carries `phrases`). (The two filler tests already pass from A5 and C2: keep them as the end-to-end guard.)

- [ ] **Step 2: Implement**

In `view` (calls.rs), next to `fields.remove("clock");` strip the dialled phrases the same way:

```rust
        fields.remove("phrases");
```

and, after inserting `counterpart`:

```rust
        fields.insert(
            "latency".into(),
            json!(jt_calls::summarize(
                &session.metrics.traces,
                &session.metrics.agent_latency_ms,
                &session.metrics.agent_replies,
            )),
        );
```

Consider also leaving `metrics.traces` out of the `calls.list` items and keeping it in `calls.get`. A call keeps up to 200 traces, and a list needs only the `latency` summary. If you do, the list builds its items with a `view` variant that removes `metrics.traces` after inserting `latency`, and the test above also asserts that `calls.list` items have no `metrics.traces` and do have `latency`.

**Do not cut a release between A5 and C3.** From A5 on, `calls.get` and `calls.list` carry the dialled `phrases` (about ten sentences per call) and the raw `metrics.traces`. Only C3 strips them.

Optional follow-ups (here or in B6):
- Count a `phrase` event whose index is outside the dialled set: `CallMetrics.phrase_mismatches: u32`, `#[serde(default)]`, incremented where `session.phrases.text(set, index)` is `None`. Today such an event logs nothing and is otherwise invisible; a non-zero count shows a bridge playing from a stale cache.
- On `Phrase { set: NotHeard }`, restart the caller-silence clock. The caller did speak, only unrecognised. Set `awaiting_caller_since = Some(now)` when it was set, and clear `silence_noted`, so `caller_silence_s`/`caller_silence_close_s` count from the "not heard" phrase, not from the agent's last sentence.

- [ ] **Step 3: Run (CI) and commit**

CI: `cargo test --locked -p jt_app --test calls_session --test calls_place --test calls_end` and `-p jt_mcp --test calls_mcp`
Expected: all pass (the view gained `latency` and lost `phrases`; nothing in the panel or the MCP outputs reads `call.phrases`).

```bash
git add rust/crates/jt_app
git commit -m "feat(calls): a call's turn traces and their p50/p95 in its view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C4: `calls.say` may wait for the reply (say and listen merged, backward compatible)

**Files:**
- Modify: `rust/crates/jt_app/src/usecases/calls/listen.rs` (`wait_turns`)
- Modify: `rust/crates/jt_app/src/usecases/calls/say.rs` (`SayInput.wait_reply_s`, `SayOut.events/timed_out`)
- Modify: `rust/crates/adapters/jt_mcp/src/tools/calls.rs` (`say_schema`, the `calls.say` and `calls.listen` descriptions)
- Modify: `rust/crates/jt_app/tests/calls_session.rs`, `rust/crates/adapters/jt_mcp/tests/calls_mcp.rs`

- [ ] **Step 1: Write the failing tests**

In `calls_session.rs` (also add `wait_reply_s: None,` to the `SayInput { … }` in `say_at`, and to any other literal: `grep -rn "SayInput {" rust/crates`):

```rust
#[tokio::test]
async fn say_with_wait_reply_returns_the_callers_next_words() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    r.utterance(10, call, "Merhaba?").await;
    let deps = r.w.deps.clone();
    let ctx = r.agent_at(11);
    let speaking = tokio::spawn(async move {
        say::say(
            &deps,
            &ctx,
            call,
            SayInput {
                text: "Perşembe uygun mu?".into(),
                expect_reply: true,
                allow_barge_in: true,
                wait_reply_s: Some(10),
            },
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    // The sentence was queued before the wait began.
    assert_eq!(kinds(&r.poll(11).await), ["say"]);
    // A phrase of the bridge is not the reply.
    r.report(12, call, json!([{ "kind": "phrase", "set": "acknowledgement", "index": 0 }])).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!speaking.is_finished());
    r.utterance(13, call, "Evet, uygun.").await;
    let out = speaking.await.unwrap().unwrap();
    assert_eq!(out.timed_out, Some(false));
    let events = out.events.unwrap();
    assert_eq!(events.last().unwrap().text, "Evet, uygun.");
    assert!(events.iter().all(|t| t.seq > out.seq));
}

#[tokio::test]
async fn say_without_wait_reply_answers_at_once_as_before() {
    let r = rig().await;
    let call = r.place_at(0, plan()).await;
    r.answer(call).await;
    let out = r.say_at(10, call, "Merhaba.").await;
    let shown = serde_json::to_value(&out).unwrap();
    assert!(shown.get("events").is_none() && shown.get("timed_out").is_none(), "{shown}");
}
```

In `calls_mcp.rs`:

```rust
#[test]
fn say_offers_wait_reply_s_and_asks_for_one_short_sentence() {
    let tools = tools();
    let say = tools["jeeta.calls.say"].input_schema.as_value().clone();
    assert_eq!(say["properties"]["wait_reply_s"]["maximum"], 25);
    assert_eq!(say["properties"]["wait_reply_s"]["minimum"], 0);
    let text = tools["jeeta.calls.say"].description;
    assert!(text.contains("one short sentence"), "{text}");
    assert!(text.contains("wait_reply_s"), "{text}");
}
```

CI: `cargo test --locked -p jt_app --test calls_session say_with` and `-p jt_mcp --test calls_mcp say_offers`
Expected: FAIL (no field `wait_reply_s`).

- [ ] **Step 2: Implement the shared wait**

Replace the body of `listen` in `listen.rs` by a call to a shared wait, and add it:

```rust
/// Waits on call `id` for the turns after `after_seq`, until `enough` holds for what was read, the
/// call ended, or `wait` passed: the call's state, the turns read, and whether the whole wait
/// passed. Woken by the bridges' signals, read again at least every [`FALLBACK_TICK`].
pub(crate) async fn wait_turns(
    deps: &Deps,
    ctx: &Ctx,
    id: CallId,
    after_seq: Option<u32>,
    wait: std::time::Duration,
    enough: fn(&[Turn]) -> bool,
) -> Result<(CallState, Vec<Turn>, bool), AppError> {
    let started = tokio::time::Instant::now();
    loop {
        // Watching before reading: a turn committed after the read still wakes the wait.
        let watch = deps.bridge_signals.watch(signal_key(ctx.workspace_id));
        let (state, events) = {
            let mut r = deps.uow.tenant(ctx.workspace_id).await?;
            let session = r
                .calls()
                .get(id)
                .await?
                .ok_or_else(|| AppError::not_found("no such call"))?;
            let events = r.calls().turns(id, after_seq, MAX_CALL_PAGE).await?;
            r.commit().await?;
            (session.state, events)
        };
        if enough(&events) || state == CallState::Ended {
            return Ok((state, events, false));
        }
        let waited = started.elapsed();
        if waited >= wait {
            return Ok((state, events, true));
        }
        let _ = tokio::time::timeout(FALLBACK_TICK.min(wait - waited), watch).await;
    }
}

pub async fn listen(
    deps: &Deps,
    ctx: &Ctx,
    id: CallId,
    query: ListenQuery,
) -> Result<ListenOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    let wait = std::time::Duration::from_secs(u64::from(
        query.wait_s.unwrap_or(MAX_WAIT_S).min(MAX_WAIT_S),
    ));
    let (state, events, timed_out) =
        wait_turns(deps, ctx, id, query.after_seq, wait, |t| !t.is_empty()).await?;
    Ok(ListenOut {
        call_id: id,
        state,
        events,
        timed_out,
    })
}
```

- [ ] **Step 3: Implement the merged say**

In `say.rs`: add to `SayInput`

```rust
    /// After queuing, wait up to this many seconds (at most 25) for the caller's reply and return
    /// it; absent or 0: answer at once, as before.
    #[serde(default)]
    pub wait_reply_s: Option<u32>,
```

change `SayOut` (drop `Eq`: turns carry a confidence):

```rust
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SayOut {
    pub call_id: CallId,
    pub seq: u32,
    pub state: CallState,
    /// With `wait_reply_s`: the turns after the sentence, up to the caller's reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Turn>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}
```

add the predicate:

```rust
/// Whether `turns` hold the caller's reply: words, a key, or the line reporting the caller's
/// silence, a hang-up or a transfer (a phrase the bridge played is not a reply).
fn holds_reply(turns: &[Turn]) -> bool {
    turns.iter().any(|t| match &t.kind {
        TurnKind::Utterance | TurnKind::Dtmf => true,
        TurnKind::Event { name } => matches!(name.as_str(), "caller_silence" | "hangup" | "transferred"),
        _ => false,
    })
}
```

and end `say` with:

```rust
    deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    let Some(wait_s) = input.wait_reply_s.filter(|s| *s > 0) else {
        return Ok(SayOut { call_id: id, seq, state, events: None, timed_out: None });
    };
    let wait = std::time::Duration::from_secs(u64::from(wait_s.min(super::MAX_WAIT_S)));
    let (state, events, timed_out) =
        super::listen::wait_turns(deps, ctx, id, Some(seq), wait, holds_reply).await?;
    Ok(SayOut { call_id: id, seq, state, events: Some(events), timed_out: Some(timed_out) })
```

(import `Turn, TurnKind` from `jt_calls`; update the doc comment of `say`: "With `wait_reply_s` it then waits for the caller's reply, as `calls.listen` after the sentence's turn would, and returns it.")

- [ ] **Step 4: Update the MCP schema and texts**

`say_schema` gains:

```rust
            "wait_reply_s": { "type": "integer", "minimum": 0, "maximum": 25, "description": "Wait this long (at most 25 s) for the person's reply and return it as events; without it the call answers at once." },
```

The `calls.say` description becomes:

```text
Say one short sentence (text, at most 600 characters) to the person on your live call; the voice
bridge speaks it as you wrote it. It returns as soon as the sentence is queued, so send the next
sentence right away: the first one plays while you write the next. wait_reply_s (0 to 25): after
queuing, wait for the person's reply (their words, a key, caller_silence or the hangup) and return
{events, timed_out} as jeeta.calls.listen would, which saves you one listen per turn. expect_reply
(default true): false when you will speak again before the person answers. allow_barge_in (default
true): the person may cut it by speaking (the turn then records interrupted_at_char, the characters
heard). Reply within 10 seconds of the person's words: the bridge acknowledges and fills a wait on
its own; after 4 s the caller hears a holding phrase if the bridge did not, after 20 s a fallback
line from your plan, and the call ends by script. CONFLICT not_live once the call ended. Returns
{call_id, seq, state}, and events and timed_out with wait_reply_s. [risk: WRITE]
```

and the last sentences of `calls.listen`'s description become: "After the person speaks, reply with jeeta.calls.say within 10 seconds: the bridge acknowledges and fills a wait on its own; after 4 s the caller hears a holding phrase if the bridge did not, after 20 s a fallback line from your plan, and the call ends by script once the fallback lines are spent. jeeta.calls.say with wait_reply_s returns the reply itself. [risk: READ]". Both keep the phrases `listen_long_poll_shape` checks ("within 10 seconds", "after 4 s", "after 20 s", "ends by script").

- [ ] **Step 5: Run (CI) and commit**

CI: `cargo test --locked -p jt_app --test calls_session` and `cargo test --locked -p jt_mcp --test calls_mcp` and `cargo test --locked -p jt_panel_http`
Expected: all pass; `listen_long_poll_shape` still passes.

```bash
git add rust/crates/jt_app rust/crates/adapters/jt_mcp
git commit -m "feat(calls): calls.say may wait for the reply; one short sentence per say" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task C5: The panel edits the opening and the phrases, and shows a call's latency

**Files:**
- Modify: `rust/panel/src/api/calls.ts`
- Modify: `rust/panel/src/pages/CallsPolicy.tsx`, `rust/panel/src/pages/CallDetail.tsx`
- Modify: `rust/panel/src/i18n/tr.json`, `rust/panel/src/i18n/en.json`
- Modify: `rust/panel/src/pages/CallsPolicy.test.tsx`, `rust/panel/src/pages/CallDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `CallsPolicy.test.tsx`, extend `stored` with:

```ts
  opening_outbound: "Merhaba, ben Acme'nin dijital asistanıyım.",
  transcript_notice: 'Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.',
  closing: 'Görüşmek üzere, iyi günler.',
  phrases: {
    acknowledgements: ['Hı hı.', 'Anladım.', 'Tamam.', 'Peki.'],
    fillers: ['Bir saniye, hemen bakıyorum.', 'Kontrol ediyorum, kısa bir an.'],
    long_wait: ['Biraz daha zaman alıyor, beklediğiniz için teşekkürler.'],
    not_heard: ['Sizi tam duyamadım, tekrar eder misiniz?'],
    still_there: ['Hâlâ orada mısınız?'],
    fault: ['Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.'],
  },
```

and add:

```ts
  it('saves_openings_and_phrases', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': stored,
      'PUT /api/calls/policy': stored,
    });
    renderAt('/calls');
    const notice = await screen.findByLabelText(tr.calls.policy.fields.transcript_notice);
    expect(screen.getByLabelText(tr.calls.policy.fields.closing)).toHaveValue(stored.closing);
    await user.clear(notice);
    await user.type(notice, 'Görüşme yazıya dökülür.');
    await user.type(screen.getByLabelText(tr.calls.policy.phrases.fillers), '{enter}Hemen dönüyorum.');
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        {
          ...stored,
          transcript_notice: 'Görüşme yazıya dökülür.',
          phrases: { ...stored.phrases, fillers: [...stored.phrases.fillers, 'Hemen dönüyorum.'] },
        },
      ]),
    );
  });
```

In `CallDetail.test.tsx` add (reuse the file's own manager/session fixture and call builder if it has them; otherwise this self-contained one):

```ts
it('shows_the_calls_latency', async () => {
  const call = {
    id: 'c-1', capability_id: 'cap-1', direction: 'outbound', purpose: 'service', person_id: null,
    journey_id: null, mode: { kind: 'agent' }, state: 'ended', counterpart: '+90 5** *** ** 67',
    started_at: '2026-10-29T09:00:00Z', answered_at: '2026-10-29T09:00:05Z', ended_at: '2026-10-29T09:02:00Z',
    end_cause: { cause: 'agent_ended' }, outcome: 'connected', summary: null, duration_s: 115, cost_minor: null,
    recording: { state: 'off' },
    latency: {
      turns: 2, backchannel_cuts: 0, alerts: ['content_p95_over_3s'],
      perceived: { n: 2, p50: 620, p95: 640 }, content: { n: 2, p50: 3900, p95: 4760 },
      endpoint: { n: 2, p50: 260, p95: 280 }, stt_final: { n: 2, p50: 310, p95: 330 },
      core_round: { n: 2, p50: 3600, p95: 4000 }, agent: { n: 2, p50: 3200, p95: 4100 },
      barge_in_stop: { n: 0, p50: null, p95: null }, transport: { n: 1, p50: 40, p95: 40 },
    },
  };
  mockFetch({ 'GET /api/auth/me': manager, 'GET /api/calls/c-1': { call, turns: [] } });
  renderAt('/calls/c-1');
  expect(await screen.findByText(tr.calls.detail.latencyTitle)).toBeInTheDocument();
  expect(screen.getByText('620 / 640 ms')).toBeInTheDocument();
  expect(screen.getByText(tr.calls.detail.alerts.content_p95_over_3s)).toBeInTheDocument();
});
```

Run: `pnpm --dir rust/panel test -- CallsPolicy CallDetail`
Expected: FAIL (labels and the latency section missing).

- [ ] **Step 2: Types, page code and copy**

`api/calls.ts`: add

```ts
/** `jt_calls::BridgePhrases`: what the voice bridge may play on its own. */
export interface CallPhrases {
  acknowledgements: string[];
  fillers: string[];
  long_wait: string[];
  not_heard: string[];
  still_there: string[];
  fault: string[];
}

/** `jt_calls::Percentiles`. */
export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
}

/** `jt_calls::LatencySummary`: a call's turn timings, in ms. */
export interface LatencySummary {
  turns: number;
  perceived: Percentiles;
  content: Percentiles;
  endpoint: Percentiles;
  stt_final: Percentiles;
  core_round: Percentiles;
  agent: Percentiles;
  barge_in_stop: Percentiles;
  transport: Percentiles;
  backchannel_cuts: number;
  alerts: string[];
}
```

`CallPolicy` gains `opening_outbound: string | null; transcript_notice: string | null; closing: string | null; phrases: CallPhrases;` and `CallView` gains `latency?: LatencySummary;`.

`CallsPolicy.tsx`: after the `TEXTS` constants add

```tsx
type OpeningKey = 'opening_outbound' | 'transcript_notice' | 'closing';
const OPENINGS: OpeningKey[] = ['opening_outbound', 'transcript_notice', 'closing'];
type PhraseKey = keyof CallPhrases;
const PHRASE_SETS: PhraseKey[] = ['acknowledgements', 'fillers', 'long_wait', 'not_heard', 'still_there', 'fault'];
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const joined = (p: CallPhrases) =>
  Object.fromEntries(PHRASE_SETS.map((k) => [k, p[k].join('\n')])) as Record<PhraseKey, string>;
```

(import `type CallPhrases` from `@/api/calls`); in `PolicyForm` add `const [phrases, setPhrases] = useState(joined(stored.phrases));`, `setPhrases(joined(stored.phrases));` inside the existing `useEffect`, and in `mutationFn` the field `phrases: Object.fromEntries(PHRASE_SETS.map((k) => [k, lines(phrases[k])])) as CallPhrases,`; render after the `TEXTS` fields:

```tsx
      {OPENINGS.map((key) => (
        <Field
          key={key}
          label={t(`calls.policy.fields.${key}`)}
          hint={t(key === 'closing' ? 'calls.policy.closingHint' : 'calls.policy.openingHint')}
        >
          {(ids) => (
            <Textarea
              id={ids.id}
              aria-describedby={ids.describedBy}
              value={policy[key] ?? ''}
              maxLength={600}
              onChange={(e) => setPolicy({ ...policy, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
```

and after the holding field:

```tsx
      {PHRASE_SETS.map((key) => (
        <Field key={key} label={t(`calls.policy.phrases.${key}`)} hint={t('calls.policy.phrasesHint')}>
          {(ids) => (
            <Textarea
              id={ids.id}
              aria-describedby={ids.describedBy}
              value={phrases[key]}
              onChange={(e) => setPhrases({ ...phrases, [key]: e.target.value })}
            />
          )}
        </Field>
      ))}
```

`CallDetail.tsx`: add (with `import { Fragment } from 'react';` and `type LatencySummary, type Percentiles` from `@/api/calls`):

```tsx
function Latency({ latency }: { latency: LatencySummary }) {
  const { t } = useTranslation();
  const rows: [string, Percentiles][] = [
    ['perceived', latency.perceived],
    ['content', latency.content],
    ['agent', latency.agent],
    ['barge_in_stop', latency.barge_in_stop],
  ];
  const ms = (v: number | null) => (v === null ? '—' : String(v));
  return (
    <section className="mt-3" aria-label={t('calls.detail.latencyTitle')}>
      <h3 className="mb-1 text-sm font-medium">{t('calls.detail.latencyTitle')}</h3>
      <dl className="grid gap-1 text-sm sm:grid-cols-2">
        {rows.map(([key, p]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{t(`calls.detail.latency_${key}`)}</dt>
            <dd>{t('calls.detail.latencyValue', { p50: ms(p.p50), p95: ms(p.p95) })}</dd>
          </Fragment>
        ))}
      </dl>
      {latency.alerts.map((a) => (
        <p key={a} className="text-sm text-destructive">
          {t(`calls.detail.alerts.${a}`, { defaultValue: a })}
        </p>
      ))}
    </section>
  );
}
```

and in the first card, right after `</dl>`: `{c.latency && c.latency.turns > 0 && <Latency latency={c.latency} />}`.

`tr.json`, under `calls.policy`: `"openingHint": "Arama açılınca hemen çalınır; boş bırakılırsa çalınmaz."`, `"phrasesHint": "Her satıra bir cümle (en çok 5). Köprü bunları ajan düşünürken kendi başına çalar."`, in `fields`: `"opening_outbound": "Giden aramada işletmenin açılış cümlesi"`, `"transcript_notice": "Yazıya dökme bildirimi"`, `"closing": "Planda kapanış yoksa kapanış cümlesi"`, `"closingHint": "Plan bir kapanış cümlesi getirmediğinde arama kapatılmadan önce çalınır; boş bırakılırsa her plan kendi kapanışını getirmek zorundadır."` (beside `openingHint`), and

```json
"phrases": {
  "acknowledgements": "Onay sesleri (≈0,6 sn)",
  "fillers": "Bekleme cümleleri (≈2,7 sn)",
  "long_wait": "Uzun bekleme cümlesi (≈8 sn)",
  "not_heard": "Duyulamadığında",
  "still_there": "Karşı taraf sessiz kaldığında",
  "fault": "Teknik sorun cümlesi"
}
```

under `calls.detail`: `"latencyTitle": "Gecikme (p50 / p95)"`, `"latency_perceived": "İlk ses"`, `"latency_content": "Cevabın ilk sesi"`, `"latency_agent": "Ajanın cevap süresi"`, `"latency_barge_in_stop": "Söz kesmede susma"`, `"latencyValue": "{{p50}} / {{p95}} ms"`, and

```json
"alerts": {
  "perceived_p95_over_1s": "İlk ses p95 1 saniyenin üstünde",
  "content_p95_over_3s": "Cevap p95 3 saniyenin üstünde",
  "barge_in_p95_over_300ms": "Söz kesmede susma p95 300 ms'nin üstünde"
}
```

`en.json`, the same keys: `"openingHint": "Played as soon as the call is answered; left empty, nothing is played."`, `"phrasesHint": "One sentence per line (at most 5). The bridge plays these on its own while the agent thinks."`, `"opening_outbound": "Business opening on outbound calls"`, `"transcript_notice": "Transcription notice"`, `"closing": "Closing when the plan brings none"`, `"closingHint": "Played before the call is hung up when the plan brings no closing; left empty, every plan must bring its own."`, phrases `"Acknowledgements (≈0.6 s)"`, `"Fillers (≈2.7 s)"`, `"Long wait (≈8 s)"`, `"When not heard"`, `"When the other side stays silent"`, `"Technical problem"`; detail `"Latency (p50 / p95)"`, `"First sound"`, `"First sound of the reply"`, `"Agent's reply time"`, `"Stopping on barge-in"`, `"{{p50}} / {{p95}} ms"`, alerts `"First sound p95 above 1 second"`, `"Reply p95 above 3 seconds"`, `"Stopping on barge-in p95 above 300 ms"`.

- [ ] **Step 3: Run and commit**

Run: `pnpm --dir rust/panel test` and `pnpm --dir rust/panel typecheck`
Expected: all pass, including the i18n parity test.

```bash
git add rust/panel/src
git commit -m "feat(panel): call opening, notice and bridge phrases in the policy; a call's latency" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

## Phase D — the talker against the core

### Task D1: The Jeeta client

**Files:**
- Create: `rust/bridge/voice/src/jeeta.rs`
- Create: `rust/bridge/voice/tests/jeeta_client.rs`
- Modify: `rust/bridge/voice/src/lib.rs` (`pub mod jeeta;`)

- [ ] **Step 1: Write the failing test**

`rust/bridge/voice/tests/jeeta_client.rs`:

```rust
//! The bridge's calls to Jeeta, against a fake Jeeta: the key on every route, the request header on
//! the posts, the long-poll's query, the bodies of `jt_calls::wire`; errors without the address.
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jeeta_voice_bridge::jeeta::{ClientError, JeetaClient};
use jt_calls::BridgeEvent;
use jt_calls::wire::{CommandsQuery, EventIn, EventsInput, RegisterInput, SpeechToText, TextToSpeech};
use serde_json::{Value, json};
use time::OffsetDateTime;

type Seen = Arc<Mutex<Vec<String>>>;

fn header(h: &HeaderMap, name: &str) -> String {
    h.get(name).map_or("-".into(), |v| v.to_str().unwrap().to_owned())
}

async fn fake_jeeta() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let app = Router::new()
        .route(
            "/api/voice/bridge/register",
            post(|State(s): State<Seen>, h: HeaderMap, Json(body): Json<Value>| async move {
                if header(&h, "authorization") == "Bearer bad" {
                    return (StatusCode::FORBIDDEN, Json(json!({ "code": "FORBIDDEN" }))).into_response();
                }
                s.lock().unwrap().push(format!(
                    "register {} {} {}",
                    header(&h, "authorization"),
                    header(&h, "x-requested-with"),
                    body["extension"]
                ));
                Json(json!({ "capability_id": "00000000-0000-0000-0000-000000000001", "status": "verified", "heartbeat_s": 15 }))
                    .into_response()
            }),
        )
        .route(
            "/api/voice/bridge/commands",
            get(|State(s): State<Seen>, h: HeaderMap, Query(q): Query<Vec<(String, String)>>| async move {
                s.lock().unwrap().push(format!("commands {q:?} {}", header(&h, "authorization")));
                Json(json!({ "commands": [], "timed_out": true }))
            }),
        )
        .route(
            "/api/voice/bridge/events",
            post(|State(s): State<Seen>, h: HeaderMap, Json(body): Json<Value>| async move {
                s.lock().unwrap().push(format!("events {} {}", body["events"][0]["kind"], header(&h, "x-requested-with")));
                Json(json!({ "accepted": 1, "duplicates": 0, "unmatched": 0 }))
            }),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

fn register_input() -> RegisterInput {
    RegisterInput {
        extension: "102".into(),
        codecs: vec!["PCMA".into(), "PCMU".into()],
        max_calls: 1,
        stt: SpeechToText { engine: "seda".into(), model: "seda-v0.1".into() },
        tts: TextToSpeech { engine: "ema".into(), voice: "ema-lightning-1.1.2".into() },
        version: "0.1.0".into(),
    }
}

#[tokio::test]
async fn the_key_and_the_request_header_go_where_jeeta_expects_them() {
    let (base, seen) = fake_jeeta().await;
    let client = JeetaClient::new(&base, "jeeta_test_key");
    assert_eq!(client.register(&register_input()).await.unwrap().heartbeat_s, 15);
    let polled = client
        .commands(&CommandsQuery { wait_s: Some(25), extension: Some("102".into()) })
        .await
        .unwrap();
    assert!(polled.timed_out);
    let batch = EventsInput {
        events: vec![EventIn { bridge_call_id: "c-1".into(), bridge_seq: 1, at: OffsetDateTime::now_utc(), event: BridgeEvent::Ringing }],
    };
    assert_eq!(client.events(&batch).await.unwrap().accepted, 1);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0], "register Bearer jeeta_test_key jeeta-panel \"102\"");
    assert_eq!(seen[1], "commands [(\"wait_s\", \"25\"), (\"extension\", \"102\")] Bearer jeeta_test_key");
    assert_eq!(seen[2], "events \"ringing\" jeeta-panel");
}

#[tokio::test]
async fn errors_carry_a_status_or_a_kind_and_never_the_address() {
    let (base, _) = fake_jeeta().await;
    let refused = JeetaClient::new(&base, "bad").register(&register_input()).await.unwrap_err();
    assert!(matches!(refused, ClientError::Status(403)));
    assert!(!refused.retryable());
    let unreachable = JeetaClient::new("http://127.0.0.1:9", "k").register(&register_input()).await.unwrap_err();
    assert!(matches!(unreachable, ClientError::Transport));
    assert!(unreachable.retryable());
    assert!(!unreachable.to_string().contains("127.0.0.1"));
}
```

Run: `cargo test -p jeeta-voice-bridge --test jeeta_client`
Expected: FAIL to compile (`jeeta` not found).

- [ ] **Step 2: Write `jeeta.rs`**

```rust
//! The bridge's HTTP client to Jeeta (`/api/voice/bridge/*`, `docs/operations/voice-bridge.md` §3):
//! the bearer key on every request, `X-Requested-With: jeeta-panel` on the posts (the API's
//! request-header check), the bodies of `jt_calls::wire`. On the host it calls the core on
//! loopback (`JEETA_BASE_URL=http://127.0.0.1:809x`). Errors never carry the address, the key or a body.

use std::time::Duration;

use jt_calls::wire::{CommandsOut, CommandsQuery, EventsInput, EventsOut, RegisterInput, RegisterOut};
use serde::de::DeserializeOwned;

pub const REQUESTED_WITH: &str = "jeeta-panel";
/// The 25-second long-poll, and room for the core's answer.
const TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Jeeta answered {0}")]
    Status(u16),
    #[error("Jeeta is unreachable")]
    Transport,
    #[error("Jeeta's answer is unreadable")]
    Decode,
}

impl ClientError {
    /// Whether the same request may succeed later (the core is down, busy or throttling).
    pub fn retryable(&self) -> bool {
        match self {
            ClientError::Status(s) => *s == 408 || *s == 429 || *s >= 500,
            ClientError::Transport | ClientError::Decode => true,
        }
    }
}

pub struct JeetaClient {
    http: reqwest::Client,
    base: String,
    key: String,
}

impl JeetaClient {
    pub fn new(base: &str, key: &str) -> JeetaClient {
        JeetaClient {
            http: reqwest::Client::builder().timeout(TIMEOUT).build().unwrap_or_default(),
            base: base.trim_end_matches('/').to_owned(),
            key: key.to_owned(),
        }
    }

    async fn send<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> Result<T, ClientError> {
        let response = request.bearer_auth(&self.key).send().await.map_err(|_| ClientError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ClientError::Status(status.as_u16()));
        }
        response.json::<T>().await.map_err(|_| ClientError::Decode)
    }

    pub async fn register(&self, body: &RegisterInput) -> Result<RegisterOut, ClientError> {
        let url = format!("{}/api/voice/bridge/register", self.base);
        self.send(self.http.post(url).header("X-Requested-With", REQUESTED_WITH).json(body)).await
    }

    pub async fn commands(&self, query: &CommandsQuery) -> Result<CommandsOut, ClientError> {
        let url = format!("{}/api/voice/bridge/commands", self.base);
        self.send(self.http.get(url).query(query)).await
    }

    pub async fn events(&self, body: &EventsInput) -> Result<EventsOut, ClientError> {
        let url = format!("{}/api/voice/bridge/events", self.base);
        self.send(self.http.post(url).header("X-Requested-With", REQUESTED_WITH).json(body)).await
    }
}
```

- [ ] **Step 3: Run and commit**

Run: `cargo test -p jeeta-voice-bridge --test jeeta_client`
Expected: `2 passed`.

```bash
git add rust/bridge/voice
git commit -m "feat(voice-bridge): the client of Jeeta's voice bridge routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D2: The run loop (heartbeat, command poll, ARI events, ordered reports)

**Files:**
- Create: `rust/bridge/voice/src/run_loop.rs`
- Create: `rust/bridge/voice/tests/run_loop.rs`
- Modify: `rust/bridge/voice/src/main.rs` (the `run` command), `src/lib.rs` (`pub mod run_loop;`)

- [ ] **Step 1: Write the failing test**

`rust/bridge/voice/tests/run_loop.rs`:

```rust
//! The line end to end against a fake Jeeta and a fake ARI: a Turkish dial reaches the PBX, a
//! foreign one is refused as a failure, every command is acknowledged, the bridge registers.
mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::run_loop::run;
use jt_calls::wire::BridgeCommand;
use jt_calls::{CallCommandId, CallId, CallPlan, Command, DialScript};
use serde_json::{Value, json};
use support::fake_ari;
use tokio::sync::watch;
use uuid::Uuid;

type Seen = Arc<Mutex<Vec<String>>>;

fn plan() -> CallPlan {
    serde_json::from_value(json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "test", "holding": ["Bir saniye."],
        "closing": "Görüşmek üzere, iyi günler.", "max_duration_s": 120,
    }))
    .unwrap()
}

fn dial(call: &str, to: &str) -> BridgeCommand {
    BridgeCommand::of(
        CallCommandId(Uuid::now_v7()),
        CallId(Uuid::now_v7()),
        Some(call.into()),
        &Command::Dial { to_e164: to.into(), plan: plan(), script: DialScript::default() },
    )
}

async fn fake_jeeta(first: Vec<BridgeCommand>) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let queue = Arc::new(Mutex::new(Some(first)));
    let app = Router::new()
        .route("/api/voice/bridge/register", post(|State((s, _)): State<(Seen, Arc<Mutex<Option<Vec<BridgeCommand>>>>)>, Json(b): Json<Value>| async move {
            s.lock().unwrap().push(format!("register {}", b["extension"].as_str().unwrap()));
            Json(json!({ "capability_id": "00000000-0000-0000-0000-000000000001", "status": "verified", "heartbeat_s": 15 }))
        }))
        .route("/api/voice/bridge/commands", get(|State((_, q)): State<(Seen, Arc<Mutex<Option<Vec<BridgeCommand>>>>)>| async move {
            let next = q.lock().unwrap().take();
            match next {
                Some(commands) => Json(json!({ "commands": commands, "timed_out": false })),
                None => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    Json(json!({ "commands": [], "timed_out": true }))
                }
            }
        }))
        .route("/api/voice/bridge/events", post(|State((s, _)): State<(Seen, Arc<Mutex<Option<Vec<BridgeCommand>>>>)>, Json(b): Json<Value>| async move {
            for e in b["events"].as_array().unwrap() {
                s.lock().unwrap().push(format!("{} {}", e["bridge_call_id"].as_str().unwrap(), e["kind"].as_str().unwrap()));
            }
            Json(json!({ "accepted": 1, "duplicates": 0, "unmatched": 0 }))
        }))
        .with_state((seen.clone(), queue));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

#[tokio::test]
async fn a_dial_reaches_the_pbx_and_every_command_is_acknowledged() {
    let (ari_base, ari_log) = fake_ari().await;
    let (jeeta_base, seen) = fake_jeeta(vec![dial("call-de", "+4915112345678"), dial("call-tr", "+905321234567")]).await;
    let dir = std::env::temp_dir().join(format!("voice-run-{}", std::process::id()));
    let env: HashMap<&str, String> = HashMap::from([
        ("JEETA_BASE_URL", jeeta_base),
        ("JEETA_BRIDGE_KEY", "jeeta_test".into()),
        ("ARI_URL", ari_base),
        ("ARI_PASSWORD", "p".into()),
        ("LISTEN_SOCKET", "tcp:127.0.0.1:9".into()),
        ("SPEAK_SOCKET", "tcp:127.0.0.1:9".into()),
        ("VOICE_CACHE_DIR", dir.join("cache").display().to_string()),
        ("VOICE_TRACE_FILE", dir.join("traces.jsonl").display().to_string()),
    ]);
    let config = Config::from_env(|k| env.get(k).cloned(), true).unwrap();
    let (stop_tx, stop_rx) = watch::channel(false);
    let task = tokio::spawn(run(config, stop_rx));
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(8), task).await.unwrap().unwrap();
    let ari = ari_log.lock().unwrap().join("\n");
    assert!(ari.contains("PJSIP/05321234567@netgsm"), "{ari}");
    assert!(!ari.contains("4915112345678"), "{ari}");
    let seen = seen.lock().unwrap().clone();
    assert!(seen.contains(&"register 102".to_owned()), "{seen:?}");
    assert!(seen.contains(&"call-de error".to_owned()), "{seen:?}");
    assert_eq!(seen.iter().filter(|e| e.ends_with("command_done")).count(), 2, "{seen:?}");
    let _ = std::fs::remove_dir_all(dir);
}
```

Run: `cargo test -p jeeta-voice-bridge --test run_loop`
Expected: FAIL to compile (`run_loop` not found).

- [ ] **Step 2: Write `run_loop.rs`**

```rust
//! `run`: the workspace's line (design addendum §2, §4). It registers every heartbeat, keeps one
//! command long-poll outstanding and hands each command to its call's task (a dial starts one),
//! forwards Asterisk's events to the calls, and posts what the calls report, in order and as soon as
//! it happens, each event once by its `(bridge_call_id, bridge_seq)`. When the core stays
//! unreachable for five seconds the live calls are told (they play the fault sentence and hang up).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use jt_calls::wire::{BridgeCommand, CommandsQuery, EventIn, EventsInput, RegisterInput, SpeechToText, TextToSpeech};
use jt_calls::{BridgeEvent, CallCommandId, CallPlan, Command, DialScript};
use time::OffsetDateTime;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::ari::{self, Ari, AriEvent};
use crate::call::{CallDeps, CallSetup, Report, ToCall, run_call};
use crate::config::Config;
use crate::jeeta::JeetaClient;
use crate::netgsm;
use crate::trace::TraceFile;

/// The calls on the line, by the bridge's id of the call (also its Asterisk channel id).
pub type Registry = Arc<Mutex<HashMap<String, mpsc::Sender<ToCall>>>>;

const CORE_LOST_AFTER: Duration = Duration::from_secs(5);
const POLL_WAIT_S: u32 = 25;
const SEEN_COMMANDS: usize = 1_000;

/// What the bridge reports of itself.
pub fn register_input(config: &Config) -> RegisterInput {
    RegisterInput {
        extension: config.extension.clone(),
        codecs: vec!["PCMA".into(), "PCMU".into()],
        max_calls: 1,
        stt: SpeechToText { engine: "seda".into(), model: "seda-v0.1".into() },
        tts: TextToSpeech { engine: "ema".into(), voice: "ema-lightning-1.1.2".into() },
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

#[derive(Default)]
struct Seen {
    order: VecDeque<CallCommandId>,
    set: HashSet<CallCommandId>,
}

impl Seen {
    /// `true` the first time `id` is seen.
    fn insert(&mut self, id: CallCommandId) -> bool {
        if !self.set.insert(id) {
            return false;
        }
        self.order.push_back(id);
        if self.order.len() > SEEN_COMMANDS
            && let Some(old) = self.order.pop_front()
        {
            self.set.remove(&old);
        }
        true
    }
}

/// Runs the line until `stop` turns true.
pub async fn run(config: Config, mut stop: watch::Receiver<bool>) {
    let jeeta = Arc::new(JeetaClient::new(&config.jeeta_base_url, &config.bridge_key));
    let ari = Arc::new(Ari::new(&config.ari_url, &config.ari_user, &config.ari_password));
    // A call cannot outlive the task that ran it: whatever Asterisk still carries is hung up.
    if let Ok(left) = ari.channel_ids().await {
        let count = left.len();
        for channel in left {
            let _ = ari.hangup(&channel).await;
        }
        if count > 0 {
            warn!(count, "hung up the channels left from before");
        }
    }
    let deps = Arc::new(CallDeps {
        ari: ari.clone(),
        listen: config.listen.clone(),
        speak: config.speak.clone(),
        cache_dir: config.cache_dir.clone(),
        timing: config.timing,
        traces: Some(TraceFile::new(config.trace_file.clone())),
    });
    let calls: Registry = Arc::default();
    let (reports_tx, reports_rx) = mpsc::channel::<Report>(1_024);
    let beat = tokio::spawn(heartbeat(jeeta.clone(), register_input(&config)));
    let poster = tokio::spawn(post_reports(jeeta.clone(), reports_rx, calls.clone()));
    let events = tokio::spawn(forward_ari(ari.clone(), calls.clone()));
    let mut seen = Seen::default();
    info!("the line is up");
    loop {
        let query = CommandsQuery { wait_s: Some(POLL_WAIT_S), extension: Some(config.extension.clone()) };
        tokio::select! {
            _ = stop.changed() => break,
            out = jeeta.commands(&query) => match out {
                Ok(out) => {
                    for c in out.commands {
                        dispatch(c, &deps, &calls, &reports_tx, &mut seen).await;
                    }
                }
                Err(e) => {
                    warn!(error = %e, "the command poll failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            },
        }
    }
    info!("stopping");
    if let Ok(mut c) = calls.lock() {
        c.clear();
    }
    beat.abort();
    events.abort();
    drop(reports_tx);
    let _ = tokio::time::timeout(Duration::from_secs(5), poster).await;
}

async fn heartbeat(jeeta: Arc<JeetaClient>, body: RegisterInput) {
    let mut registered = false;
    loop {
        let pause = match jeeta.register(&body).await {
            Ok(out) => {
                if !registered {
                    info!(status = ?out.status, "registered with the core");
                }
                registered = true;
                Duration::from_secs(u64::from(out.heartbeat_s.max(1)))
            }
            Err(e) => {
                warn!(error = %e, "registration failed");
                registered = false;
                Duration::from_secs(2)
            }
        };
        tokio::time::sleep(pause).await;
    }
}

async fn dispatch(c: BridgeCommand, deps: &Arc<CallDeps>, calls: &Registry, reports: &mpsc::Sender<Report>, seen: &mut Seen) {
    let call = c.bridge_call_id.clone().unwrap_or_else(|| c.call_id.to_string());
    if seen.insert(c.id) {
        match c.command() {
            Ok(Command::Dial { to_e164, plan, script }) => start_call(&call, &to_e164, plan, script, deps, calls, reports).await,
            Ok(command) => {
                let tx = calls.lock().ok().and_then(|m| m.get(&call).cloned());
                if let Some(tx) = tx {
                    let _ = tx.send(ToCall::Command(command)).await;
                }
            }
            Err(_) => warn!(command = %c.id, kind = %c.kind, "a command this build cannot read"),
        }
    }
    let done = Report { bridge_call_id: call, event: BridgeEvent::CommandDone { id: c.id }, taken: None };
    let _ = reports.send(done).await;
}

async fn start_call(
    call: &str,
    to_e164: &str,
    plan: CallPlan,
    script: DialScript,
    deps: &Arc<CallDeps>,
    calls: &Registry,
    reports: &mpsc::Sender<Report>,
) {
    let refuse = |failure_line: &str| Report {
        bridge_call_id: call.to_owned(),
        event: BridgeEvent::Error { failure_line: failure_line.to_owned() },
        taken: None,
    };
    let Some(dial) = netgsm::dial_string(to_e164) else {
        // Geographic, mobile, 0800 and 0850 numbers only (B4 review I6).
        warn!(call, "a number the line may not call was refused");
        let _ = reports
            .send(refuse("permanent: bridge: this line calls Turkish geographic, mobile, 0800 and 0850 numbers only"))
            .await;
        return;
    };
    if calls.lock().map(|m| !m.is_empty()).unwrap_or(true) {
        let _ = reports.send(refuse("transient: bridge: the line is busy")).await;
        return;
    }
    let (tx, rx) = mpsc::channel(64);
    if let Ok(mut m) = calls.lock() {
        m.insert(call.to_owned(), tx);
    }
    let setup = CallSetup {
        bridge_call_id: call.to_owned(),
        dial,
        script,
        plan_lines: plan.playable().map(str::to_owned).collect(),
    };
    let (deps, calls, reports, call) = (deps.clone(), calls.clone(), reports.clone(), call.to_owned());
    tokio::spawn(async move {
        run_call(deps, setup, rx, reports).await;
        if let Ok(mut m) = calls.lock() {
            m.remove(&call);
        }
    });
}

/// The first `bridge_seq` of a call: 1 for a call dialled by this process; for any other (a command
/// of a call from before a restart) a number no earlier process used.
fn first_seq(dialled_here: bool) -> u32 {
    if dialled_here {
        return 1;
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    1_000_000 + u32::try_from(secs % 1_000_000).unwrap_or(0) * 1_000
}

async fn post_reports(jeeta: Arc<JeetaClient>, mut rx: mpsc::Receiver<Report>, calls: Registry) {
    let mut seqs: HashMap<String, u32> = HashMap::new();
    let mut failing_since: Option<Instant> = None;
    let mut lost = false;
    while let Some(report) = rx.recv().await {
        let dialled = calls.lock().map(|m| m.contains_key(&report.bridge_call_id)).unwrap_or(false);
        let seq = seqs
            .entry(report.bridge_call_id.clone())
            .or_insert_with(|| first_seq(dialled).saturating_sub(1));
        *seq += 1;
        let body = EventsInput {
            events: vec![EventIn {
                bridge_call_id: report.bridge_call_id.clone(),
                bridge_seq: *seq,
                at: OffsetDateTime::now_utc(),
                event: report.event,
            }],
        };
        let taken = report.taken;
        loop {
            match jeeta.events(&body).await {
                Ok(_) => {
                    failing_since = None;
                    // A core that comes back and goes again sends `CoreLost` again; the talker
                    // takes the first only (B4 review I2), so the fault sentence never restarts.
                    lost = false;
                    if let Some(t) = taken {
                        let _ = t.send(());
                    }
                    break;
                }
                Err(e) if !e.retryable() => {
                    warn!(error = %e, "the core refused an event; it is dropped");
                    break;
                }
                Err(e) => {
                    let since = *failing_since.get_or_insert_with(Instant::now);
                    if !lost && since.elapsed() >= CORE_LOST_AFTER {
                        lost = true;
                        warn!(error = %e, "the core is unreachable");
                        let live: Vec<mpsc::Sender<ToCall>> =
                            calls.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
                        for tx in live {
                            let _ = tx.send(ToCall::CoreLost).await;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }
}

async fn forward_ari(ari: Arc<Ari>, calls: Registry) {
    loop {
        match ari.events().await {
            Ok(mut events) => {
                info!("connected to Asterisk's events");
                while let Some(Ok(message)) = events.next().await {
                    let Message::Text(t) = message else { continue };
                    let event = ari::parse_event(&t);
                    let channel = match &event {
                        AriEvent::Ringing { channel }
                        | AriEvent::Answered { channel, .. }
                        | AriEvent::Dtmf { channel, .. }
                        | AriEvent::Gone { channel, .. } => channel.clone(),
                        AriEvent::Other => continue,
                    };
                    if let AriEvent::Answered { inbound: true, .. } = event {
                        info!("an inbound call reached the bridge; refused until duty mode exists");
                        let _ = ari.refuse(&channel).await;
                        continue;
                    }
                    let tx = calls.lock().ok().and_then(|m| m.get(&channel).cloned());
                    if let Some(tx) = tx {
                        let _ = tx.send(ToCall::Ari(event)).await;
                    }
                }
                warn!("Asterisk's events closed");
            }
            Err(e) => warn!(error = %e, "Asterisk's events are unreachable"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
```

In `main.rs` add the `run` command (and `use jeeta_voice_bridge::run_loop;`):

```rust
        "run" => runtime.block_on(run_command()),
```

```rust
async fn run_command() -> ExitCode {
    let config = match Config::from_env(|k| std::env::var(k).ok(), true) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = stop_tx.send(true);
    });
    run_loop::run(config, stop_rx).await;
    ExitCode::SUCCESS
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
```

- [ ] **Step 3: Run and commit**

Run: `cargo test -p jeeta-voice-bridge` and `cargo clippy -p jeeta-voice-bridge --all-targets -- -D warnings`
Expected: `run_loop` 1 passed (about 2 s); `logging` now finds log calls in `run_loop.rs` and passes; every other test passes.

```bash
git add rust/bridge/voice
git commit -m "feat(voice-bridge): the line's run loop: heartbeat, command poll, Asterisk events, ordered reports" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task D3: Build artifacts and the worker's unit; the worker serves staging

**Files:**
- Modify: `.github/workflows/rust.yml` (jobs `voice-speech` and `voice-bridge-linux`)
- Create: `rust/bridge/voice/deploy/jeeta-voice-bridge.service`, `bridge.env.example`, `images.env.example`

- [ ] **Step 1: Add the CI jobs**

Append to `.github/workflows/rust.yml` under `jobs:`:

```yaml
  # The voice bridge's Python speech services: unit tests without the models (plan V1-T3 B2/B3).
  voice-speech:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: rust/bridge/voice
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: python -m pip install pytest==8.4.2 numpy==2.5.4 websockets==17.3
      - run: python -m pytest -c speech/pytest.ini -m "not models" asterisk speech

  # The voice bridge's Linux binary, for the host beside jeeta.service (plan V1-T3 D3). Build only.
  voice-bridge-linux:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: rust
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@1.96.0
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: rust
          key: voice-bridge
      - run: cargo build --locked --release -p jeeta-voice-bridge
      - uses: actions/upload-artifact@v4
        with:
          name: jeeta-voice-bridge-linux-${{ github.sha }}
          path: rust/target/release/jeeta-voice-bridge
          if-no-files-found: error
          retention-days: 14
```

- [ ] **Step 2: Write the unit and the examples**

`rust/bridge/voice/deploy/jeeta-voice-bridge.service`:

```ini
[Unit]
Description=Jeeta voice bridge (the talker beside Asterisk)
After=network-online.target jeeta-asterisk.service jeeta-voice-listen.service jeeta-voice-speak.service
Wants=network-online.target jeeta-asterisk.service jeeta-voice-listen.service jeeta-voice-speak.service

[Service]
Type=simple
User=jeeta-voice-bridge
Group=jeeta-voice-bridge
SupplementaryGroups=jeeta-voice
WorkingDirectory=/var/lib/jeeta-voice
EnvironmentFile=/etc/jeeta-voice/ari.env
EnvironmentFile=/etc/jeeta-voice/bridge.env
ExecStart=/opt/jeeta-voice/current/jeeta-voice-bridge run
Restart=on-failure
RestartSec=2s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/jeeta-voice
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CPUWeight=200
MemoryMax=256M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`rust/bridge/voice/deploy/bridge.env.example` (copied to `/etc/jeeta-voice/bridge.staging.env` and `bridge.prod.env`, 0600 root):

```ini
# The Jeeta this bridge serves, on loopback: 8091 staging, 8090 prod. One environment at a time.
JEETA_BASE_URL=http://127.0.0.1:8091
# The calls.bridge key of that environment's workspace (shown once when issued).
JEETA_BRIDGE_KEY=
VOICE_EXTENSION=102
ARI_URL=http://127.0.0.1:8188
ARI_USER=jeeta-voice
LISTEN_SOCKET=unix:/run/jeeta-voice/listen/listen.sock
SPEAK_SOCKET=unix:/run/jeeta-voice/speak.sock
VOICE_CACHE_DIR=/var/lib/jeeta-voice/cache
VOICE_TRACE_FILE=/var/lib/jeeta-voice/traces.jsonl
JEETA_VOICE_BRIDGE_LOG=info
```

`rust/bridge/voice/deploy/images.env.example`:

```ini
LISTEN_IMAGE=jeeta-voice-listen:<tag recorded in B3>
SPEAK_IMAGE=jeeta-voice-speak:<tag recorded in B2>
```

(this example's angle brackets are the two tags the B2/B3 server steps already appended to the real `/etc/jeeta-voice/images.env`; the file is documentation of its shape.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rust.yml rust/bridge/voice/deploy
git commit -m "ci(voice): speech unit tests and the voice bridge's Linux artifact; its systemd unit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: [COORDINATOR, server] Serve staging**

Preconditions: staging runs the Phase C release (E1 Step 2). In the staging panel, as the owner of the test workspace (proposed "Test Atölye"; never "Jeeta Demo", the Meta reviewers' workspace), issue a key: **API anahtarları** → new key, name "voice bridge 102", the one scope **Ses köprüsü olarak çalışma** (`calls.bridge`); copy the plaintext once. On the host:

```bash
umask 077
install -m 0600 /root/jeeta-voice-src/rust/bridge/voice/deploy/bridge.env.example /etc/jeeta-voice/bridge.staging.env
read -r -s KEY; sed -i "s|^JEETA_BRIDGE_KEY=.*|JEETA_BRIDGE_KEY=$KEY|" /etc/jeeta-voice/bridge.staging.env; unset KEY
ln -sfn /etc/jeeta-voice/bridge.staging.env /etc/jeeta-voice/bridge.env
gh run download <the push run id> -n jeeta-voice-bridge-linux-<sha> -D /tmp/jvb   # or scp the artifact from the dev machine
install -d /opt/jeeta-voice/releases/<sha8>
install -m 0755 /tmp/jvb/jeeta-voice-bridge /opt/jeeta-voice/releases/<sha8>/jeeta-voice-bridge && rm -rf /tmp/jvb
ln -sfn /opt/jeeta-voice/releases/<sha8> /opt/jeeta-voice/current
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-bridge.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/jeeta-voice-bridge.service
systemctl daemon-reload && systemctl enable --now jeeta-voice-bridge
sleep 20; journalctl -u jeeta-voice-bridge -n 20 --no-pager
```

(`<sha8>` and the run id are the reviewed commit's; nothing else is substituted.) Expected journal lines: `the line is up`, `registered with the core status=Verified`, `connected to Asterisk's events`; no number, no word. In the staging panel, **Kabiliyetler** shows "Voice bridge 102" verified with engines `seda`/`ema`, version `0.1.0`, `max_calls` 1.

## Phase E — release and acceptance

### Task E1: [OWNER OK] Release the core changes (staging, then prod)

- [ ] **Step 1: [COORDINATOR] Push and read CI** (with the owner's OK for this branch): `git push -u origin feat/voice-bridge-v1-t3`, open the PR into the release line the owner names, and wait for `Rust` to be green: `rust-test`, `release-artifact`, `voice-speech`, `voice-bridge-linux`, `device-bridge-windows`, the panel job.

- [ ] **Step 2: [COORDINATOR, server] Staging first**

```bash
STAMP=$(date +%Y%m%d%H%M)
sudo -u postgres pg_dump -p 5437 -Fc jeeta > /var/backups/jeeta-staging/pre-<sha8>-$STAMP.dump
ls -l /var/backups/jeeta-staging/pre-<sha8>-$STAMP.dump
/root/staging-upgrade.sh /root/jeeta-release-<sha8>.tar
curl -fsS http://127.0.0.1:8091/readyz
journalctl -u jeeta-staging --since "-5 min" -p warning --no-pager | head
```

Expected: a non-empty dump; `readyz` 200; no WARN/ERROR. No migration is applied (this plan adds none). The Meta reviewer workspace is untouched.

- [ ] **Step 3: [OWNER OK] Prod after the e2e (E3) passed**: `/root/upgrade.sh /root/jeeta-release-<sha8>.tar` (it backs up, checks compatibility, swaps, checks `readyz`), then `curl -fsS http://127.0.0.1:8090/readyz`. Only then may the bridge be pointed at prod (E2).

The release contains Phase C through C3 at least (see C3: no release between A5 and C3).

- [ ] **Step 4: [COORDINATOR, server] Rollback to 047da0cd (only if needed)**

1. **Stop or switch `jeeta-voice-bridge` first** (`systemctl stop jeeta-voice-bridge`, or point it at the other environment, E2). The old core reads `BridgeEvent` without `phrase` and `trace`, so it refuses the whole event batch that contains one, and with it the `hangup` and `command_done` in that batch.
2. **Remove the plans' hotwords**, which the old core's strict `CallPlan` refuses. Run as the postgres superuser, who is not subject to row-level security, against the environment's database (staging: `sudo -u postgres psql -p 5437 -d jeeta`; prod: its own cluster). Both statements are idempotent:

   ```sql
   update call_sessions set data = data #- '{plan,hotwords}' where data->'plan' ? 'hotwords';
   update call_commands set payload = payload #- '{plan,hotwords}' where kind = 'dial' and payload->'plan' ? 'hotwords';
   ```

   A plan without hotwords is written without the key (A5 review), so only plans that carried some are touched. Everything else A5–C3 added reads in the old core: `CallSession.phrases`, `CallMetrics.{traces, agent_replies}`, the dial's `script` and `CallPolicy`'s new fields are not refused by types without `deny_unknown_fields`.
3. Then run the old release's `upgrade.sh` / `staging-upgrade.sh` with the old tarball.

**Known loss.** If the old core re-saves the call policy (a `calls.policy_set`, or a panel save), it drops `phrases` and C1's `opening_outbound`, `transcript_notice` and `closing`. After rolling forward again they read as their defaults (the approved set and templates), not as what the owner had written. Re-enter them in the panel after a roll-forward, or export `workspace_policies.calls` before rolling back.

### Task E2: One extension, one environment: the switch

**Files:**
- Create: `rust/bridge/voice/deploy/jeeta-voice-target`
- Create: `rust/bridge/voice/asterisk/test_target.py`

- [ ] **Step 1: Write the failing test**

`rust/bridge/voice/asterisk/test_target.py`:

```python
"""jeeta-voice-target refuses an unknown target and never switches while a call is on the line."""
import os
import pathlib
import subprocess
import sys

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "jeeta-voice-target"

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell script")


def run(*args, env=None):
    return subprocess.run(["sh", str(SCRIPT), *args], capture_output=True, text=True, env=env)


def test_an_unknown_target_is_refused():
    out = run("qa")
    assert out.returncode == 2 and "usage" in out.stderr


def test_a_live_call_blocks_the_switch(tmp_path):
    (tmp_path / "bridge.staging.env").write_text("JEETA_BASE_URL=http://127.0.0.1:8091\n")
    (tmp_path / "ari.env").write_text("ARI_PASSWORD=x\n")
    fake = tmp_path / "curl"
    fake.write_text('#!/bin/sh\necho \'[{"id":"c-1"}]\'\n')
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "JEETA_VOICE_ETC": str(tmp_path)}
    out = run("staging", env=env)
    assert out.returncode == 1 and "a call is on the line" in out.stderr
    assert not (tmp_path / "bridge.env").exists()
```

Run: `python -m pytest -c speech/pytest.ini asterisk/test_target.py` (Linux or macOS)
Expected: FAIL (`jeeta-voice-target` missing).

- [ ] **Step 2: Write the script**

`rust/bridge/voice/deploy/jeeta-voice-target` (installed as `/usr/local/sbin/jeeta-voice-target`, 0755):

```sh
#!/bin/sh
# jeeta-voice-target staging|prod: points the voice bridge at one Jeeta. Extension 102 registers once,
# so one environment at a time; the one left behind sees its bridge go stale (agent calls refused
# bridge_offline). Never switches while Asterisk carries a channel.
set -eu
etc="${JEETA_VOICE_ETC:-/etc/jeeta-voice}"
target="${1:-}"
case "$target" in
  staging|prod) ;;
  *) echo "usage: jeeta-voice-target staging|prod" >&2; exit 2 ;;
esac
env_file="$etc/bridge.$target.env"
[ -f "$env_file" ] || { echo "$env_file is missing" >&2; exit 2; }
. "$etc/ari.env"
channels=$(printf 'user = "jeeta-voice:%s"\n' "$ARI_PASSWORD" | curl -fsS -K - http://127.0.0.1:8188/ari/channels)
if [ "$channels" != "[]" ]; then
  echo "a call is on the line; switch when it ends" >&2
  exit 1
fi
ln -sfn "$env_file" "$etc/bridge.env"
if [ -z "${JEETA_VOICE_ETC:-}" ]; then
  systemctl restart jeeta-voice-bridge
fi
echo "the voice bridge now serves $target"
```

Run: `python -m pytest -c speech/pytest.ini asterisk/test_target.py`
Expected: `2 passed`.

- [ ] **Step 3: Commit and install**

```bash
git add rust/bridge/voice/deploy/jeeta-voice-target rust/bridge/voice/asterisk/test_target.py
git commit -m "feat(voice): switch the one extension between staging and prod, never mid-call" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

[COORDINATOR, server]: `install -m 0755 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-target /usr/local/sbin/`; prod gets its own `bridge.prod.env` (`JEETA_BASE_URL=http://127.0.0.1:8090`, the prod workspace's own `calls.bridge` key, issued the same way) only after E1 Step 3.

### Task E3: [OWNER] End-to-end acceptance: an agent calls the owner

Needs the owner's mobile, about 8 minutes of package (two calls), staging on the Phase C release, the worker serving staging (D3 Step 4).

- [ ] **Step 1: [COORDINATOR] Preconditions in the staging workspace**

1. `jeeta-voice-bridge check` (as in B7 Step 1) prints three `ok`.
2. The workspace has an approved strategy; **Ayarlar → Aramalar** shows the opening "Merhaba, ben Test Atölye'nin dijital asistanıyım.", the notice and the approved phrases (the owner reads and saves them).
3. A person "Kabul testi" with the owner's mobile as phone identity, and an explicit phone consent recorded with the owner's verbal OK (`jeeta.inbox.consent_record`, channel phone, kind explicit, source manual). `estimated_minor_per_minute` stays 0 (no spend).
4. An agent session (the coordinator's Claude Code, its model and reasoning as they are, owner decision V-2) connected to staging's MCP with a key holding `calls.work` and inbox read scopes.
5. Note the start time: `START=$(date -u +%Y-%m-%dT%H:%M:%SZ)`.

- [ ] **Step 2: [OWNER + agent] The call**

The agent places it:

```json
{ "person_id": "<the test person's id>", "purpose": "commercial", "mode": "agent",
  "plan": { "opening": "Sesim net geliyor mu?", "goal": "Ses köprüsü kabul testi",
            "holding": ["Bir saniye."], "fallback": ["Bağlantıda bir gecikme var, sizi birazdan geri arayacağız."],
            "closing": "Görüşmek üzere, iyi günler.", "max_duration_s": 300,
            "hotwords": ["Jeeta", "Test Atölye"] } }
```

Then, turn by turn (the owner improvises within this outline):

1. Owner answers. Expected: the workspace opening starts at once (the worker logs `first audio after the answer ms=…`), then the notice, then "Sesim net geliyor mu?". Owner: "Evet, net geliyor."
2. Agent: `jeeta.calls.say{ text: "Kısa bir deneme için arıyorum.", wait_reply_s: 20 }` then `jeeta.calls.say{ text: "Yarınki randevunuza bakmamı ister misiniz?", wait_reply_s: 20 }`. Owner: "Evet, bakar mısınız?"
3. **Filler during a tool call:** the agent calls an inbox tool (e.g. `jeeta.inbox.people_get` for the test person) before answering. Expected: "Hı hı." about 0.6 s after the owner stopped, "Bir saniye, hemen bakıyorum." about 2.7 s after, then the agent's answer.
4. **Barge-in:** the agent says three sentences in one `say` ("Yarın saat on dörtte bir randevunuz görünüyor. Adresimiz değişmedi. Gelirken kimliğinizi getirmeyi unutmayın."); the owner cuts in during the second sentence ("Tamam, anladım."). Expected: the agent's voice stops at once; the turn shows `interrupted_at_char` within the second sentence.
5. **Closing:** the agent calls `jeeta.calls.end{ outcome: "connected", summary: "Kabul testi" }`. Expected: "Görüşmek üzere, iyi günler." then the line closes.

A second, shorter call (steps 1, 2 and 5) adds turns to the percentiles.

- [ ] **Step 3: [COORDINATOR] Measure and report**

```bash
sudo -u jeeta-voice-bridge VOICE_TRACE_FILE=/var/lib/jeeta-voice/traces.jsonl \
  /opt/jeeta-voice/current/jeeta-voice-bridge report --since "$START"
journalctl -u jeeta-voice-bridge --since "$START" --no-pager | grep -o 'first audio after the answer ms=[0-9]*'
journalctl -u jeeta-voice-bridge -u jeeta-voice-listen -u jeeta-voice-speak -u jeeta-asterisk --since "$START" --no-pager \
  | grep -cE '\+90[0-9]{10}|0[5][0-9]{9}' || true
```

and `jeeta.calls.get` of each call (its `call.latency` and turns). Record in the PR and `docs/operations/voice-bridge.md` §Measured:

| Measure | Gate |
|---|---|
| Two-way audio, opening, notice, name question heard | must |
| First audio after the answer | ≤ 300 ms (worker log) |
| Perceived p95 (`latency.perceived.p95`) | ≤ 1 000 ms (report threshold) |
| Filler heard during the tool call; `phrase` turns in the log | must |
| Barge-in: playback stopped, `interrupted_at_char` set | must; `barge_in_stop` p95 reported against the 300 ms target |
| Transport overhead: `latency.transport.p95` (the larger of the two calls'; below) | ≤ 100 ms (push-like long-poll proven); `latency.transport.n` ≥ 2 on the first call, or the measurement failed |
| Content p95 | reported (brain-dominated; the 3 s alert is expected with the unchanged agent) |
| Closing heard, line closed, session `agent_ended`, journey `CallMade{connected}` | must |
| Numbers in the four units' journals | 0 |

The transport overhead is `latency.transport`, which the core works out per turn (design addendum §4): for each caller turn, the trace's `core_round_ms` (`say_ms − delivered_ms` on the worker's clock: the core answered the utterance → the reply's first sentence reached the bridge) less the core's own latency for the agent `say` the trace names (`reply_seq`; on the core's clock: the wait that sentence ended → the `say` committed), saturating at 0. The two are matched by that `seq`, never by position: the core records a latency whenever it was waiting for the agent (a key press, a fallback line, a sentence after one that expected no reply), while the bridge reports a trace per final transcript, including a last turn nobody answered, so the counts differ in E3's own script (for example 3 traces against 2 latencies). The gate is the larger of the two calls' `latency.transport.p95`; record each call's `latency.transport.n` too. An `n` of 0 on a call that had replies means its traces carried no `reply_seq`: a bridge bug, not a pass. One caveat: a reply that follows a fallback line has its agent latency counted from the fallback, so for that turn the figure overstates the hop; E3's script plays no fallback.

If a "must" fails, stop, file the finding, do not point the bridge at prod.

### Task E4: The operations page for the new stack

**Files:**
- Modify: `docs/operations/voice-bridge.md`

- [ ] **Step 1: Rewrite sections 1, 5 and add 6–8**

Keep sections 2 (the key), 3 (protocol) and 4 (heartbeat) and add to §3 the additions of Task A5 (`dial.script`, `phrase`, `trace`) and C4 (`calls.say{wait_reply_s}`). Replace §1 (Gate V1) with its outcome:

```markdown
## 1. Gate V1 (done, 2026-10-28/29)

Extension 102 ("jeetases", UDP, register only from this host, Dahili-Şehiriçi-GSM, recording off)
registers with `sip5.netsantral.com` as `102-8508407303` (realm `asterisk`). Outbound 102 → mobile
works with two-way G.711. Inbound 0850 → 102 did not reach the UA (see §8). Extension 101 stays
WSS-only for the v1 webphone. The Eko package has one external line: one call at a time.
```

Replace §5 (host setup) with the stack as installed by tasks B1–B3 and D3:

```markdown
## 5. Host setup

| Unit | What | Listens |
|---|---|---|
| `jeeta-asterisk` | Asterisk 22.11 in Docker (`--network host`, uid 1500) | SIP UDP 5070 (all addresses), RTP 40000–40099, ARI/HTTP 127.0.0.1:8188 |
| `jeeta-voice-listen` | Silero VAD, Smart Turn v3.2, seda-v0.1 (`--network none`, uid 1501) | `/run/jeeta-voice/listen/listen.sock` (its own directory, 0710) |
| `jeeta-voice-speak` | Antalia normaliser + EMA Lightning 1.1.2 (`--network none`, uid 1502 in gid 1501) | `/run/jeeta-voice/speak.sock` |
| `jeeta-voice-bridge` | the talker (`/opt/jeeta-voice/current`), loopback only | nothing |

Files: `/etc/jeeta-voice/asterisk/` (configuration; `secrets/` 0700 uid 1500 holds `pjsip_auth.conf`
and `ari_users.conf`, 0600), `/etc/jeeta-voice/ari.env` (0600), `/etc/jeeta-voice/bridge.{staging,prod}.env`
(0600) and the `bridge.env` symlink choosing one, `/etc/jeeta-voice/images.env` (the speech images'
tags), `/var/lib/jeeta-voice/cache` (synthesised policy sentences only) and `traces.jsonl` (numbers
only). No secret is in the repository, a command line or a log. Firewall: default-deny incoming is
required (B1 Step 7). There is no inbound rule: the PBX's replies are admitted by conntrack (Gate
V1), and RTP's too, because the worker's pacer sends a frame every 20 ms from the media's start.
If audio is one-way, allow UDP 40000–40099 from NetGSM's media network, confirmed on a call (B1
Step 10). When `pjsip show registrations` reads `Rejected` for more than two minutes, alert, fix
the cause and run `systemctl restart jeeta-asterisk` (`pjsip.conf` says what stops it for good).

Switch environments with `jeeta-voice-target staging|prod` (refuses while a call is on the line).
Check the stack with `jeeta-voice-bridge check`; read latency with `jeeta-voice-bridge report --since <RFC 3339>`.
```

Add:

```markdown
## 6. What the caller hears

On the answer: the workspace's opening ("Merhaba, ben {İşletme}'nın dijital asistanıyım."), the
transcript notice, the agent's own opening. While the agent thinks: "Hı hı." / "Anladım." / "Tamam." /
"Peki." at about 0.6 s, a filler at about 2.7 s, the long wait at about 8 s; "Hâlâ orada mısınız?"
after 9 s of silence following the agent's sentence; "Sizi tam duyamadım…" when no words were
recognised; the fault sentence if the core is lost. All are the call policy's text (Ayarlar →
Aramalar), owner-approved on 2026-10-29. The caller can cut the agent by speaking.

## 7. Measured (fill from tasks B7 and E3)

| Date | Calls | Turns | First audio after answer | Perceived p50/p95 | Content p50/p95 | Agent p50/p95 | Barge-in stop p50/p95 | Notes |
|---|---|---|---|---|---|---|---|---|

## 8. Inbound

Asterisk sends every inbound call to the bridge's application, which refuses it (busy) until duty
mode (plan V2-T1) exists. Result of the 0850 → 102 investigation (task B8): record it here.
```

The measured table's rows are filled with the numbers B7 and E3 produced (not before).

- [ ] **Step 2: Commit**

```bash
git add docs/operations/voice-bridge.md
git commit -m "docs(voice): the free-path voice stack on the host, what the caller hears, measured latency" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**1. Spec coverage** (the binding decisions and the job's requirements → tasks):

| Requirement | Task |
|---|---|
| Free, self-hosted, existing Contabo VPS, no new server/GPU/cloud speech | B1–B3 (Docker on the host, `--network none`), constraint 1 |
| Asterisk 22.8+ chan_websocket, ext 102 over UDP, secret in a 0600 file under `/etc/jeeta*` | B1 (22.11.0, `secrets/pjsip_auth.conf` 0600 from `/root/voicegate/p102`) |
| Asterisk owns SIP/RTP/jitter/DTMF; 20 ms G.711; FLUSH_MEDIA / MARK_MEDIA | B1 config, B5 `media.rs`, B6 `call.rs` (`MARK_MEDIA` per sentence, `FLUSH_MEDIA` on cut) |
| Outbound works; inbound investigated, non-blocking; one call at a time | B7, B8, `max_calls: 1` and the busy refusal in D2 |
| Rust audio worker in `rust/bridge/voice/` (name checked: `jeeta-voice-bridge`, no clash) | B4–B6, D1–D2 |
| Speaks the V1-T1/T2 protocol exactly; wire types found and quoted | §4 (quoted), A1 (`jt_calls::wire` shared), D1 |
| Per-call state machine: opening, turns, barge-in, fillers, closing | B4 `talker.rs`, B6 `call.rs` |
| Never logs numbers, audio or transcript text | lib.rs rule, B4 `tests/logging.rs`, `Heard`'s redacting `Debug`, E3 journal check |
| seda-v0.1 on sherpa-onnx, Silero VAD 8 kHz, Smart Turn v3.2, fallback 1.2–1.8 s, per-call hotwords | B3 (fallback 1.5 s, `hotwords.py`), A5/C2 (`plan.hotwords` → `script.hotwords`) |
| EMA Lightning 1.1.2, 8 kHz, fixed seed, Antalia normaliser (not normalizer-tr), respelling, sentence by sentence, warm process, isolated service with local API | B2, B6 (`text::sentences`, one synthesis per sentence) |
| Pre-synthesised, cached openings per workspace; genitive suffix pure and tested; disclosure mandatory | A3 (genitive with its front-suffix table; `CLOSING`), C1 (`with_workspace`, spoken-opening disclosure check, the policy's closing as the plan's default), B6 (disk cache for policy sentences, pre-synthesis during ringing) |
| The owner-approved phrase set, played by the bridge, never composed | A4, A5 (core logs the text dialled with the call, `CallSession.phrases`), B4 talker, C3 (an owner's edit mid-call changes nothing logged), C5 panel |
| No raw audio storage; recording off | constraint 5, cache rule (policy sentences only), B8 shreds nothing needed (no recordings), addendum §5 |
| Brain unchanged; say+listen merge backward compatible; one sentence per `say`; `say` returns when queued | C4 (`wait_reply_s` optional; descriptions; no model advice anywhere) |
| Push transport proven or kept | addendum §4, existing `utterance_wakes_listen_immediately`, D2 (one poll always outstanding, events posted at once), E3 transport-overhead gate |
| Per-turn monotonic trace and p50/p95 with the report's thresholds | A2, B5 `trace.rs`, B6 marks, C3 view, C5 panel, `report` command |
| Thin vertical slice before polishing | B6 `slice`, B7 |
| Hexagonal boundaries; catalog/exact-set/status tests; migrations; TR+EN; jt_pg tests Linux only; no deploy from workers; upgrade.sh with pg_dump first | B4 archtest + deny; constraint 7 (no row added, count 160 stays); constraint 8 (no migration needed); C5 copy; §2; constraint 10; E1 |
| Contabo deploy: install, configs, secrets, systemd, staging vs prod, firewall/RTP, pinned images | B1–B3, D3, E2 |
| E2E acceptance with measured latency | E3 |
| Owner-needed tasks marked; ~95 min package | §3, B7, B8, E1, E3 |

No gap found. Deliberately not in this plan: inbound duty mode (V2-T1), a digit-dictation endpoint mode, seda fine-tuning and a brand voice (report steps 6–7), WebSocket push (only if E3's transport gate fails).

**2. Placeholder scan.** Searched for "TBD", "TODO", "implement later", "fill in", "similar to", "handle edge cases". The angle-bracket items that remain are run-time values a coordinator reads off the environment (the commit sha, a CI run id, the test person's id, the image tags B2/B3 record), each with the command that produces it; `images.env.example` says so. The measured table in E4 is filled from B7/E3 output by design.

**3. Type consistency.** `DialScript { lines, phrases, hotwords }` (A5) is what C2 fills, B6/D2 read and the slice builds. `BridgeEvent::Phrase { set, index }` and `BridgeEvent::Trace { trace }` (A5) are what `call.rs` reports and C3 tests. `TurnTrace` fields (A2) match `TurnMarks::trace` (B5), the C3 test JSON and the C5 types (`perceived`, `content`, `agent`, `barge_in_stop`, `alerts`). `Talker::on(Input, Ms) -> Vec<Action>` (B4) is what `Live::input` calls. `Report { bridge_call_id, event, taken }` is shared by `call.rs`, `slice.rs` and `run_loop.rs`. `CallPolicy::{with_workspace, opening_lines, spoken_opening}` (C1) are what C2 uses. `CallSession.phrases` (A5) is set from `script.phrases` in the dialling transaction (A5, C2) and read by the reducer (A5) and C3's test. `TurnTrace.reply_seq` (A2, set by B5/B6 from the `Say` it timed) is matched by `summarize` against `CallMetrics.agent_replies` (`AgentReply { seq, latency_ms }`, A2 type, A5 recording) to give `latency.transport` (C3, read by E3). `jt_calls::CLOSING` (A3) is the policy's default closing (C1), the slice's closing (B6) and what C5's panel shows. `SayInput.wait_reply_s` / `SayOut.{events, timed_out}` (C4) match the MCP schema and tests. `Ari::with_ws_base` (B6 Step 1) is used by the test support only.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-29-voice-sidecar-free-path-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. Server and owner steps ([COORDINATOR], [OWNER]) stay with the coordinator.

**2. Inline Execution** — execute tasks in one session using superpowers:executing-plans, batch execution with checkpoints.

Which approach?
