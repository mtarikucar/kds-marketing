# Voice sidecar on the free path — design addendum

> Date: 2026-10-29 · Status: **design, owner decisions of 2026-10-29 applied** · Amends
> `2026-10-27-agent-voice-calls-design.md` (the "voice design") for plan task V1-T3.
> Companion plan: `docs/superpowers/plans/2026-10-29-voice-sidecar-free-path-plan.md`.
> Sources: `reports/Kendi sunucumuzda Türkçe sesli ajan.md` (the "self-hosted report", every engine
> choice below), `reports/Türkçe telefon sesli ajan pazarı.md` (the "market report", background),
> their notes under `research_notes/`, the owner's decisions of 2026-10-29 (V-1…V-5, the phrase set,
> the opening) and the Gate V1 results. The reports live in the main checkout
> (`D:\HDD\projects\kds-marketing\reports\`), not in this branch.
> Paths are relative to `rust/` unless prefixed `docs/`.

## 0. Decision in six lines

1. **The edge is Asterisk 22.11 (≥ 22.8) with `chan_websocket`**, registered to NetGSM as extension
   102 over SIP/UDP; it owns SIP, RTP, the jitter buffer and DTMF (self-hosted report, "SIP kenarını
   Asterisk'e bırakmak", owner V-3).
2. **The talker is a Rust worker, `jeeta-voice-bridge`** (`rust/bridge/voice/`): it speaks the
   V1-T1/T2 bridge protocol to the core unchanged in shape, runs each call's state machine (opening,
   turns, barge-in, acknowledgements, fillers, closing) and drives two local speech services.
3. **Engines are free and local**: `seda-v0.1` on sherpa-onnx with Silero VAD at 8 kHz and Smart
   Turn v3.2 (ears); EMA Lightning 1.1.2 at 8 kHz behind Antalia-2 Mini's normalizer and a brand
   respelling table (mouth). No cloud speech, no new server, no GPU (owner V-5).
4. **The bridge plays owner-authored phrases on its own** (acknowledgement at 0.6 s, filler at
   2.7 s, long wait at 8 s, "not heard", "still there", fault). It never composes a sentence: every
   text it plays is the plan's, the policy's or the agent's (owner V-4).
5. **The brain does not change.** The connected agent keeps its model and its reasoning (owner
   V-2). The only agent-side change is protocol: `calls.say` may wait for the caller's reply
   (`wait_reply_s`), one short sentence per `say` is encouraged, `say` still returns at once by
   default.
6. **Measure first.** Every caller turn carries a monotonic trace (end of speech → endpoint → STT
   final → delivered → `say` → first TTS chunk → first audio frame; local acknowledgement; barge-in),
   summarised as p50/p95 per call with the report's alert thresholds.

## 1. What changes relative to the 2026-10-27 design, and why

| Topic | 2026-10-27 design | Now | Why (source) |
|---|---|---|---|
| SIP/RTP edge | A software UA inside the sidecar (Go `sipgo`+`diago`, or Python `pjsua2`) as ext 101 | Asterisk 22.11 in Docker (`--network host`), ext **102**, UDP, `chan_websocket` + ARI | Mature NAT/keepalive/DTMF and native `FLUSH_MEDIA` / `MARK_MEDIA` barge-in primitives; diago is young, pjsua2 fights the GIL (self-hosted report, stack table). Ext 101 is WSS-only and must stay so for the v1 webphone (Gate V1). |
| Sidecar language | Go or Python, "implementer's choice" | Rust worker in the workspace (`jeeta-voice-bridge`), Python only for the two model servers | No cgo, no second core language; GPL Piper/Asterisk and the Python model code stay separate processes (self-hosted report, license map). |
| STT | Vosk `small-tr-0.3` (or faster-whisper) | `seda-v0.1` streaming Zipformer2 (Apache-2.0), beam 4 + LM, per-call hotwords | FLEURS-TR 11.52 % (≈ Whisper-small) at RTF ≈ 0.03/thread, final ≈ 40 ms after audio ends; Vosk TR has no published WER and is wideband-only; Whisper re-encodes 30 s windows, too slow on 2.0 GHz Broadwell (self-hosted report, "Vosk'un yerini…"). |
| End of turn | Fixed 0.6–0.8 s silence | Silero VAD (8 kHz, `stop 0.2 s`) → Smart Turn v3.2 (p ≥ 0.5) → forced STT final; fallback **1.5 s** (range 1.2–1.8 s) | Decision ≈ 250–300 ms after a complete turn instead of a fixed silence (self-hosted report, "Sıra 250 milisaniyede…"). Disagreements are logged by `endpoint_by`. |
| TTS | Piper `tr_TR-fahrettin/dfki-medium` | EMA Lightning 1.1.2 (`sample_rate=8000`, `seed=0`), sentence by sentence, process kept warm | Owner's blind phone test (V-1 result: "kesinlikle 2. ses"); dfki is CC BY-NC-SA, never on paid calls (self-hosted report, license map). |
| Normalisation | none | Brand respelling table (six entries, §10 decision record) then `antalia_mini.Antalia.normalize` | `normalizer-tr` 0.8.1 read "14:00'e" as "on dört iki nokta sıfır sıfır kesme e" in our test; Antalia's normaliser read "on dörde" (owner V-1 notes). The transcript keeps the agent's original text; normalisation is pronunciation only. |
| Waiting covered by | Plan holding phrases at 4 s and 10 s, fallback at 20 s (server timers) | Bridge-local acknowledgement 0.6 s, filler 2.7 s, long wait 8 s (owner-approved set in the policy); the server's holding timers stay as a backstop, its fallback lines and scripted ending are unchanged | 4 s/10 s is "too late to give the gain"; first sound drops below ~0.8 s independent of the brain (self-hosted report, "Algılanan gecikmeyi…"; Talker–Reasoner split). |
| Opening | The plan's opening, which must contain the disclosure sentence | Workspace opening (pre-synthesised, cached) → transcript notice → the plan's opening (e.g. "{Ad} ile mi görüşüyorum?"), all queued by the core on `answered` | Owner-approved opening (2026-10-29). The disclosure is in the workspace's own sentence, so every agent call discloses (D3) even if a plan forgets. |
| Recording | Optional bridge recording after an announcement | **Off.** No raw audio kept anywhere; transcript only | Owner 2026-10-29 ("no raw audio is kept, transcript only"); spec §8 step 8 already makes recording opt-in. |
| Brain | Connected agent, any model | Unchanged; **no** fast reasoning-off model | Owner V-2 ("hata yapabilir"). The report's step 1 is applied only in its model-neutral parts (say+listen merge, one sentence per `say`). |
| Core ↔ bridge transport | Long-poll ≤ 25 s | Unchanged; proven push-like by the kernel's in-process signals, measured on the box | `BridgeSignals` wakes a waiting poll on commit (test `utterance_wakes_listen_immediately` asserts < 600 ms, i.e. before the 1 s fallback tick); the report: a parked long-poll "is practically as fast as push; only measure it". |
| Line count | `max_calls` 1–8 | 1 | Netsantral Eko: 2 extensions, **1 external line** (Gate V1). |

What stays exactly as in the 2026-10-27 design: the session model, the fence (run twice, the second
time in the transaction that queues the dial), the turn log, the scripted ending, `every played text
is authored`, masking, the bridge key (`calls.bridge` alone), the heartbeat and health job, the
catalog rows, the panel pages. The 2026-10-27 §3.2 engine table and §10's sidecar language are
superseded by this addendum.

## 2. Topology on the Contabo host

```
 NetGSM sip5.netsantral.com ── SIP/UDP + RTP G.711 ──► jeeta-asterisk (Docker, --network host)
                                                         SIP :5070, RTP 40000–40099, ARI/HTTP 127.0.0.1:8188
                                                         │ ARI REST + events (/ari/events)
                                                         │ chan_websocket media (/media/<id>), 20 ms A-law, JSON control
                                                         ▼
 jeeta-voice-bridge (Rust, systemd, user jeeta-voice-bridge, egress loopback only)
   heartbeat 15 s ─┐  commands long-poll ─┐  events POST ─┐        ▲ unix WS            ▲ unix WS
                   ▼                      ▼               ▼        │                    │
        jeeta core 127.0.0.1:8091 (staging)  OR  127.0.0.1:8090 (prod)   jeeta-voice-listen      jeeta-voice-speak
        (one environment at a time: one extension)                       (Docker, --network none) (Docker, --network none)
                                                                         Silero VAD 8 kHz         respell → Antalia.normalize
                                                                         Smart Turn v3.2          → EMA Lightning 8 kHz
                                                                         seda-v0.1 (sherpa-onnx)
        ▲ MCP (unchanged)
        connected agent (Claude Code / Codex): the brain
```

- **No new server**; the voice stack shares the 6 vCPU / 11 GB box. CPU: listen `--cpus 1.5`,
  speak `--cpus 2`, both `--cpu-shares 2048` (twice a default neighbour's weight), worker
  `CPUWeight=200`. RAM: listen 1 GB, speak 2 GB, Asterisk 512 MB, worker 256 MB (self-hosted report:
  "Altı paylaşımlı vCPU tek hattı taşır"; the risk is neighbour-induced queueing, so p95 is the gate).
- **No network for the models**: both speech containers run `--network none`, models baked into the
  image at build (listen: pinned revisions; speak: EMA's weights by SHA-256, since EMA reads its
  repository's main and takes no revision); they talk to the worker over unix sockets in
  `/run/jeeta-voice/` (group `jeeta-voice`, mode 0660). Listen runs as uid 1501, speak as uid 1502,
  both in gid 1501, so the directory's sticky bit keeps each from removing the other's socket.
  Listen's socket sits in a directory of its own, `/run/jeeta-voice/listen` (0710, its user's), the
  only one its container mounts, so speak cannot bind that name while listen restarts and listen
  cannot reach speak's socket; the worker also checks each socket's peer uid (B3 review). Speak
  moves to a directory of its own with B5.
- **The worker reaches loopback only** (`IPAddressAllow=localhost`, `IPAddressDeny=any`): the core
  (`JEETA_BASE_URL=http://127.0.0.1:809x`, not the Cloudflare address, so no proxy hop), ARI and the
  sockets. It opens no listening socket.
- **One environment at a time.** One extension registers once; one worker serves one Jeeta.
  `/etc/jeeta-voice/bridge.env` is a symlink to `bridge.staging.env` or `bridge.prod.env`;
  `jeeta-voice-target staging|prod` switches it only when ARI shows no channel. The environment left
  behind sees its `voice_bridge` capability go stale and refuses agent calls `bridge_offline`, which
  is correct.
- **Secrets**: the extension's SIP secret lives only in
  `/etc/jeeta-voice/asterisk/secrets/pjsip_auth.conf` (0600, uid 1500, the container's asterisk
  user), copied from `/root/voicegate/p102` without being printed; the ARI password in
  `secrets/ari_users.conf` (0600) and in the bridge env files (0600 root, read by systemd); the
  bridge key in the env files. None is in the repo, a log or chat.
- **Firewall**: no new inbound rule, and a default-deny firewall is a precondition (plan task B1,
  Step 7: ufw active with `Default: deny (incoming)`, or an iptables INPUT policy of DROP; otherwise
  stop). Gate V1 showed conntrack admits NetGSM's replies, OPTIONS and INVITEs on the registered
  socket. RTP replies are admitted the same way once this host has sent RTP first. Asterisk does
  not do that on its own: since 22.9.0, chan_websocket generates no silence frames (ChangeLog
  22.9.0, "Remove silence generation and frame padding"), and `transmit_silence` covers only waits,
  not a bridged channel. So the worker's pacer (§3, Playback) writes a frame every 20 ms from
  `MEDIA_START`. ARI binds 127.0.0.1 only. If one-way audio is seen, the fallback rule is a UDP
  allow from NetGSM's media network to 40000–40099 (plan task B1, step "one-way audio").

## 3. The talker: one call's state machine

The core keeps the session's truth (turns, clock, fallback lines, closing, settlement). The talker
fills the gaps the core cannot fill fast enough, with text the policy already holds.

| Situation | Talker does | Timer (default) |
|---|---|---|
| Caller's turn ended (final transcript posted), no `say` yet | plays an **acknowledgement** ("Hı hı." / "Anladım." / "Tamam." / "Peki.", rotating) | 600 ms |
| still no `say` | plays a **filler** ("Bir saniye, hemen bakıyorum." / "Kontrol ediyorum, kısa bir an.") | 2 700 ms |
| still no `say` | plays the **long wait** ("Biraz daha zaman alıyor, beklediğiniz için teşekkürler.") | 8 000 ms |
| still no `say` | nothing more: the core's fallback line (20 s) and scripted closing take over | core |
| A `say`/`play` is already queued | skips the acknowledgement and fillers | — |
| Agent's sentence played, caller silent | **"Hâlâ orada mısınız?"** once; a line of the core (a holding line while the agent works on) ends that wait | 9 000 ms after the sentence ended (the core reports `caller_silence` at 6 s and closes at 15 s) |
| Caller spoke but STT gave no words | **"Sizi tam duyamadım, tekrar eder misiniz?"** when nothing else is due | immediate |
| Core unreachable ≥ 5 s during a live call | **fault** ("Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."), then hangs up, reports `error` when the core is back | 5 000 ms |

Rules: the acknowledgement, filler, long wait and "still there" never start within 1 s of the last
local phrase's end ("not heard" and the fault sentence answer an event and wait for no gap); none
of the first three plays while a turn of the caller is open (from its speech start to its final or
unheard words, its pauses included); a local phrase is always cuttable; a `say` that arrives while
a local phrase plays waits for it (an acknowledgement is about 0.5 s and a filler about 1.7 s, but
the long wait, 55 characters, about 3 s and the fault sentence, 77, longer still: B2's TIMING read
520 ms of audio for 8 characters, 1 640 ms for 28 and 2 840 ms for 53). Each local phrase is
reported as `phrase{set, index}`: the core appends a `holding` turn **with the policy's text** (the
bridge sends no text back) and counts a filler or long wait as the holding phrases of that wait, so
its own 4 s / 10 s holding timer does not play over them.

