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
- Speech services: `speech/listen/{jeeta_listen.py,endpoint.py,vad.py,turn.py,asr.py,hotwords.py,requirements.txt,models.lock,fetch_models.py,Dockerfile}`, `speech/listen/tests/{test_endpoint.py,test_hotwords.py,test_session.py,test_models.py}`; `speech/speak/{jeeta_speak.py,respell.py,respell.json,requirements.txt,Dockerfile}`, `speech/speak/tests/{test_respell.py,test_session.py,test_models.py}`; `speech/pytest.ini`.
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
- Create: `rust/bridge/voice/asterisk/etc/{asterisk.conf,modules.conf,logger.conf,cdr.conf,cel.conf,pjsip.conf,extensions.conf,http.conf,ari.conf,rtp.conf,manager.conf}`
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
# The modules the bridge cannot work without (B1 review); the Dockerfile checks each is built.
REQUIRED_MODULES = [
    "chan_websocket", "chan_pjsip", "res_pjsip", "res_pjsip_session", "res_pjsip_sdp_rtp",
    "res_pjsip_outbound_registration", "res_pjsip_outbound_authenticator_digest",
    "res_pjsip_endpoint_identifier_ip", "res_rtp_asterisk", "res_http_websocket",
    "res_websocket_client", "res_ari", "res_ari_asterisk", "res_ari_channels", "res_ari_bridges",
    "res_ari_events", "res_stasis", "app_stasis", "bridge_simple", "bridge_softmix",
    "res_timing_timerfd", "codec_alaw", "codec_ulaw",
]


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

- [ ] **Step 4: Run the config test**

Run: `python -I -m pytest -c speech/pytest.ini asterisk`
Expected: `12 passed` (9 config, 3 probe). The probe module must exist for this run, so write `sip_probe.py` (Step 5) before it.

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
# After the first good build, pin both base images by digest (debian:bookworm-slim@sha256:...).
FROM debian:bookworm-slim AS build
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

