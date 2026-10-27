# Agent voice calls: the connected agent on the phone — design

> Date: 2026-10-27 · Status: **design, awaiting owner decisions (§13)** · Branch context: `feat/rust-panel-money-inputs` @ 7513c253 (PR #365 → feat/rust-m4-productisation)
> Companion plan: `docs/superpowers/plans/2026-10-27-cleanup-and-voice-plan.md` · Sibling spec: `2026-10-27-tiktok-linkedin-connectors-design.md`
> Paths are relative to `rust/` unless prefixed `docs/`.

## 0. Decision in five lines

1. **Recommend C (hybrid): a turn-based call session driven by the connected agent through MCP tools, with audio handled by a small self-hosted "voice bridge" sidecar that registers as a Netsantral extension and does only STT/TTS; the server never thinks.** The agent is the brain, no platform LLM key, no VAPI/Retell/OpenAI.
2. **Honest limit:** each turn costs the agent's own think time (3–10 s, worst 20 s). With holding phrases and an agent-authored fallback script the caller hears a *slow assistant*, not a natural conversation. Good for confirmations, qualification, appointment booking, message taking; not for persuasion.
3. **Inbound works only while an agent is "on duty"** (looping `calls.listen`). Otherwise the bridge plays the owner-authored voicemail text, records a callback task, and the agent calls back when it next checks in.
4. **Phase V0 needs no purchase** and lands real value today: click-to-call for human reps (adapter exists, use case missing), a call log, İYS/hours/cap/budget gates, CDR and report consumption. V1 needs a sidecar host (CPU) and one free one-hour test (Gate V1: can a software SIP UA register as extension 101?). SIP Trunk (1.035 TL/mo) is the fallback if NetGSM refuses; everything else (Özel API 933 TL, Yapay Zeka 325 TL, recording 289 TL) is **not** needed for the recommended path.
5. **B (realtime speech-to-speech model) is specified as an optional later lane, not recommended:** it needs a provider key and billing, the brain during the call is the provider's model, and the owner has refused exactly that.

## 1. What the owner asked, restated as requirements

- The *connected* agent (Claude Code, Codex, any MCP client holding a Jeeta API key) talks to the customer on the phone and uses the inbox during and after the call (people, journeys, appointments, quotes, notes).
- No hosted voice bot that thinks for itself; no API key for a third-party LLM on the server (owner goal from the MCP platform-key removal: *"when connected, no Anthropic key is needed anywhere"*).
- Telephony is NetGSM (Netsantral 0850 840 73 03). Agents reach the system only through MCP; the server cannot wake or call the agent (design §4.2 rule 3, `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md:139`).
- Turkish law: commercial calls need İYS consent on the ARAMA channel; KVKK needs a recording announcement.

## 2. Constraints verified in code (not assumed)

| Constraint | Evidence |
|---|---|
| Agents reach the server only over MCP streamable HTTP with a bearer key; a session is bound to its key | `crates/adapters/jt_mcp/src/http.rs:19-33`, `sessions.rs:1-15` |
| The server never wakes an agent; the agent checks in on its own schedule; no sampling, no server→agent call | `crates/jt_app/src/usecases/work.rs:36-44`; design §4.2 rule 3 |
| No long-poll exists anywhere today (grep `long-poll|wait_for|timeout_ms` in `jt_mcp/src`, `jt_app/src`: none) | — |
| `Telephony::click_to_call`/`hangup` exist on the port and in the adapter; **no use case, MCP tool or panel route calls them** | port `crates/jt_app/src/ports/connectors.rs:748-764`; adapter `crates/adapters/jt_netgsm/src/santral.rs:114,164`; only callers are wiring (`bin/jeeta/src/connectors.rs:122-124`), the `None` stub (`jt_app/src/std_impls.rs:224`), fakes and tests |
| `NetgsmConnector::call_records` (CDR poll) has no caller | `santral.rs:341-348` |
| The adapter reads `public["call_mode"]` and `public["recording_allowed"]`, but **no use case or panel ever writes them** (grep in `jt_app/src`, `jt_panel_http/src`, `panel/src`: none) → calls can never be recorded or placed as `linkup` | `santral.rs:60-83` vs. `connected_public` in `usecases/connector.rs:2399` |
| Inbound call events: `events` purpose → `CallEvent` (`inbound_call`/`answer`/`hangup`/`cdr`); consumer handles the first three, defers `cdr`; `voice-report`/`autocall-report` `Status` events fall through to `deferred`; a "deferred" outcome is never re-listed except Meta `lead_gen` | `jt_netgsm/src/webhook.rs:255-262`; `usecases/inbox/consumer.rs:237-249, 696-773`; `jt_pg/src/repos/events.rs:100` |
| `Channel::Phone` exists; `netgsm_pbx` maps to it; a hangup applies `JourneyEventKind::CallMade{connected}` | `jt_inbox/src/identity.rs:26,67`; `jt_inbox/src/journey.rs:217`; `consumer.rs:746-759` |
| Consent is per channel (`Channel::Phone` distinct from `Sms`); `commercial_allowed` + suppressions is the fence used by every send; the fence is re-evaluated right before provider I/O | `jt_inbox/src/consent.rs:96-120`; `usecases/inbox/replies.rs:505-585` |
| Capability policy carries `active_hours` (IANA tz, weekday windows), `daily_ops_cap`, `spend_cap_minor`, `requires_human_approval`; enforcement helper `hours()` exists for Studio only | `jt_capability/src/policy.rs:22-36`; `usecases/studio/chain.rs:105-128` |
| Budget: `budget.spend.record` (risk SPEND) records spend against an item; linking a capability to an item exists; over-cap only *writes* `budget.over_cap`, it does not refuse | `usecases/budget.rs:331-360`; catalog `catalog.rs:337` |
| Egress: connector adapters may reach only fixed-tier hosts; private/loopback addresses are refused (`NotPublic`); plain http only for `crmsntrl.netgsm.com.tr:9111` | `jt_outbound/src/fixed_hosts.rs:29-45`; `client.rs:36-56` |
| Connector adapters may not open sockets or name an HTTP client; new adapter crates must be allow-listed | `jt_archtest/tests/dependency_boundaries.rs:261-370` |
| NetGSM webhooks are unsigned; each URL carries a per-purpose HMAC token; body kept 30 days | `jt_webhook/src/lib.rs:36-50`; `usecases/connector.rs:980-1012` |
| Catalog is pinned at 144 rows; every MCP tool needs a catalog row + definition + risk-tagged description | `crates/jt_app/tests/catalog.rs:261`; `jt_mcp/src/registry.rs:70-125` |
| Live account facts (measured today): Netsantral active, extension 101 registered nowhere; click-to-call API authenticates (401 "Kullanici dogrulanamadi" = bad creds; `queuestats` 400 code 30 after accepting creds); SIP Trunk, Özel API, recording and "Yapay Zeka" add-ons **not** active | owner's measurement; adapter already models the `queuestats` quirk at `santral.rs:197-215` |

## 3. Options evaluated

### 3.1 Where the audio can come from (NetGSM)

| Path | What it gives | Needs | Verdict |
|---|---|---|---|
| **P1. Software SIP extension.** A sidecar registers as extension 101 on the Netsantral SIP server (`sip5.netsantral.com:5060`, Eko package has 2 extensions; v1's webphone registered the same way with SIP.js). Inbound: the PBX call flow rings 101. Outbound: the extension dials out, or `originate(internal_num=101, customer_num)` through the existing API. | Raw G.711 audio both ways, DTMF, hangup, caller id | **Nothing to buy.** One unverified assumption: NetGSM lets a third-party SIP UA register from the server's IP (Gate V1, §10). | **Primary.** |
| P2. SIP Trunk add-on. NetGSM routes the number to a SIP URI we give (their VAPI/Retell/ElevenLabs recipe, pointed at our sidecar instead). | Same as P1, trunk-grade; outbound needs NetGSM's outbound approval | 1.035 TL/mo + approval | **Fallback** if P1 is refused. |
| P3. Özel API (Custom) add-on. Per-call webhook (`arayan_no, aranan_no, arama_id, tus_bilgisi`) → we answer `{status,result,data}`; `data` is read by NetGSM's TTS robot; DTMF; dynamic redirect. **No STT.** | A keypad IVR whose prompts the agent authors | 933 TL/mo | Not on the path: no speech in, so the agent cannot *listen*. Only useful as a pre-bridge "press 1 for the assistant" menu, and the PBX's own IVR can do that for free. |
| P4. Partner platform (VAPI/Retell/ElevenLabs) over SIP Trunk, with our server as its "custom LLM" relaying to the agent | Best audio layer (barge-in, VAD) | Trunk + per-minute partner fees + the partner waits 5–15 s per turn on our custom-LLM endpoint (their timeouts are 10–30 s) | Owner refused; latency no better than P1. Dropped. |
| P5. NetGSM "Çağrı Analizi" (post-call transcript, 289 TL/mo) | Transcript after the call, NetGSM's own AI | 289 TL/mo | Not needed: the bridge has the audio and the transcript is ours. |

### 3.2 Speech in/out without an LLM

| Engine | Turkish | Where it runs | Latency (per utterance / sentence) | Cost | Notes |
|---|---|---|---|---|---|
| **Vosk** `vosk-model-small-tr-0.3` (STT, streaming) | yes, moderate accuracy | sidecar CPU | partials while speaking; final 100–300 ms after endpoint | 0 | Lowest latency; numbers/names weaker |
| **faster-whisper** `large-v3-turbo` / `small` (STT, batch per utterance) | yes, good (turbo) | sidecar CPU (4 vCPU: RTF ≈ 0.3–1.0 for turbo; GPU: ≪ 1) | 1–3 s after endpoint on CPU | 0 | Better accuracy; adds a second of silence |
| **Piper** `tr_TR-fahrettin-medium` / `tr_TR-dfki-medium` (TTS) | yes, intelligible, robotic | sidecar CPU | 200–500 ms per sentence | 0 | Pre-synthesise greeting/holding/fallback lines at call start |
| Deepgram Nova-2/3 streaming (STT) | yes | cloud, key in the bridge | ~300 ms after endpoint | ≈ $0.008/min | Not an LLM; still a key and a bill |
| Azure Speech / Google Cloud STT+TTS | yes, best TR voices | cloud | STT ~500 ms; TTS ~300 ms | ≈ $1/h STT, $16/1M chars TTS | Same |
| ElevenLabs TTS | yes, excellent | cloud | 300–800 ms | pricey | Same |
| OpenAI `gpt-4o-transcribe` / `tts-1` | yes | cloud | ~1 s | per minute | An OpenAI key again, even though it is not the brain; listed for completeness |
| NetGSM TTS robot (Özel API) | yes | NetGSM | n/a | 933 TL/mo | Only inside the IVR webhook model; cannot "say" into an arbitrary bridged call |

Default: **Vosk + Piper, self-hosted, zero marginal cost**, upgrade path to faster-whisper (accuracy) and to a cloud key (quality) by changing bridge config, not Jeeta.

### 3.3 Option A — turn-based session, agent is the brain

Server: telephony + STT/TTS + state machine + gates. Agent: `calls.place → loop(calls.listen → think → calls.say) → calls.end`.

**Latency budget per caller turn** (self-hosted engines, no GPU):

| Step | Time |
|---|---|
| Caller stops speaking → VAD endpoint | 0.6–0.8 s |
| STT final (Vosk) / (whisper-turbo CPU) | 0.1–0.3 s / 1–3 s |
| Bridge → server `utterance` POST; server appends turn; wakes the waiting `calls.listen` | ≤ 0.1 s |
| Agent receives, thinks, calls `calls.say` (Claude Code / Codex) | **3–10 s typical, 15–20 s worst** |
| Server → bridge command (bridge long-polls, usually already waiting) | ≤ 0.1 s |
| TTS (Piper) first sentence | 0.2–0.5 s |
| **Silence the caller hears** | **≈ 4.5–12 s (worst ≈ 22 s)** |

That is the honest number. The design makes it survivable, not invisible:

- **Holding phrases** (agent- or owner-authored, pre-synthesised at call start, ≥ 3 variants): played at 4 s and again at 10 s of agent silence; a caller speaking over them cancels playback (barge-in) and the utterance is appended.
- **Fallback script**: `calls.place` takes a `plan` with `fallback_lines` (max 3) and a `closing`. At 20 s without `calls.say` the server plays the next fallback line (e.g. "Sizi en kısa sürede geri arayacağız"); when the lines are exhausted it plays `closing`, hangs up, creates a callback task and ends the session with `agent_timeout`. **The server never composes a sentence; it only plays text the agent or owner authored in advance.**
- **Agent disconnect**: same path as agent silence; the session always ends by script within `max_turn_silence_s × (fallbacks+1)`.
- **Tool-call timeouts**: `calls.listen` long-polls at most 25 s (Codex `tool_timeout_sec` default 60 s; Claude Code `MCP_TOOL_TIMEOUT` is larger) and answers `{events: [], timed_out: true}`; the agent loops.
- **Barge-in**: the bridge stops TTS when caller speech energy exceeds the VAD threshold for 200 ms; the server marks the `say` turn `interrupted_at_char`.
- **Silence from the caller**: 6 s → `silence` event; the agent may re-prompt; 15 s total → scripted closing.
- **Max call duration** (policy, default 6 min) → closing + hangup (`max_duration`).

**Cost per minute**: NetGSM tariff of the account (unknown to the server; recorded as `estimated_minor_per_minute` on the capability's budget link); STT/TTS 0 self-hosted (≈ $0.01–0.02/min cloud); agent tokens: ~2 tool calls per turn on the owner's own agent subscription.

**Legal**: fits — the fence runs before dialing, the greeting discloses an assistant, the recording announcement precedes any recording.

### 3.4 Option B — realtime speech-to-speech model on the line

E.g. OpenAI Realtime over SIP (NetGSM SIP Trunk → `sip:<project>@sip.api.openai.com`) or via the bridge streaming audio to the provider's WebSocket. The connected agent *prepares* the call (goal, instructions, allowed tools) and *reviews* the transcript afterwards; the model may call Jeeta tools mid-call through a server-side function bridge.

- Latency: ~1 s per turn; natural, barge-in native. Best caller experience by far.
- Needs: provider API key and billing (≈ $0.30/min at current audio-token prices, order of magnitude), SIP Trunk (1.035 TL/mo) or the bridge, an OpenAI-compatible function-call relay in the server that executes `inbox.*` use cases **as a system actor on the model's behalf** — which breaks the "connected agent is the brain" rule and the "no provider key on the server" goal.
- Legal: same gates; disclosure mandatory.
- Verdict: **not now**. Kept as a lane behind a future capability kind `realtime_voice_provider` whose credential is the provider key sealed per workspace (never a platform key), so if the owner ever changes his mind the session model, gates, transcript and panel are reused unchanged. Nothing in this design assumes it.

### 3.5 Option C — the hybrid recommended

A (agent-driven turns) on P1 (software extension) with self-hosted engines, plus:

- **V0 first**: human click-to-call + call log + gates + CDR, because it is value with zero purchase and it is the data model everything else writes into.
- **Duty mode** for inbound; voicemail + callback task when nobody is on duty.
- **Human transfer** (`calls.transfer` to a rep extension / phone) as the escape hatch the agent can pull at any turn.
- B as an optional later lane (§3.4).

Why not pure A on P2 (trunk)? Because P1 costs nothing and the only risk is a one-hour test. Why not B? Owner's rule, key, and "brain elsewhere".

## 4. Architecture (recommended path)

```
 PSTN ──► Netsantral (0850 840 73 03) ──ring ext 101──► voice bridge (sidecar, SIP UA + VAD + STT + TTS)
                      ▲ originate(101,→customer)              │  HTTPS client of Jeeta (bearer API key, role voice_bridge)
                      │ (netgsm_pbx API, V0 humans)           │  POST /api/voice/bridge/events   (inbound, answered, utterance, dtmf, said, hangup)
                      │                                       │  GET  /api/voice/bridge/commands?wait=25  (answer, dial, say, transfer, hangup)
                      │                                       ▼
                 ┌──────────────────────────── jeeta serve ─────────────────────────────┐
                 │ usecases/calls/* : session state machine, gates (consent/hours/cap/  │
                 │ budget), turn log, holding/fallback timers, duty registry            │
                 │ MCP: jeeta.calls.place/listen/say/transfer/end/get/list/duty_*       │
                 │ Panel: /calls, /calls/{id} (live view), policy editor                │
                 └──────────────────────────────────────────────────────────────────────┘
                                                   ▲ MCP (streamable HTTP, bearer)
                                                   │ calls.listen long-poll ≤ 25 s
                                          Claude Code / Codex / any MCP client  (the brain)
```

**The bridge is a client, never a target.** Jeeta never dials the sidecar (loopback/private hosts are refused by egress by design, `jt_outbound/src/client.rs:36-45`), so no egress change, no new socket code in a Rust crate, no `jt_archtest` exception. The sidecar holds its SIP credentials in its own config (deployed by the operator beside `jeeta.service`); Jeeta never stores a SIP password. Same pattern as the phone-control bridge already in production.

**STT/TTS live in the bridge**, selected by its config; Jeeta sees only `{stt: {engine, model}, tts: {engine, voice}}` facts in the capability's `connector_public` and the per-turn latencies the bridge reports.

## 5. Domain model

New domain crate `crates/domain/jt_calls` (pure, like `jt_inbox`):

```rust
pub struct CallSession { id: CallId, workspace_id, direction: Inbound|Outbound, purpose: CallPurpose,
    person_id: Option<PersonId>, journey_id: Option<JourneyId>, mode: Agent|Human{rep_extension},
    state: CallState, plan: CallPlan, counterpart_e164: String /* masked in every output */,
    bridge_call_id: Option<String>, pbx_unique_id: Option<String>, crm_id: Option<String>,
    agent_connection_id: Option<AgentConnectionId>, placed_by: Actor,
    started_at, answered_at: Option, ended_at: Option, end_cause: Option<EndCause>,
    recording: RecordingState /* Off | Announced | Recording{file_ref} */, metrics: CallMetrics }
pub enum CallPurpose { Service, Commercial, Callback }
pub enum CallState { Planned, Dialing, Ringing, Live, Holding, Ending, Ended }
pub enum EndCause { CallerHangup, AgentEnded, AgentTimeout, MaxDuration, NoAnswer, Busy, Failed(String /* failure line */),
    Transferred, BridgeOffline, Refused(RefusalReason) }
pub enum RefusalReason { ConsentMissing, Suppressed, OutsideWorkHours, DailyOpsCap, BudgetExhausted, BridgeOffline,
    BridgeBusy, PersonErased, PersonMerged, NoPhoneIdentity, WorkspaceInactive, StrategyRequired }
pub struct CallPlan { opening: String, goal: String, holding: Vec<String> /* 1..=5 */, fallback: Vec<String> /* 0..=3 */,
    closing: String, max_duration_s: u16 /* ≤ 900 */, language: String /* "tr" */, disclose_assistant: bool /* forced true by policy */ }
pub struct Turn { seq: u32, at: OffsetDateTime, kind: TurnKind, text: String, meta: TurnMeta }
pub enum TurnKind { Utterance{final_: bool, confidence: f32}, Say{by: Agent|Script}, Holding, Fallback, Dtmf, Event(String) }
pub struct CallMetrics { turns: u32, agent_latency_ms: Vec<u32> /* utterance-final → say */, stt_ms: Vec<u32>, tts_ms: Vec<u32>, holding_played: u8, fallback_played: u8 }
```

Pure functions: `fence_call(purpose, consents, suppressions, journey_status, person, hours, cap_used_today, budget_remaining) -> Result<(), RefusalReason>`; `next_timer(state, last_utterance_at, last_say_at, plan, policy) -> TimerAction {PlayHolding, PlayFallback(i), Close, None}`; `reduce(session, bridge_event) -> (session, Vec<Command>)`. All unit-tested with a scripted clock.

Workspace policy (stored in `workspace_policies`, new `calls` column, tolerant like `InboxPolicy`): `CallPolicy { greeting_inbound, voicemail_text, recording_announcement, disclose_assistant: bool (default true, owner-only), holding_default: Vec<String>, max_duration_s, slow_agent_s (4), fallback_after_s (20), caller_silence_s (6), handoff_extension: Option<String>, estimated_minor_per_minute: i64 }`.

## 6. Capabilities and credentials

- **`netgsm_pbx`** (exists): the Netsantral API user; V0 click-to-call for humans, CDR poll, hangup of a live call by `unique_id`. Fix: write `call_mode` and `recording_allowed` into `connector_public` from a new `connector.set_pbx_policy` input (or fold into `calls.policy_set`), so the adapter's documented keys are reachable at all.
- **`voice_bridge`** (new kind, `KindGroup::Telephony`, reach like a device): declared in the panel or by the bridge's first `register`; verified by heartbeat (`register` every 15 s; `stale` after 60 s, `unreachable` after 10 min); `connector_public = {extension, codecs, stt, tts, bridge_version, last_seen_at}`; `external_id = extension`. Its budget link carries the per-minute estimate. Policy (`capability.set_policy`) gives active hours and `daily_ops_cap` (calls/day) exactly as other kinds.
- **Bridge authentication**: an API key with a new role **`voice_bridge`** holding only the new permission `calls.bridge` (plus nothing else). Permission enum gains `CallsWork` (`calls.work`: place/listen/say/end — granted to `owner`, `manager`, `rep` by migration backfill like `0004`), `CallsManage` (`calls.manage`: policy, duty for others, transfer config — owner/manager) and `CallsBridge` (`calls.bridge`: the sidecar only; never granted to system roles).
- **No new sealed credential in Jeeta for V1.** Cloud speech keys, if ever used, live in the bridge's config (operator-deployed). If the owner later wants the panel to hold them, add `Credential::SpeechProvider{provider, api_key}` fetched by the bridge through `calls.bridge` — explicitly deferred.

## 7. Use cases, catalog rows, MCP tools

Catalog ids `calls.*`, tools `jeeta.calls.*`, all `GateMode::Gated` except `calls.bridge.*` and `calls.policy_get` (Exempt), status exemption Never. Catalog count 144 → 144 + rows below (update `jt_app/tests/catalog.rs:261`).

| Use case | MCP tool | Panel route | Risk | Permission | Notes |
|---|---|---|---|---|---|
| `calls.policy_get` | `jeeta.calls.policy_get` | `GET /api/calls/policy` | Read | calls.work | |
| `calls.policy_set` | `jeeta.calls.policy_set` | `PUT /api/calls/policy` | Write | calls.manage | `disclose_assistant` can be set false only by a human actor |
| `calls.place` | `jeeta.calls.place` | `POST /api/calls` | **Spend** | calls.work | `{person_id? \| phone?, journey_id?, purpose, mode: "agent"\|"human", rep_extension?, plan?}`; runs the fence; `mode=human` → `Telephony::click_to_call(originate rep_ext → customer)`; `mode=agent` → bridge `dial` command. Returns `{call_id, state, refusal?}` |
| `calls.listen` | `jeeta.calls.listen` | `GET /api/calls/{call_id}/events?after_seq&wait_s` | Read | calls.work | Long-poll ≤ 25 s; `{events:[{seq, at, kind, text?, ...}], state, timed_out}`; without `call_id` (duty mode) also returns `inbound{call_id, from_masked, person_id?}` |
| `calls.say` | `jeeta.calls.say` | `POST /api/calls/{call_id}/say` | Write | calls.work | `{text ≤ 600 chars, expect_reply: bool, allow_barge_in: bool = true}` → `{seq}`; refused when state ∉ {Live, Holding} |
| `calls.transfer` | `jeeta.calls.transfer` | `POST /api/calls/{call_id}/transfer` | Write | calls.work | `{to_extension? \| to_phone?}`; bridge SIP REFER / PBX transfer; ends the agent's part with `Transferred` |
| `calls.end` | `jeeta.calls.end` | `POST /api/calls/{call_id}/end` | Write | calls.work | `{outcome: connected\|no_answer\|voicemail\|refused_by_customer\|appointment\|callback_requested\|other, summary ≤ 2000, follow_up_task?: {due_at, title}}`; plays `closing` unless already ended; writes journey `CallMade{connected}` + note (summary + transcript ref) |
| `calls.get` | `jeeta.calls.get` | `GET /api/calls/{call_id}` | Read | calls.work | Session + turns + metrics + recording ref |
| `calls.list` | `jeeta.calls.list` | `GET /api/calls` | Read | calls.work | Paged, filters: person, state, direction, since |
| `calls.duty_start` | `jeeta.calls.duty_start` | `POST /api/calls/duty` | Write | calls.work | Registers the caller's agent connection as on duty for inbound (TTL 90 s, renewed by every `calls.listen` without `call_id`) |
| `calls.duty_end` | `jeeta.calls.duty_end` | `DELETE /api/calls/duty` | Write | calls.work | |
| `calls.bridge.register` | — (panel_only is wrong; this is **bridge_only**: a third surface flag or reuse `mcp_only=false, panel_only=true` with route under `/api/voice/bridge/*`) | `POST /api/voice/bridge/register` | Write | calls.bridge | Heartbeat + facts; verifies the `voice_bridge` capability |
| `calls.bridge.commands` | — | `GET /api/voice/bridge/commands?wait_s` | Read | calls.bridge | Long-poll ≤ 25 s; leases commands (`taken_at`), re-delivers un-acked ones after 10 s |
| `calls.bridge.events` | — | `POST /api/voice/bridge/events` | Write | calls.bridge | Batch of events; idempotent by `(bridge_call_id, bridge_seq)` |
| `calls.cdr_poll` (job) | — | — | — | system | `Job::NetgsmCdrPoll` hourly: `call_records` → `cdr` events → duration, recording ref, cost backfill |

Catalog twin rule: the three bridge routes are `panel_only` rows (no MCP tool) served under `/api/voice/bridge/*` by `jt_panel_http` with the API-key bearer auth path that `/mcp` uses (not the session cookie). Add a `surface` note in the catalog comment; the existing `panel_only` flag is adequate.

**`work.pending` items** (new `WorkKind`s): `CallbackDue{call_id, person_id}` (priority 2; cleared by `calls.place`), `CallWaiting{call_id}` (priority 1; only while an inbound call is ringing and the caller is on duty; cleared by `calls.listen`), `VoiceBridgeOffline{capability_id}` (priority 2; cleared by the bridge's `register`).

**Tool descriptions** (English, end with the risk tag) must tell the agent the loop and the latency rule: *"Reply within 10 seconds; after 4 s the caller hears a holding phrase, after 20 s a fallback line from your plan, and the call ends by script."*

## 8. Gates (every `calls.place`, re-checked right before the bridge `dial`)

Order, first refusal wins, each a stable `RefusalReason` in `details.reason` and a ledger entry `calls.refused`:

1. Workspace active; approved strategy (Gated row).
2. `voice_bridge` capability `verified` (heartbeat ≤ 60 s) for `mode=agent`; `netgsm_pbx` verified for `mode=human`. Else `bridge_offline`.
3. Person resolvable: `person_id` with a `Phone` identity, or `phone` (E.164) that resolves/creates a person via the existing contact path; `person_erased` / `person_merged` refused.
4. **İYS / consent by purpose** (`Channel::Phone`, never `Sms`):
   - `commercial` → `commercial_allowed(consents, suppressions, Channel::Phone)` must be `Ok` (explicit or implied-by-contract, no suppression) — the ARAMA channel as İYS syncs it (`ConsentSource::IysSync`).
   - `service` → an existing relationship: a journey in `Won` or with an `AppointmentBooked`/`QuoteSent` event in the last 180 days, or an open appointment; no suppression on `Phone`. (Ticari İletişim Yönetmeliği exception for existing customers; the call must not sell.)
   - `callback` → an inbound `CallEvent`/`CallSession` from that number in the last 7 days, or an explicit callback request event; no suppression.
   - A latest journey `Lost` refuses `commercial` and `service` (`journey_lost`, mirrors the send fence).
5. **Capability policy**: `hours()` of the `voice_bridge` (or `netgsm_pbx`) capability — reuse `studio/chain.rs:105-128` by moving it to `usecases/policy.rs`; `daily_ops_cap` counted from `call_sessions` placed today in the workspace timezone; `requires_human_approval` → the session is created `Planned` and listed as `StudioApproval`-like `CallApproval` work for a human (panel button), bridge dials only after approval.
6. **Budget**: the capability's linked budget item must have remaining ≥ `estimated_minor_per_minute × 1`; refused `budget_exhausted` otherwise. On end: `record_spend(item, ceil(duration_s/60) × rate, reference = call_id)` as `SpendSource::Connector("calls")`; CDR backfill corrects to the provider's figure when the record carries one.
7. **Concurrency**: one live agent-mode call per agent connection; `bridge_busy` when the bridge reports its line limit (`max_calls` fact) reached.
8. **Recording**: only if `recording_allowed` policy is true AND `recording_announcement` is non-empty; the bridge starts recording after the announcement finishes (`said{seq}` event), never before; inbound voicemail is always announced.
9. **Disclosure**: the opening/greeting must contain the assistant disclosure when `disclose_assistant` is true; the server checks the plan's `opening` contains the policy's disclosure sentence (exact substring) else refuses `disclosure_missing`.

Inbound (bridge `inbound` event): steps 1–2 trivially, 3 resolves/creates the person, consent is not required to *answer*; if an agent is on duty → `answer` + `greeting_inbound` and the agent gets `inbound`; else → `answer` + `voicemail_text` + record 60 s max + hangup + `CallbackDue` work item + conversation on `netgsm_pbx`/`voice_bridge` capability + `CallMade{connected:false}`? No: inbound-unanswered-by-human is `MessageReceived` semantics (does not advance the journey) — use `MessageReceived` with the voicemail transcript as the message body.

## 9. Persistence (migration `0014_voice_calls`, after the cleanup migration `0013`)

All tenant tables: `workspace_id` first, composite FKs, ENABLE + FORCE RLS with the `0008` policy template, repeatable up/down; down refuses while live sessions exist.

- `call_sessions(workspace_id, id pk, capability_id, person_id?, journey_id?, direction, purpose, mode, state, counterpart_e164, plan jsonb, bridge_call_id?, pbx_unique_id?, crm_id?, agent_connection_id?, placed_by jsonb, started_at, answered_at?, ended_at?, end_cause?, end_detail?, recording_state, recording_ref?, cost_minor?, metrics jsonb, created_at)`; indexes `(workspace_id, state)`, `(workspace_id, person_id, started_at desc)`, unique `(workspace_id, crm_id)`, unique `(workspace_id, bridge_call_id)`.
- `call_turns(workspace_id, call_id, seq, at, kind, by, text, meta jsonb, pk (workspace_id, call_id, seq))`. Text may be erased by the person-erasure flow (`jeeta.erasure` exception extended; `seq`, kind and timings kept, like journey events).
- `call_commands(workspace_id, id pk, call_id?, kind, payload jsonb, created_at, taken_at?, acked_at?, result jsonb?)`; index `(workspace_id, taken_at) where acked_at is null`.
- `call_duty(workspace_id, agent_connection_id pk, since, last_poll_at)`.
- `workspace_policies.calls jsonb` (tolerant decode, like `inbox_policy` in `0007`).
- `roles`: backfill `calls.work` to owner/manager/rep, `calls.manage` to owner/manager (pattern `0004`); new system role `voice_bridge` with `calls.bridge` only.
- Timestamps in these JSON columns use `time::serde::rfc3339` from day one (the Studio tuple lesson, plan C-T2).

Retention: turns and sessions indefinitely (ledger-grade evidence); recordings per `recording_retention_days` policy (default 90) purged by `Job::CallsRecordingPurge`; bridge commands purged after 7 days.

## 10. Bridge protocol (sidecar ↔ Jeeta)

The sidecar (`rust/bridge/voice/`, Python 3.12 with `pjsua2` or Go with `emiago/sipgo`+`diago`; choice left to the implementer, prefer Go for a static binary) is an **HTTPS client** with bearer `jeeta_...` API key (role `voice_bridge`), base URL `JEETA_BASE_URL`, SIP config `SIP_SERVER=sip5.netsantral.com`, `SIP_USER=101`, `SIP_PASSWORD`, engines `STT=vosk:/models/tr`, `TTS=piper:/voices/tr_TR-fahrettin-medium.onnx`.

- `POST /api/voice/bridge/register {extension, codecs:["PCMA","PCMU"], max_calls, stt:{engine,model}, tts:{engine,voice}, version}` every 15 s → `{capability_id, policy_digest}`.
- `GET /api/voice/bridge/commands?wait_s=25` → `{commands:[{id, call_id, kind, payload}]}`; kinds: `answer{greeting_text, then_record: bool}`, `dial{to_e164, caller_id?, plan_audio:{opening, holding[], fallback[], closing}}` (pre-synthesise), `say{seq, text, allow_barge_in}`, `play{kind: holding|fallback|closing, index}`, `record{start|stop}`, `transfer{to}`, `hangup`. The bridge acks with an event `command_done{id}`; un-acked commands are re-delivered after 10 s (idempotent on the bridge by `id`).
- `POST /api/voice/bridge/events {events:[{bridge_call_id, bridge_seq, at, kind, ...}]}` → `{accepted: n}`; kinds: `inbound{from_e164, to_e164}`, `ringing`, `answered`, `utterance{text, is_final, confidence, started_ms, ended_ms, stt_ms}`, `dtmf{digit}`, `said{seq, done|interrupted_at_char, tts_ms}`, `silence{ms}`, `recording{file_ref, bytes}`, `hangup{cause}`, `error{failure_line}`. Idempotent by `(bridge_call_id, bridge_seq)`. Audio never crosses this API; recordings are files the bridge writes into Jeeta's `FileStore` path (`jt_files`) under `calls/{workspace}/{call_id}.wav` (same host) or uploads via `POST /api/voice/bridge/recording` (multipart) when remote.
- Masking: the server masks `*_e164` to `+90 5xx *** ** 12` in every tool/panel output except `calls.get` for `calls.manage`.

**Gate V1 (owner, one hour, before any bridge code):** on the Contabo host run `baresip`/`pjsua` with ext 101 credentials from the Netsantral portal (Dahililer → 101 → SIP şifresi): (a) REGISTER succeeds; (b) an inbound call to 0850 840 73 03 routed to 101 (portal: Çağrı akışı → Dahili 101) rings and has two-way audio; (c) `101` dials a mobile and has audio. Record pass/fail per leg. If (a) fails for IP/UA policy → open a ticket or buy SIP Trunk (P2).

## 11. Panel

- `/calls` (new page, nav under Inbox): table (direction, person, purpose, state, started, duration, outcome, cost, agent/human), filters, "Place a call" button (human mode for reps: rep extension from the user's profile; agent mode only shows if an agent is on duty) — Turkish copy, i18n parity.
- `/calls/{id}`: timeline of turns (utterance left, say right, holding/fallback muted, latency chip per agent turn), state banner, recording player (if any), person/journey links, live actions for `calls.manage`: **End call**, **Transfer to me** (my extension), **Take over** (disables agent `say`, routes bridge audio to the rep's extension via transfer). Live view polls `GET /api/calls/{id}/events?after_seq&wait_s=10` (same long-poll route; no SSE needed).
- Policy editor: Settings → Calls (greeting, voicemail, recording announcement, disclosure sentence, holding phrases, limits, handoff extension, per-minute estimate). `recording_allowed` toggle lives on the `netgsm_pbx`/`voice_bridge` capability card.
- Capability card for `voice_bridge`: heartbeat age, engines, extension, link to the setup doc (`docs/operations/voice-bridge.md`: install, SIP creds, Gate V1 steps, systemd unit).
- Setup readiness: new items "Voice bridge not registered", "Calls policy incomplete (no greeting)".

## 12. Observability, failures, tests

- Ledger: `calls.placed`, `calls.refused{reason}`, `calls.answered`, `calls.ended{cause, duration_s, turns}`, `calls.transferred`, `calls.approved`, `calls.policy_set`; never per turn.
- Ops (`OpsHealthOut`): `voice_bridges_online`, `calls_live`, `calls_agent_timeout_total`, `listen_waits_active`; per call `metrics` (agent p50/p95 latency, stt/tts ms) shown in the panel; weekly digest in the ledger CSV.
- Failure lines reuse `usecases/failure.rs` (`kind: provider: reason`) for PBX refusals (`permanent: netgsm: Netsantral refused the originate: …`); bridge errors use provider key `bridge`.
- Tests (TDD, named in the plan): domain state machine and timers (scripted clock, every `EndCause`), fence matrix (purpose × consent × suppression × journey × hours × cap × budget), use-case tests with a fake bridge queue (`jt_testkit/src/fakes/calls.rs`), `jt_pg` storage + RLS exact-set, MCP long-poll returns `timed_out` within `wait_s + 1`, bridge route idempotency and lease re-delivery, panel component tests; a contract test replaying a recorded bridge event sequence (`tests/fixtures/voice/outbound_happy.json`, `agent_silent.json`, `caller_hangup.json`, `inbound_voicemail.json`). The sidecar has its own tests against a mock Jeeta.

## 13. Decisions needed from the owner

1. **Gate V1**: approve the one-hour software-extension test on the Contabo host (free). If refused by NetGSM, approve SIP Trunk (1.035 TL/mo) as fallback.
2. **Sidecar host**: same Contabo VM (needs ~2 extra vCPU + 2 GB for Vosk+Piper; 4 vCPU/8 GB if faster-whisper) or a separate small VPS.
3. **Disclosure sentence** (default proposed: "Merhaba, ben {workspace}’in dijital asistanıyım.") mandatory in every agent-mode opening; only a human can turn it off.
4. **Start engines**: self-hosted Vosk+Piper (free, moderate) vs. a cloud STT/TTS key in the bridge (quality, a bill, still no LLM).
5. **Service-call rule** (§8.4): accept "existing relationship = Won journey, appointment/quote in 180 days, or open appointment" as the non-commercial exception; otherwise all agent calls require explicit ARAMA consent.
6. **Default `calls.place` approval**: `requires_human_approval` off (agent dials freely within gates) or on (human approves each planned call in the panel) for the first month.

## 14. What the owner must buy or enable (checklist)

- [ ] **V0 (now, free)**: Netsantral portal → API user (the `netgsm_pbx` credential; already accepted live) → add the server's public IP to the account's allowed IPs (needed for `/netsantral/report` CDR). Register the `events` callback URL from `jeeta.connector.hooks` under Netsantral → Entegrasyon → Çağrı olayları (if not yet).
- [ ] **V1 (free unless refused)**: Netsantral → Dahililer → 101 → note SIP server/user/password; portal call flow routes inbound to 101 (or a queue with 101 as member); run Gate V1.
- [ ] **V1 host**: CPU/RAM for the sidecar; outbound UDP 5060 + RTP range open from the host.
- [ ] **If Gate V1 fails**: "SIP Trunk" add-on (1.035 TL/mo) + outbound permission request.
- [ ] **V3 optional**: a cloud STT/TTS key (Deepgram/Azure/Google) configured in the sidecar; NetGSM "Görüşme Kaydı" (289 TL/mo) only if PBX-side recordings are wanted in the portal too (bridge-side recording is free).
- [ ] **Not needed**: Özel API (933 TL/mo), "Yapay Zeka" module (325 TL/mo), "Çağrı Analizi" (289 TL/mo), VAPI/Retell/ElevenLabs, any OpenAI/Anthropic key.
- [ ] **Option B only (not recommended)**: OpenAI key with Realtime access + SIP Trunk.

## 15. What cannot work (honest)

- **Sub-second conversational latency with the connected agent as the brain.** Physically bounded by the agent's own turn time; nothing in Jeeta can make Claude Code answer in 800 ms. Expect 5–12 s silences covered by holding phrases.
- **Inbound calls answered live when no agent is on duty.** The server cannot wake an agent (rule 3). Voicemail + callback is the only honest behaviour.
- **An agent that disconnects mid-call cannot be replaced.** The script ends the call politely; the customer is called back.
- **Natural barge-in with instant re-planning.** The bridge can stop speaking instantly, but the agent's new sentence still takes seconds.
- **Several simultaneous agent calls per agent.** One agent session is sequential; parallel calls need parallel agent sessions (each with its own API key) — supported by design, but it is the owner's agent capacity.
- **Accurate Turkish names/addresses with the free engines.** Vosk-small mishears; the agent must confirm by reading back (and can ask for DTMF for numbers).
- **Commercial cold calls without İYS ARAMA consent.** Refused by the fence; no override.
- **NetGSM-side TTS "say" into an arbitrary call.** The Özel API robot only speaks inside its IVR flow; this is why the bridge owns TTS.
- **Recording without the announcement.** Refused by policy; the bridge starts recording only after `said{announcement}`.