**Barge-in**: while anything plays, and for 400 ms after (the line's echo of the last sound), the
listener runs with an echo guard (Silero threshold 0.6, minimum speech 250 ms instead of 0.5 /
200 ms; at 32 ms chunks a guarded `speech_start` needs 256 ms of speech). A `speech_start` while an item with
`allow_barge_in` plays cuts it at once: `FLUSH_MEDIA`, the synthesis cancelled, the queue dropped;
the cut sentence is reported `said{seq, interrupted_at_char}` (characters heard, from the last
`MEDIA_MARK_PROCESSED` and the time since), every dropped one `said{seq, interrupted_at_char: 0}`.
Target ≤ 300 ms from the caller's onset to the last agent frame (report, roadmap step 5). A turn
whose final transcript is only backchannel ("hı hı", "evet", "tamam", …) after a cut is flagged in
the trace (false barge-in rate is measured, no resume in V1).

**Playback**: a text is split into sentences (abbreviations, decimals, clock times and ordinals
kept whole; a piece of fewer than three words joins the next, as the speak service cuts, both held
to one table), and each sentence is synthesised as one EMA stream. The next sentence is synthesised while
the current one plays, at most one ahead.

What reaches Asterisk is paced by the worker (plan B5 `media::Pacer`, B1 review), because since
22.9 chan_websocket sends nothing to the line when the worker writes nothing:
- One frame every 20 ms from `MEDIA_START` for the whole call: the queued audio's next frame, or a
  silence frame (0xD5 A-law, 0xFF μ-law) when the worker's own buffer is empty. This gives no
  dead-line feeling, keeps NAT and conntrack alive, and stops a carrier's RTP timeout.
- At most about 3 frames queued in Asterisk, so a barge-in's `FLUSH_MEDIA` drops at most 60 ms.
- Paused on `MEDIA_XOFF`, resumed on `MEDIA_XON`, and resumed at once after a flush.
- Whole 160-byte frames: a streamed chunk's remainder waits for the rest of its sentence, and the
  sentence's tail is padded with silence.
- `MARK_MEDIA` goes right after a sentence's last real frame. Silence frames carry no mark and do
  not count toward what the caller heard.

**Closing**: the core queues `play{clip: closing}` then `hangup`; the talker plays the closing to
its mark (the caller's speech does not cut it), waits 400 ms, then hangs up the channel (report:
drain + 300–500 ms before BYE). Once a hangup is asked for, or the fault sentence is queued, the
line is hung up as soon as nothing is left to play, whether the last item played to its end or
was cut; a second loss of the core changes nothing, and a closing already asked for is not
replaced by the fault sentence (B4 review).

## 4. Wire changes (the bridge protocol stays V1-T1/T2's)

The bridge's envelope types move from `jt_app::usecases::calls::bridge` to a new module
`jt_calls::wire` (re-exported under the same names), so the worker and the core compile against the
same structs, as the device bridge does with `jt_device_protocol`. `jt_calls` is already pure and
builds on Windows; no new protocol crate is needed. Additive changes only (no bridge was ever
deployed, so this is the first shipped shape):

- `Command::Dial` gains `script: DialScript { lines, phrases, hotwords }`: the policy sentences the
  core may queue on this call (workspace opening, transcript notice) and the phrase set, for
  pre-synthesis, and the STT hotwords (the plan's `hotwords` plus the workspace name).
- `CallPlan` gains `hotwords` (≤ 20 entries, 1–40 characters): words from the agent's context
  (names, products) the STT is biased toward on this call.
- `BridgeEvent` gains `phrase{set, index}` and `trace{trace}`.
- `CallPolicy` gains `opening_outbound`, `transcript_notice`, `closing` (all `Option`, `None` = the
  approved default; empty = none) and `phrases` (the approved set by default). Stored tolerant; no
  migration.
- `CallPlan.closing` becomes optional: left out, the core plays the policy's `closing` (by default
  the approved "Görüşmek üzere, iyi günler.", `jt_calls::CLOSING`) and refuses a plan that has none
  when the policy has none either.
- The session keeps the phrases dialled with it (`CallSession.phrases`, the dial's
  `script.phrases`); a `phrase` event is logged with that text, not the policy's at the time the
  event arrives, so an owner who edits the phrases during a live call cannot make the log record a
  sentence that was never played.
- `CallMetrics` gains `traces` and `agent_replies` (each ≤ 200; `agent_replies` is the core's latency per agent `say`, keyed by its `seq`); `calls.get`'s call view gains `latency` (p50/p95, with `transport`) and loses `phrases` (the dialled snapshot is the log's source, not part of the view).

Agent-facing (MCP and panel route `POST /api/calls/{id}/say`), backward compatible:

- `calls.say` gains `wait_reply_s` (0–25). Absent: returns `{call_id, seq, state}` at once, as
  today. Present: queues the sentence, then waits for the caller's next words (an utterance, a key,
  `caller_silence`, the hangup or the end) and returns them as `events` with `timed_out`, saving the
  agent one `calls.listen` inference per turn (report: 0.5–2 s per turn).
- Tool descriptions ask for **one short sentence per `say`** so the first one plays while the agent
  writes the next.
- No catalog row is added or changed (count stays 160).

**Push transport.** The kernel's `BridgeSignals` wakes the bridge's parked poll on the commit of a
`say`, and an agent's parked `listen`/`say` on the commit of an utterance; the worker always keeps
one poll outstanding and posts each event the moment it happens. The plan proves the hop on the box
with the trace. The bridge's trace names the agent `say` it timed (`reply_seq`, the `Say`'s `seq`);
the core records `(seq, latency)` for each `say` that ended a wait. Per caller turn, `core_round_ms`
(bridge: the core answered the utterance → the reply's `say` received) less the core's latency for
that `seq`, saturating at 0 (the two windows differ by the tail of the utterance POST), is the
transport overhead, and `latency.transport` is its p50/p95 over the call's turns; acceptance is
`transport.p95` ≤ 100 ms (not a difference of two percentiles, which can hide a slow hop). The match
is by `seq`, not by position: the core also records a latency for a key press or a fallback line,
and the bridge traces a last turn nobody answered, so the two lists differ in length. A reply that
follows a fallback line has its latency counted from the fallback, so that turn overstates the hop.
Only if the gate fails would a WebSocket push be designed (not in this plan).

## 5. Opening, disclosure, transcript notice

- Outbound: **"Merhaba, ben {İşletme}'nın dijital asistanıyım."** → **"Görüşmemiz hizmet kalitesi
  için yazıya dökülmektedir."** → the plan's opening, e.g. "{Ad} ile mi görüşüyorum?" (the agent
  writes it before dialing, so it is synthesised during ringing).
- Inbound (V2, not built here): "Merhaba, ben {İşletme}'nın dijital asistanıyım. Size nasıl yardımcı
  olabilirim?" then the notice; `greeting_inbound` defaults to it.
- The suffix: `jt_calls::genitive(name)` — Turkish vowel harmony on the last vowel of the name's
  last word (a ı → ın, e i → in, o u → un, ö ü → ün), buffer `n` after a final vowel; a vowel-less
  word is read by its letter names (`THY'nin`), a trailing number by its Turkish reading
  (`Studio 54'ün`). Jeeta'nın, Figurunica'nın, Atölye'nin, Ahmet'in. Pure and unit-tested. Beyond
  the harmony rule: a short whole-word table of words that TDK's Güncel Türkçe Sözlük shows with a
  front ending after a back vowel (kemal -li, saat -ti, kalp -bi, petrol -lü: Kemal, Saat, Hal,
  Kalp, Kontrol, Petrol, Metal, Final, ...; checked 2026-10-29, `bilal` and `nihal` being first
  names the dictionary does not list) and any word ending in "âl" take the front suffix
  (`Kemal'in`, `Kontrol'ün`, `İstiklâl'in`); a dotted acronym is read by its last letter's name (`A.Ş.'nin`,
  `T.C.'nin`); a trailing word of symbols ("☕", "-") is dropped and the words are joined by single
  spaces, so a newline never reaches the spoken sentence. Known limits: it follows the spelling, so
  an acronym that holds a vowel but has no dots (ABD, AKP, AVM, IBM) is read as a word (`ABD'ın`,
  where it is spoken "A-Be-De'nin"), numbers of more than 18 digits are not supported, and a foreign
  name pronounced otherwise ("Apple") has the same problem. So has a word the table lacks: a compound
  of a table word (Akpetrol), İclal (no dictionary entry) and global (listed without a front mark);
  emlak is listed with -kı, a back ending, and needs nothing. An owner whose name is read otherwise
  writes the opening by hand in the policy.
- Closing: the plan's `closing` is optional. Left out, the core plays the policy's `closing`
  (`None` = the approved "Görüşmek üzere, iyi günler.", `jt_calls::CLOSING`; empty = none, so every
  plan must then bring its own). It is the core's scripted ending, not one of the bridge's phrases.
- The templates are the owner's approved text; the server only inserts the workspace's own name.
  `calls.policy_get` returns the policy with these defaults filled in, so the owner sees and can edit
  the exact sentences; saving makes them explicit.
- The fence's disclosure check (D3) now reads the **spoken opening** (workspace opening + notice +
  plan opening). The default disclosure sentence is "ben {İşletme}'nın dijital asistanıyım", which
  the default workspace opening contains; only a person can turn `disclose_assistant` off (unchanged).