FROM debian:bookworm-slim
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
      bridge_simple bridge_softmix res_timing_timerfd codec_alaw codec_ulaw; do \
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
command -v docker docker-init python3
```

Expected:
- The gate prints `FIREWALL OK`. **If it prints `STOP: no default-deny firewall`, stop B1.** Do not open 5070 or the RTP range to make it pass: the design relies on conntrack for SIP and RTP.
- `no rule opens 5070 or 40000-40099`.
- `no Gate V1 rig running`. A baresip still registered as 102 would fight the registration. Gate V1's baresip listened on 5062. If one is listed, stop it with `docker rm -f <name>`.
- 5070/udp, the RTP range and 8188/tcp are free. Asterisk owns the RTP range on the host network.
- `ip_local_reserved_ports` is empty; Step 8 sets it.
- uid/gid 1500 and 1501 are unused. If one is taken, change the uid in the Dockerfile, in the units and in every `1500`/`1501` below together.
- `/usr/bin/docker` (the unit's path), `docker-init` (`--init`) and `python3` (Step 9's probe) all exist.

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
for m in chan_websocket chan_pjsip res_pjsip res_pjsip_session res_pjsip_sdp_rtp res_pjsip_outbound_registration res_pjsip_outbound_authenticator_digest res_pjsip_endpoint_identifier_ip res_rtp_asterisk res_http_websocket res_websocket_client res_ari res_ari_asterisk res_ari_channels res_ari_bridges res_ari_events res_stasis app_stasis bridge_simple bridge_softmix res_timing_timerfd codec_alaw codec_ulaw; do
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
  - Record `time` and the digest printed before the build. Pin both `FROM` lines to it (`debian:bookworm-slim@sha256:…`) in a follow-up commit.
  - `nice` is not used: the build's processes run under dockerd. The throttle is `MAKE_JOBS=2`; override it with `--build-arg MAKE_JOBS=…`.
- **`docker ps`** shows `Up … (healthy)` once the 30 s start period is over. The `HEALTHCHECK` is `asterisk -rx 'core waitfullybooted'`.
- **The registration** line shows `netgsm-reg/sip:sip5.netsantral.com` and `Registered`.
- **`pjsip show identifies`** lists `netgsm` with the match `185.88.7.227/32`. The hostname and the literal resolve to the same address today.
- **Modules:** no `NOT RUNNING` line. The three counts list `ari`, `stasis` and `pjsip` modules.
- **Sockets:** UDP `0.0.0.0:5070` and TCP `127.0.0.1:8188`, nothing else. RTP ports open only during a call.
- **`docker stats`:** pids well under 256 (about 60–150 expected), mem under 512 MiB. Report pids if they come near 200.
- **ARI** answers JSON starting `{"build":`.
- **The journal** holds only warnings and errors. Modules without a config of their own may warn once at start.
- **The probe from the host** prints `SIP/2.0 401 Unauthorized` for each of `netgsm`, `102-8508407303` and `probe`.
  - Under the old default (`identify_by=username,ip`), `From: netgsm` would have been taken as the endpoint unchallenged, answered 200 or 404.
  - Run the probe again after any change to `pjsip.conf` (`pjsip reload` or a restart).
- **The probe from outside** prints `no answer`: ufw drops unsolicited SIP.
- **NetGSM's answer** decides `qualify_frequency`. In 22.11 a qualify counts any reply as `Avail`, 401 included; only silence makes the contact `Unavail`, and the dial (`PJSIP/<n>@netgsm`) uses only a reachable contact.
  - `SIP/2.0 200 OK`: keep `qualify_frequency=20`. The keep-alive refreshes the conntrack entry every 20 s.
  - `401`/`407`: start at `qualify_frequency=0`. Each qualify would cost NetGSM a challenge and an authenticated OPTIONS. Without it, the REGISTER refresh (every ~110 s) and NetGSM's own OPTIONS keep the entry.
  - `no answer`: `qualify_frequency=0`. An `Unavail` contact would block every dial.
  - To change it: `sed -i 's/^qualify_frequency=20$/qualify_frequency=0/' /etc/jeeta-voice/asterisk/pjsip.conf && docker exec jeeta-asterisk asterisk -rx 'pjsip reload'`. Then `pjsip show contacts` reads `Unknown`, which is dialable. Report the result so the repository follows.

If the registration reads `Rejected`, check the secret file without printing it, and check that no other UA registers 102. If it reads `No Response`, check `ufw` outbound and DNS. A lasting `Rejected` is the alert of `docs/operations/voice-bridge.md` §6.

- [ ] **Step 10: [COORDINATOR, server] One-way audio fallback (only if B7 shows it)**

```bash
ufw allow proto udp from 185.88.7.0/24 to any port 40000:40099 comment 'jeeta-voice RTP from NetGSM'
```

Not applied by default. Since 22.9.0, chan_websocket generates no silence ("chan_websocket: Remove silence generation and frame padding", ChangeLog-22.9.0), and `transmit_silence` covers only waits, not a bridged channel. The worker's pacer (B5, B6) therefore writes one frame every 20 ms from `MEDIA_START`, silence when nothing plays. So RTP leaves as soon as the media is up, and conntrack admits NetGSM's replies, as in Gate V1.

Apply this rule only if B7 still shows one-way audio. First confirm NetGSM's media network during a call, for example with `conntrack -L -p udp 2>/dev/null | grep -E 'port=400[0-9]{2}'` (addresses and ports only). `185.88.7.0/24` is not verified.

- [ ] **Step 11: [COORDINATOR, server, later] After the first working boot: an explicit module list**

Not before B7 passes. `autoload = yes` loads every module that was built, which is more than the bridge uses. Once a call has worked, record what runs (names and states only), then narrow the list:

```bash
docker exec jeeta-asterisk asterisk -rx 'module show' | awk '$NF ~ /core|extended|deprecated/ && /Running/ {print $1}' | sort > /root/jeeta-asterisk-modules.txt
wc -l /root/jeeta-asterisk-modules.txt
```

Then, in a repository commit:
- `modules.conf` becomes `autoload = no`, with one `load => <module>.so` for each module the bridge needs: `REQUIRED_MODULES` of `asterisk/test_configs.py`, plus the dependencies `module show` reported (for example `res_sorcery_*`, `res_pjsip_*` helpers, `res_http_websocket`, `func_*` used by ARI).
- The config test asserts that `REQUIRED_MODULES` is a subset of the `load` list.

Deploy it with Step 8's config install. The configs are mounted, so the image is not rebuilt: run `systemctl restart jeeta-asterisk`, then Step 9's checks and one more B7-style call. Keep `autoload = yes` if anything is missing.

### Task B2: The speak service (EMA Lightning behind Antalia's normaliser)

**Files:**
- Create: `rust/bridge/voice/speech/speak/respell.py`
- Create: `rust/bridge/voice/speech/speak/respell.json`
- Create: `rust/bridge/voice/speech/speak/jeeta_speak.py`
- Create: `rust/bridge/voice/speech/speak/requirements.txt`
- Create: `rust/bridge/voice/speech/speak/constraints.txt` (generated in Step 7)
- Create: `rust/bridge/voice/speech/speak/Dockerfile`
- Create: `rust/bridge/voice/speech/speak/tests/test_respell.py`
- Create: `rust/bridge/voice/speech/speak/tests/test_session.py`
- Create: `rust/bridge/voice/speech/speak/tests/test_models.py`
- Create: `rust/bridge/voice/deploy/jeeta-voice-speak.service`

- [ ] **Step 1: Write the failing tests**

`rust/bridge/voice/speech/speak/tests/test_respell.py`:

```python
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from respell import Respeller  # noqa: E402


def test_brands_are_respelled_with_their_suffixes_kept():
    r = Respeller({"Jeeta": "Cita", "WhatsApp": "vatsap"})
    assert r.apply("Jeeta'nın asistanıyım") == "Cita'nın asistanıyım"
    assert r.apply("WhatsApp'tan yazabilirsiniz") == "vatsap'tan yazabilirsiniz"
    assert r.apply("jeeta ve whatsapp") == "Cita ve vatsap"


def test_words_that_merely_contain_a_brand_are_left_alone():
    r = Respeller({"Jeeta": "Cita"})
    assert r.apply("Jeetalar") == "Jeetalar"


def test_the_shipped_table():
    table = Respeller.load(pathlib.Path(__file__).resolve().parents[1] / "respell.json")
    assert table.apply("Jeeta") == "Cita"
    assert table.apply("WhatsApp") == "vatsap"
```

`rust/bridge/voice/speech/speak/tests/test_session.py`:

```python
"""The speak protocol over a real WebSocket (TCP loopback here; a unix socket in production)."""
import asyncio
import json
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

from jeeta_speak import session  # noqa: E402


class FakeMouth:
    def __init__(self, chunks):
        self.chunk_list = chunks

    def chunks(self, text):
        for c in self.chunk_list:
            yield c


async def exchange(mouth, messages, stop_after):
    pool = ThreadPoolExecutor(max_workers=1)
    async with serve(lambda ws: session(ws, mouth, pool), "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            for m in messages:
                await ws.send(json.dumps(m))
            got = []
            while True:
                msg = await asyncio.wait_for(ws.recv(), 5)
                got.append(msg)
                if isinstance(msg, str) and json.loads(msg)["type"] in stop_after:
                    return got


def test_synth_streams_pcm_then_done():
    mouth = FakeMouth([b"\x01\x00" * 800, b"\x02\x00" * 800])
    got = asyncio.run(exchange(mouth, [{"type": "synth", "id": "a:0", "text": "Merhaba."}], {"done"}))
    assert got[0] == b"\x01\x00" * 800 and got[1] == b"\x02\x00" * 800
    done = json.loads(got[2])
    assert done["id"] == "a:0" and done["audio_ms"] == 200


def test_a_second_synth_while_busy_is_refused():
    mouth = FakeMouth([b"\x00\x00" * 8000] * 3)
    got = asyncio.run(
        exchange(
            mouth,
            [{"type": "synth", "id": "a:0", "text": "Bir."}, {"type": "synth", "id": "a:1", "text": "İki."}],
            {"done"},
        )
    )
    texts = [json.loads(m) for m in got if isinstance(m, str)]
    assert {"type": "error", "id": "a:1", "reason": "busy"} in texts
```

`rust/bridge/voice/speech/speak/tests/test_models.py`:

```python
"""Runs inside the image on the host: `docker run --rm --network none jeeta-voice-speak:<tag> python -m pytest -m models tests`."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.models


def test_the_mouth_speaks_and_reads_times_the_way_the_owner_heard():
    from jeeta_speak import build_mouth, self_test

    mouth = build_mouth()
    self_test(mouth)
    pcm = b"".join(mouth.chunks("Merhaba, ben Jeeta'nın dijital asistanıyım."))
    assert len(pcm) // 2 > 8000  # more than a second of 8 kHz audio
```

- [ ] **Step 2: Run them to see them fail**

Run (from `rust/bridge/voice`, Python 3.12 with `pip install pytest==8.4.2 numpy==2.5.4 websockets==17.3`): `python -m pytest -c speech/pytest.ini -m "not models" speech/speak/tests`
Expected: FAIL (`ModuleNotFoundError: No module named 'respell'`).

- [ ] **Step 3: Write the service**

`rust/bridge/voice/speech/speak/respell.py`:

```python
"""Brand respelling in front of the normaliser: a written brand becomes the spelling the voice
pronounces right ("Jeeta" -> "Cita"). Whole words only, case-insensitive; a suffix after an
apostrophe stays as written. The transcript keeps the original text: this is pronunciation only."""
import json
import re


class Respeller:
    def __init__(self, table):
        items = sorted(table.items(), key=lambda kv: -len(kv[0]))
        self.patterns = [
            (re.compile(r"(?<!\w)" + re.escape(src) + r"(?!\w)", re.IGNORECASE), dst) for src, dst in items
        ]

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    def apply(self, text):
        for pattern, dst in self.patterns:
            text = pattern.sub(dst, text)
        return text
```

`rust/bridge/voice/speech/speak/respell.json`:

```json
{
  "Jeeta": "Cita",
  "WhatsApp": "vatsap"
}
```

`rust/bridge/voice/speech/speak/jeeta_speak.py`:

```python
"""jeeta-speak: the voice bridge's mouth (design addendum section 6).

A long-lived process that keeps EMA Lightning warm. It listens on a unix socket (the container runs
with --network none) and speaks one protocol, one WebSocket per call:

  client -> {"type": "synth", "id": "<id>", "text": "<one sentence>"}
  server -> binary frames: PCM16 little-endian mono 8000 Hz, in order
  server -> {"type": "done", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>}
  client -> {"type": "cancel", "id": "<id>"}   (stops between chunks; answered "cancelled")
  server -> {"type": "error", "id": "<id>", "reason": "<kind>"}

One synthesis at a time per connection. Text goes through the brand respelling table, then
Antalia-2 Mini's normaliser, then EMA. The log never carries a text.
"""
import asyncio
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from respell import Respeller

LOG = logging.getLogger("jeeta-speak")
SAMPLE_RATE = 8000


def load_normalizer():
    """Antalia-2 Mini's normaliser: `Antalia.normalize(text)` on the class when it is static,
    else on one instance (weights baked into the image)."""
    from antalia_mini import Antalia

    fn = Antalia.normalize
    try:
        fn("1")
        return fn
    except TypeError:
        return Antalia().normalize


class Mouth:
    def __init__(self, respeller, normalize, tts, seed):
        self.respeller = respeller
        self.normalize = normalize
        self.tts = tts
        self.seed = seed

    def spoken(self, text):
        return self.normalize(self.respeller.apply(text))

    def chunks(self, text):
        for chunk in self.tts.stream(self.spoken(text), sample_rate=SAMPLE_RATE, seed=self.seed):
            audio = np.asarray(chunk, dtype=np.float32).reshape(-1)
            yield (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def build_mouth():
    import torch
    from ema_lightning import EMA

    torch.set_num_threads(int(os.environ.get("SPEAK_THREADS", "2")))
    respeller = Respeller.load(os.environ.get("RESPELL_FILE", "/app/respell.json"))
    return Mouth(respeller, load_normalizer(), EMA(), int(os.environ.get("EMA_SEED", "0")))


def self_test(mouth):
    """The two readings the owner's test depended on; the process refuses to start without them."""
    if "on dörde" not in mouth.spoken("Salı saat 14:00'e randevunuz var."):
        raise SystemExit("normaliser self-test failed: 14:00'e")
    if mouth.respeller.apply("Jeeta'nın") != "Cita'nın":
        raise SystemExit("respelling self-test failed")


async def run_synth(ws, mouth, pool, sid, text, cancel):
    loop = asyncio.get_running_loop()
    started = time.monotonic()
    samples = 0
    try:
        gen = mouth.chunks(text)
        while not cancel.is_set():
            chunk = await loop.run_in_executor(pool, next, gen, None)
            if chunk is None or cancel.is_set():
                break
            samples += len(chunk) // 2
            await ws.send(chunk)
        kind = "cancelled" if cancel.is_set() else "done"
        await ws.send(json.dumps({
            "type": kind,
            "id": sid,
            "synth_ms": int((time.monotonic() - started) * 1000),
            "audio_ms": samples * 1000 // SAMPLE_RATE,
        }))
    except Exception as e:  # noqa: BLE001 - report the kind, never the text
        LOG.error("synthesis failed: %s", type(e).__name__)
        try:
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": type(e).__name__}))
        except Exception:  # noqa: BLE001
            pass


async def session(ws, mouth, pool):
    current = {"id": None, "cancel": None, "task": None}
    try:
        async for message in ws:
            if isinstance(message, bytes):
                continue
            msg = json.loads(message)
            if msg.get("type") == "synth":
                task = current["task"]
                if task is not None and not task.done():
                    await ws.send(json.dumps({"type": "error", "id": msg.get("id"), "reason": "busy"}))
                    continue
                cancel = asyncio.Event()
                current.update(id=msg["id"], cancel=cancel)
                current["task"] = asyncio.create_task(
                    run_synth(ws, mouth, pool, msg["id"], msg.get("text", ""), cancel)
                )
            elif msg.get("type") == "cancel" and msg.get("id") == current["id"] and current["cancel"]:
                current["cancel"].set()
    finally:
        if current["cancel"]:
            current["cancel"].set()


async def main():
    from websockets.asyncio.server import unix_serve

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    sock = os.environ.get("SPEAK_SOCKET", "/run/jeeta-voice/speak.sock")
    mouth = build_mouth()
    self_test(mouth)
    for _ in mouth.chunks("Merhaba."):  # warm the model before the first call
        pass
    # Two at once: a call's live sentence never waits behind another call's (or its own) pre-synthesis.
    pool = ThreadPoolExecutor(max_workers=int(os.environ.get("SPEAK_WORKERS", "2")))
    if os.path.exists(sock):
        os.unlink(sock)
    async with unix_serve(lambda ws: session(ws, mouth, pool), sock, max_size=2**16):
        os.chmod(sock, 0o660)
        LOG.info("listening")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
```

`rust/bridge/voice/speech/speak/requirements.txt`:

```
ema-lightning==1.1.2
antalia-mini==1.0.1
websockets==17.3
numpy==2.5.4
pytest==8.4.2
```

- [ ] **Step 4: Run the unit tests**

Run: `python -m pytest -c speech/pytest.ini -m "not models" speech/speak/tests`
Expected: `5 passed, 1 deselected`.

- [ ] **Step 5: Write the image and the unit**

`rust/bridge/voice/speech/speak/Dockerfile`:

```dockerfile
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/models/hf
WORKDIR /app
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
      -r requirements.txt -c constraints.txt
# Bake the weights in: the container runs with --network none.
RUN python -c "from ema_lightning import EMA; EMA()" \
 && python -c "from antalia_mini import Antalia; Antalia()" \
 && find /models -type f -name '*.pt' -o -type f -name '*.onnx' -o -type f -name '*.safetensors' \
      | sort | xargs sha256sum > /app/models.sha256
COPY respell.py respell.json jeeta_speak.py ./
COPY tests ./tests
COPY pytest.ini ./pytest.ini
ENV HF_HUB_OFFLINE=1
USER 1501:1501
CMD ["python", "jeeta_speak.py"]
```

`rust/bridge/voice/deploy/jeeta-voice-speak.service`:

```ini
[Unit]
Description=Jeeta voice: speak (EMA Lightning, no network)
After=docker.service systemd-tmpfiles-setup.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/jeeta-voice/images.env
ExecStartPre=-/usr/bin/docker rm -f jeeta-voice-speak
ExecStart=/usr/bin/docker run --rm --name jeeta-voice-speak --network none --user 1501:1501 \
  --cpus 2 --cpu-shares 2048 --memory 2g --read-only --tmpfs /tmp \
  -v /run/jeeta-voice:/run/jeeta-voice \
  -e SPEAK_SOCKET=/run/jeeta-voice/speak.sock -e SPEAK_THREADS=2 -e EMA_SEED=0 \
  ${SPEAK_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 jeeta-voice-speak
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Commit**

```bash
git add rust/bridge/voice/speech/speak rust/bridge/voice/deploy/jeeta-voice-speak.service
git commit -m "feat(voice): the speak service, EMA Lightning behind Antalia's normaliser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: [COORDINATOR, server] Pin the tested versions, build, start**

The owner's blind test ran on `jeeta-ttstest:tmp`; its exact package set becomes the constraints:

```bash
docker run --rm --network none --entrypoint pip jeeta-ttstest:tmp freeze > /root/jeeta-voice-src/rust/bridge/voice/speech/speak/constraints.txt
grep -iE '^(ema-lightning|antalia-mini|torch|numpy)==' /root/jeeta-voice-src/rust/bridge/voice/speech/speak/constraints.txt
```

Expected: `ema-lightning==1.1.2` and a `torch==…` line. If `antalia-mini` is absent, append `antalia-mini==1.0.1`; if `ema-lightning` is not 1.1.2, stop and report (the owner chose 1.1.2). If `numpy` differs from `2.5.4`, change `requirements.txt` to the frozen numpy (the frozen set is the tested one). Copy `constraints.txt` back into the repository (`scp root@38.242.233.166:/root/jeeta-voice-src/rust/bridge/voice/speech/speak/constraints.txt rust/bridge/voice/speech/speak/`) and commit it (`git commit -m "build(voice): the speak image pins the owner-tested package set"`). Then on the host:

```bash
cp /root/jeeta-voice-src/rust/bridge/voice/speech/pytest.ini /root/jeeta-voice-src/rust/bridge/voice/speech/speak/
cd /root/jeeta-voice-src/rust/bridge/voice/speech/speak
TAG=$(date +%Y%m%d%H%M)
nice -n 10 docker build -t jeeta-voice-speak:$TAG .
docker run --rm --network none jeeta-voice-speak:$TAG python -m pytest -m models tests
printf 'SPEAK_IMAGE=jeeta-voice-speak:%s\n' "$TAG" >> /etc/jeeta-voice/images.env
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-speak.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now jeeta-voice-speak
sleep 20; ls -l /run/jeeta-voice/speak.sock; journalctl -u jeeta-voice-speak -n 5 --no-pager
```

Expected: `1 passed` for the models test; `srw-rw---- … speak.sock`; the journal ends with `INFO jeeta-speak listening` and no text. Record the tag in the task notes.

### Task B3: The listen service (Silero VAD, Smart Turn v3.2, seda-v0.1)

**Files:**
- Create: `rust/bridge/voice/speech/listen/endpoint.py`
- Create: `rust/bridge/voice/speech/listen/hotwords.py`
- Create: `rust/bridge/voice/speech/listen/vad.py`
- Create: `rust/bridge/voice/speech/listen/turn.py`
- Create: `rust/bridge/voice/speech/listen/asr.py`
- Create: `rust/bridge/voice/speech/listen/jeeta_listen.py`
- Create: `rust/bridge/voice/speech/listen/fetch_models.py`
- Create: `rust/bridge/voice/speech/listen/models.lock` (generated in Step 6)
- Create: `rust/bridge/voice/speech/listen/requirements.txt`, `constraints.txt` (generated in Step 8)
- Create: `rust/bridge/voice/speech/listen/Dockerfile`
- Create: `rust/bridge/voice/speech/listen/tests/{test_endpoint.py,test_hotwords.py,test_session.py,test_models.py}`
- Create: `rust/bridge/voice/deploy/jeeta-voice-listen.service`

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

- [ ] **Step 8: [COORDINATOR, server] Freeze, build, verify, choose the LM scale, start**

```bash
cd /root/jeeta-voice-src/rust/bridge/voice/speech/listen
cp ../pytest.ini .
: > constraints.txt
docker run --rm -v "$PWD":/w -w /w python:3.12-slim-bookworm sh -c \
  'pip install --no-cache-dir -q -r requirements.txt && pip freeze > constraints.txt'
TAG=$(date +%Y%m%d%H%M)
nice -n 10 docker build -t jeeta-voice-listen:$TAG .
docker run --rm --network none jeeta-voice-listen:$TAG python -m pytest -m models tests
```

Expected: `1 passed, 1 skipped`. Then the loopback check and the LM-scale choice (speak → listen, no call needed):

```bash
SPEAK=$(grep SPEAK_IMAGE /etc/jeeta-voice/images.env | cut -d= -f2)
mkdir -p /root/voice-fixtures && chmod 0700 /root/voice-fixtures
docker run --rm --network none -v /root/voice-fixtures:/out --user 0 "$SPEAK" python -c \
"import wave; from jeeta_speak import build_mouth; m=build_mouth(); pcm=b''.join(m.chunks('Evet, yarın saat on dörtte geliyorum.')); \
w=wave.open('/out/yarin.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(pcm); w.close()"
for s in 0.1 0.3 0.5; do
  docker run --rm --network none -v /root/voice-fixtures:/f -e SEDA_LM_SCALE=$s \
    -e LISTEN_FIXTURE_WAV=/f/yarin.wav -e LISTEN_EXPECT=yarın jeeta-voice-listen:$TAG \
    python -m pytest -m models tests -k recorded
done
```

Expected: `1 passed` for at least one scale. Keep the smallest scale that passes as the default: if it is not `0.3`, change `LM_SCALE` default in `asr.py` and commit (`fix(voice): seda LM scale chosen on the loopback fixture`). A failure at every scale is a stop-and-report (the recognizer is misconfigured; compare with `sedalib`: `pip install sedalib==1.1.0` in a throwaway container and transcribe the same file with `Recognizer.from_pretrained("atasoglu/seda-v0.1")`). Copy `constraints.txt` back to the repository and commit it with `models.lock` (Step 9). Then:

```bash
printf 'LISTEN_IMAGE=jeeta-voice-listen:%s\n' "$TAG" >> /etc/jeeta-voice/images.env
install -m 0644 /root/jeeta-voice-src/rust/bridge/voice/deploy/jeeta-voice-listen.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now jeeta-voice-listen
sleep 15; ls -l /run/jeeta-voice/listen.sock; journalctl -u jeeta-voice-listen -n 5 --no-pager
shred -u /root/voice-fixtures/yarin.wav
```

Expected: `srw-rw---- … listen.sock`, journal `INFO jeeta-listen listening`.

- [ ] **Step 9: Commit**

```bash
git add rust/bridge/voice/speech/listen rust/bridge/voice/deploy/jeeta-voice-listen.service
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
    assert_eq!(c.listen, Endpoint::Unix("/run/jeeta-voice/listen.sock".into()));
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
    pub voice: String,
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
            listen: endpoint("LISTEN_SOCKET", "unix:/run/jeeta-voice/listen.sock")?,
            speak: endpoint("SPEAK_SOCKET", "unix:/run/jeeta-voice/speak.sock")?,
            cache_dir: get("VOICE_CACHE_DIR").unwrap_or_else(|| "/var/lib/jeeta-voice/cache".into()).into(),
            trace_file: get("VOICE_TRACE_FILE").unwrap_or_else(|| "/var/lib/jeeta-voice/traces.jsonl".into()).into(),
            voice: get("VOICE_ID").unwrap_or_else(|| "ema-lightning-1.1.2-seed0-8k".into()),
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
//! own sentences (its plan, the agent's) only in that call's memory, dropped at hang-up.

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
}

/// A WebSocket to the service at `endpoint`.
pub async fn connect(endpoint: &Endpoint) -> Result<Socket, SpeechError> {
    let stream: Pin<Box<dyn Stream>> = match endpoint {
        Endpoint::Tcp(addr) => {
            Box::pin(tokio::net::TcpStream::connect(addr).await.map_err(|_| SpeechError::Unreachable)?)
        }
        #[cfg(unix)]
        Endpoint::Unix(path) => {
            Box::pin(tokio::net::UnixStream::connect(path).await.map_err(|_| SpeechError::Unreachable)?)
        }
        #[cfg(not(unix))]
        Endpoint::Unix(_) => return Err(SpeechError::Unsupported),
    };
    tokio_tungstenite::client_async("ws://localhost/", stream)
        .await
        .map(|(s, _)| s)
        .map_err(|_| SpeechError::Unreachable)
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

/// From the speaker (besides the binary PCM16 chunks).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Spoken {
    Done { id: String, synth_ms: u32, audio_ms: u32 },
    Cancelled { id: String },
    Error {
        #[serde(default)]
        id: Option<String>,
        reason: String,
    },
}
```

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

/// Answers every `synth` on every connection with 160 samples of silence and `done`.
pub fn serve_speaker(mut conns: mpsc::Receiver<WebSocketStream<TcpStream>>) {
    tokio::spawn(async move {
        while let Some(mut ws) = conns.recv().await {
            tokio::spawn(async move {
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
        voice: "test".into(),
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
use jt_calls::{BridgeEvent, Command, DialScript, PhraseSet};
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
    pub voice: String,
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

async fn presynthesize(endpoint: Endpoint, cache: Arc<Mutex<PhraseCache>>, persist: Arc<HashSet<String>>, texts: Vec<String>) {
    let Ok(socket) = speech::connect(&endpoint).await else {
        warn!("pre-synthesis cannot reach the speaker");
        return;
    };
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
    let cache = Arc::new(Mutex::new(PhraseCache::new(deps.cache_dir.clone(), &deps.voice)));
    let persist = Arc::new(policy_sentences(&setup.script));
    tokio::spawn(presynthesize(deps.speak.clone(), cache.clone(), persist.clone(), presynth_order(&setup)));
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
                reporter.send(BridgeEvent::Hangup { cause: netgsm::hangup_cause(cause, false).into() }).await;
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
        let listen = speech::connect(&deps.listen).await.map_err(|_| "listener unreachable")?;
        let (mut listen_tx, listen_rx) = listen.split();
        let start = ToListener::Start { sample_rate: 8_000, hotwords: setup.script.hotwords.clone() };
        listen_tx.send(text_message(&start)).await.map_err(|_| "listener refused the call")?;
        let speak = speech::connect(&deps.speak).await.map_err(|_| "speaker unreachable")?;
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
                m = listen_rx.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(h) = serde_json::from_str::<Heard>(&t) {
                            self.heard(h).await;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => {
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
        let pcm = pcm16(bytes);
        let Some(f) = self.playing.as_mut().and_then(|p| p.in_flight.as_mut()) else { return };
        f.pcm.extend_from_slice(&pcm);
        self.write_pcm(&pcm).await;
    }

    async fn synth_event(&mut self, spoken: Spoken) {
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
                    let _ = self.speak_tx.send(text_message(&ToSpeaker::Cancel { id: f.id })).await;
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
            Command::Play { seq, text, .. } => {
                self.input(Input::Speak { seq, text, barge_in: true, agent: false }).await;
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
        eprintln!("SLICE_TO must hold a +90 number");
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
        voice: config.voice.clone(),
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
    for (name, endpoint) in [("listen", &config.listen), ("speak", &config.speak)] {
        match speech::connect(endpoint).await {
            Ok(_) => println!("{name}: ok"),
            Err(e) => {
                ok = false;
                println!("{name}: {e}");
            }
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

Expected: `ari: ok (Asterisk 22.11.0)`, `listen: ok`, `speak: ok`. (`sudo -g` gives the `jeeta-voice` supplementary group through the user's membership; if a socket is refused, run `id jeeta-voice-bridge` and confirm `jeeta-voice` is listed.)

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
        voice: config.voice.clone(),
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
        warn!(call, "a dial outside Türkiye was refused");
        let _ = reports.send(refuse("permanent: bridge: this line calls Turkish numbers only")).await;
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
LISTEN_SOCKET=unix:/run/jeeta-voice/listen.sock
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
| `jeeta-voice-listen` | Silero VAD, Smart Turn v3.2, seda-v0.1 (`--network none`, uid 1501) | `/run/jeeta-voice/listen.sock` |
| `jeeta-voice-speak` | Antalia normaliser + EMA Lightning 1.1.2 (`--network none`, uid 1501) | `/run/jeeta-voice/speak.sock` |
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