- Recording stays off: `recording_allowed` stays false on the bridge, the bridge has no recorder,
  and the notice says "yazıya dökülmektedir" (transcribed), which the owner should have a lawyer
  confirm (owner note, 2026-10-29).

## 6. Engines and their parameters

| Part | Choice | Parameters (start values, tuned on real calls) | Source |
|---|---|---|---|
| Inbound audio | Asterisk → 20 ms A-law (or μ-law per `MEDIA_START`) → PCM16 8 kHz in the worker | no denoiser, no AGC | report: RNNoise/DeepFilterNet hurt ASR |
| VAD | Silero VAD (the ONNX file inside the `silero-vad==6.2.3` wheel, hash-pinned as a model: the package itself requires torch) at 8 kHz, 256-sample chunks | threshold 0.5 (0.6 while playing and for 400 ms after: the line's echo), a started run and running speech continue down to 0.15 below it (Silero's neg_threshold), min speech 200 ms (250 while playing), stop 200 ms | report, "Sıra…"; B3 |
| Turn end | Smart Turn v3.2 (`smart-turn-v3.2-cpu.onnx`, int8, BSD-2), last ≤ 8 s at 16 kHz from 500 ms before the onset; its Whisper features in numpy (no transformers, as Pipecat) | complete if p ≥ 0.5; else fallback 1 500 ms of silence; while the words end in numbers being read out only 2 800 ms of silence ends the turn, a "complete" not taken; a turn is cut at 30 s | report; B3 |
| Resample | soxr HQ 8 → 16 kHz, streaming | — | report |
| STT | `atasoglu/seda-v0.1` on `sherpa-onnx==2.0.1`, `modified_beam_search`, 4 active paths, RNN LM with LODR | `num_threads=1`; LM 0.6 with LODR −0.5 (the card's and sedalib's scales; in B3 the lowest WER on 30 loopback sentences: 5.2 % against 8.7 % without an LM); a turn decoded in segments cut at its pauses, each beside Smart Turn; hotwords score 1.5, cleaned Turkish words cut by sherpa-onnx (`modeling_unit` bpe) over a Zipf-scored vocabulary from `tokens.txt` | report, seda card, B3 |
| TTS | `ema-lightning==1.1.2`, `stream(text, sample_rate=8000, seed=0)` | torch 2 threads, batch 2 (the size EMA measured for itself in the owner-tested image); one EMA instance per concurrent synthesis (2), since an instance batches its streams and a batched stream's audio differs in its last bits from the same sentence alone; the speak service's `hello` names the voice id the worker keys its cache by | owner V-1; B2 review |
| Normaliser | respell table → `antalia_mini.Antalia.normalize` (`antalia-mini==1.0.1`) | startup self-test: "14:00'e" must read "on dörde" | owner V-1 notes |
| Phrase cache | PCM16 8 kHz; **disk** only for policy texts (openings, notice, phrase set); per-call **memory** for plan and agent sentences, dropped at hang-up | key = SHA-256(voice id ‖ text) | report, "ön sentez"; privacy (agent sentences can hold personal data) |

## 7. Measurement

`jt_calls::TurnTrace`, one per caller turn, every field a millisecond offset from the caller's end
of speech (the last voiced frame) except `barge_in_stop_ms`, a duration from the caller's onset,
measured on the worker's monotonic clock (the listener reports
positions in audio time, which the worker maps to the instants it forwarded those frames):
`endpoint_ms`, `endpoint_by` (smart_turn | fallback), `stt_final_ms`, `delivered_ms` (the core
answered the utterance POST), `say_ms` (the reply's first `say`/`play` received), `tts_first_ms`,
`reply_seq` (the `seq` of the agent `say` that `say_ms` timed), `first_audio_ms` (first reply frame written to Asterisk), `ack_ms` (first frame of a local phrase),
`barge_in_stop_ms` (caller onset → `FLUSH_MEDIA`, when the reply was cut).

Derived: perceived = min(ack, first audio); content = first audio; core round = say − delivered;
agent (core-side) = `CallMetrics.agent_latency_ms`; transport = per turn, core round less the core's latency for the `say` `reply_seq` names, matched by `seq`. `jt_calls::summarize` gives n/p50/p95 (nearest
rank) per measure and alerts: **perceived p95 > 1.0 s, content p95 > 3.0 s** (the report's
thresholds), barge-in stop p95 > 300 ms (the report's step-5 target). Where they show: `calls.get`
(`call.latency`), the panel's call page, and `jeeta-voice-bridge report` over the worker's own
`traces.jsonl` (numbers and call ids only).

Expected with a reasoning-on agent: perceived ≈ 0.6–0.9 s (the acknowledgement), content dominated
by the brain (the report's 3–10 s), so the content alert is expected to fire; that is the honest
number the owner chose by keeping the brain (V-2).

## 8. Privacy and logging

The worker logs call ids, kinds, states, counts, durations and errors' kinds; never a phone number,
a transcript, a sentence, audio, an audio path that holds a number, the key or a password; an HTTP
error is logged without its URL. Asterisk's console is `warning,error` only (verbose dialplan lines
carry numbers). The speech services log startup, errors and counts (listen: a call's turns and seconds), never a word, a hotword or audio. The trace file holds numbers and
call ids. No raw audio is written anywhere except the policy-phrase cache (owner/approved text, no
personal data). The core keeps what spec §9 says: turns (transcript), sessions, metrics.

## 9. Inbound

Gate V1 never saw 0850 → 102 reach the UA. The plan keeps an investigation task (route 0850 to 102
for a test, `Stasis(jeeta-voice,in)` in Asterisk, the worker reports `inbound` and hangs up busy since
duty mode is V2) that does not block anything else.

## 10. Risks and open questions

1. **Telephone-band accuracy is unmeasured** for seda and Smart Turn (8 kHz upsampled); expect
   roughly double the read-speech WER; names and numbers need read-back by the agent (report).
2. **Hotwords** need the model's BPE pieces; seda ships `tokens.txt` but no `bpe.model`, so the
   listener has sherpa-onnx cut them over a vocabulary it scores from `tokens.txt`'s ranks, and
   falls back to no hotwords when sherpa-onnx refuses them. Measured in B3 on synthetic speech: the
   cut agrees with the model's own pieces on 40 of 40 words, and the boost recovered 2 of 3 names
   (the two seda splits into words; a short, confusable one it did not). A name spelled other than
   it sounds (Jeeta, said "Cita") is boosted in its written spelling, which the model is unlikely
   to produce: the agent should pass such names as they are said. Real calls decide the gain.
3. **Neighbour load** on the shared box: p95, not mean, is the gate; CPU shares are raised for the
   voice containers. On the box at `--cpus 1.5` the frame that ends a turn took 241-416 ms (B3,
   synthetic speech): fine for now; listen's `--cpus` may go to 2 if B7's traces show its endpoint
   in the p95.
4. **EMA naturalness on edge cases** (weeks-old synthetic-data model) and its card's request for
   human review of banking/health/legal messages (the D3 disclosure covers AI disclosure).
5. **Inbound unknown** (above). **One line**: a second simultaneous call is refused `bridge_busy`.
6. **Minutes**: about 95 minutes of the NetGSM package remain (valid to 28.11.2026); the plan uses
   ≈ 15.
7. Open for the owner: the transcript notice text (lawyer) and which staging workspace hosts the
   test calls. (The brand respelling entries are decided: record below.)
8. **Digits wait.** While the words end in numbers being read out, Smart Turn's "complete" is not
   taken and only 2.8 s of silence ends the turn, so a phone number read in groups is one turn. An
   answer that ends in two number words ("saat on dört") waits as long. The agent reading a number
   back stays the second line of defence; `LISTEN_DIGITS_FALLBACK_MS` (2.5-3 s) is the knob.
9. **Synthetic test speech.** Every listen measurement so far is the speak voice through A-law: each
   piece of a fixture sounds finished, so Smart Turn ended sentences at their inner pauses there.
   Real callers' pauses, accuracy and barge-in (256 ms of speech needed while the bridge plays,
   against the 300 ms alert) are B7's to measure.

### Decision record: the brand respelling table (2026-10-29)

Owner-approved on 2026-10-29, relayed by the coordinator: six entries, in
`rust/bridge/voice/speech/speak/respell.json` and pinned by its test.

| Written | Spoken as | Why |
|---|---|---|
| Jeeta | Cita | Antalia keeps "jeeta", which EMA would read letter by letter by Turkish spelling |
| WhatsApp | vatsap | Antalia keeps "whatsapp" (its lexicon maps it to itself, tuned for its own voice) |
| Instagram | instagram | case only: Antalia 1.0.1 already lowercases it; kept as listed, so the reading holds if the normaliser changes |
| Facebook | feysbuk | Antalia keeps "facebook" |
| TikTok | tiktok | case only, as Instagram |
| Google | gugıl | Antalia keeps "google" |

Each spelling was run through antalia-mini 1.0.1 and normalizer-tr 0.8.1 (EMA's own frontend) and
reaches EMA's model text unchanged; the speak service's start-up self-test checks this on every
start. How each sounds is judged by the owner on the phone (B7).
