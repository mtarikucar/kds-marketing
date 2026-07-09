# NetGSM Phase 4 — Recording Pipeline + Queues + Inbound Stats + Voicemail

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Own call recordings end-to-end (record toggle → PBX flags → ingest → R2 → in-app player → AI analysis from the stored file with retention control), surface a live queue wallboard + agent presence, pull inbound call statistics into reports, and pull voicemails (telesekreter) into the inbox.

**Architecture:** Extends the Phase-3 telephony event pipeline. The record toggle lives on `TelephonyConfig`; `NetsantralClient` already accepts a `record` flag on `callBridge` (Phase-0) — wire it through `NetgsmApiAdapter`. A recording-ingest service downloads the NetGSM recording (`seskaydi` from the webhook / `recording` from CDR) via `&tomp3` into R2 (generalize `social-planner/r2-storage.service.ts` into a shared helper) and stamps `SalesCall.recordingStorageKey`; `CallAnalysisService` STT then reads the stable stored file. Queue/agent/stats/voicemail add hub clients (`NetsantralClient` queue+agent methods, a `/netsantral/statistics` client, a `voicesms.client`). Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md` §3 Phase 4.

**Tech Stack:** NestJS 11, Prisma (reversible migrations), Jest 29 (`--testPathPattern`, SINGULAR), React + vitest, Cloudflare R2 (S3 API), Deepgram/OpenAI STT (existing SttService), i18next TR+inline-EN.

## Global Constraints

- No AI markers in any commit. Migrations: migration.sql + down.sql, idempotent, scratch-DB round-trip (kds-marketing-postgres container, never the real dev DB).
- Every `@RequiresFeature` controller wires `FeatureGuard`. Telephony surfaces gate on `telephony`; voicemail rides the inbox (`conversationAi`) — confirm the right key per surface, no new key this phase.
- Never log credential-carrying NetGSM URLs; scrub creds. Recording download URLs are tokenized bearer links — treat as secrets, don't log.
- KVKV/KVKK: recording requires a caller announcement; the `recordCalls` toggle UI must carry that legal note. Recording is OFF by default.
- Jest 29 SINGULAR; FOREGROUND test runs; stage exact paths only.
- Branch: `feat/netgsm-recordings` off the Phase-3 tip (`feat/netgsm-santral-events`). Stack: #131→#133→#136→#137→this.
- R2 config env (already present for social-planner) gates the recording/voicemail storage; when unset, ingest degrades gracefully (keep the provider URL as fallback, log, don't crash) — mirror how social-planner handles a missing R2.

## Key NetGSM facts (researched — do not re-research)

- Recording flags: `caller_record=1`&`called_record=1` on `linkup`/`originate` (NetsantralClient.callBridge already takes `record`; add to originate). Recording appears on the call-event `seskaydi` field (instant, Phase-3 normalizer captures it as `recording`) and on the CDR `recording` field (reconciliation).
- Recording download/player: NetGSM serves recordings via a tokenized URL; append `&tomp3` to get an mp3; there's also a documented player iframe `https://dosyaindir.netgsm.com.tr/player/?tip=1&q=…&y=…`. We PROXY-download to R2 for retention/stability rather than depend on link longevity.
- Queue: `queuestats` (GET on crmsntrl host) → per-queue waiting/holdtime + per-agent state; only DYNAMIC queue members are API-manageable (static members added in the NetGSM UI are read-only); queue name format `{santral}-queue-{name}`.
- Agent: `agentlogin`/`agentlogoff`/`agentpause` (pause takes a reason) on the crmsntrl host.
- Inbound stats: `/netsantral/statistics` on api.netgsm.com.tr — mode 1 = daily aggregates (≤7-day window), mode 2 = per-call detail incl. recording links; 2 req/min; prod-IP allow-listed like `/netsantral/report`.
- Voicemail (telesekreter): `/voicesms/receive` — window ≤24h so poll at least hourly; returns voicemail rows with a `sesdosya.netgsm.com.tr` audio URL; 2 req/min.

---

### Task 0: Branch
- [ ] `git checkout -b feat/netgsm-recordings` from feat/netgsm-santral-events tip. Verify.

### Task 1: Shared R2 helper + recordCalls config + PBX record flags
**Files:** generalize `social-planner/r2-storage.service.ts` into a shared `common/storage/object-storage.service.ts` (or keep it and export a shared provider — check how it's module-scoped; the LEAST invasive is to move it to a shared module both social-planner and telephony import, preserving social-planner behavior byte-identical + its tests); migration `20260709170000_telephony_recording_config` — TelephonyConfig + `recordCalls Boolean @default(false)`, `recordingRetentionDays Int?`; SalesCall + `recordingStorageKey String?`; telephony-config.service + dto (expose recordCalls + retention on the config get/upsert); NetgsmApiAdapter (pass `record: config.recordCalls` into callBridge/originate — read how prepareOutboundCall builds the request; thread the flag from the resolved TelephonyConfig); TelephonyCard frontend (recordCalls toggle + retention field + the KVKK announcement note, TR/EN).
Round-trip migration. Tests: config upsert persists recordCalls/retention; adapter passes record flag when recordCalls true; social-planner R2 tests still green after the move. Commit `feat(telephony): call-recording toggle + PBX record flags + shared object storage`.

### Task 2: Recording ingest → R2 + retention
**Files:** create `backend/src/modules/marketing/telephony/recording-ingest.service.ts` (+spec) + register.
- Trigger: the Phase-3 telephony-event consumer stamps `SalesCall.recordingUrl` from the event `recording`/CDR. After a recordingUrl is stamped on a CONNECTED call AND the workspace has recordCalls on AND R2 is configured, ingest: download the NetGSM recording (append `&tomp3`), upload to R2 at `netgsm-recordings/<workspaceId>/<salesCallId>.mp3`, stamp `recordingStorageKey`, keep `recordingUrl` as the provider fallback. Do this via a small queue/cron (mirror an existing advisory-locked sweep: find CONNECTED calls with recordingUrl set + recordingStorageKey null + recordingCheckedAt watermark, bounded per tick) OR react inline from the consumer with a best-effort catch — pick the sweep (decouples from the hot event path; reuse the recordingCheckedAt watermark that already exists on SalesCall). Delete the dead speculative bits if any remain.
- Retention: an daily sweep deletes R2 objects + nulls recordingStorageKey for calls older than the workspace's recordingRetentionDays (skip when null = keep forever). Reversible? no schema — a cron.
Tests: ingest downloads+uploads+stamps key; skips when recordCalls off / R2 unconfigured (keeps provider url); retention deletes past-retention keys + nulls; watermark prevents re-download. Commit `feat(telephony): ingest call recordings into R2 with retention`.

### Task 3: In-app player + AI analysis from stored file
**Files:** a backend route `GET /marketing/telephony/calls/:id/recording` (guarded telephony + leads.read) that streams/redirects to a signed R2 URL when recordingStorageKey present, else the provider url (or the NetGSM player); CallsPage / CallAnalysisPanel frontend — an in-app `<audio>` player using that route (replaces the raw cross-origin tokenized `<a>`); CallAnalysisService — when recordingStorageKey is present, STT reads the STORED file (signed R2 url) so analysis doesn't depend on NetGSM link longevity (read call-analysis.service.ts: it currently does `stt.transcribeUrl(call.recordingUrl)` — prefer a signed storage url when the key exists).
Tests: the route returns a signed url for a stored recording, falls back for a not-yet-ingested one, 404 cross-workspace; CallAnalysis prefers the stored file. Commit `feat(telephony): in-app recording player + STT from stored file`.

### Task 4: Queue wallboard + agent presence
**Files:** NetsantralClient (+spec) — add `queueStats(creds, queueName?)`, `agentLogin/agentLogoff/agentPause(creds, dahili, reason?)` (GET+scrub on crmsntrl host); a telephony-queue.service + endpoints `GET /marketing/telephony/queues/stats` + `POST /marketing/telephony/agent/presence` ({state:'available'|'break', reason?}) guarded telephony; frontend CallsPage — a wallboard widget (calls waiting, holdtime, per-agent state) + a rep available/break toggle wired to agent presence. Document the dynamic-vs-static member caveat + queue name format in the settings/help copy. TR/EN.
Tests: client methods (fixture+scrub); queue-stats endpoint parses; presence toggle calls agentPause with reason; guard chain. Commit `feat(telephony): queue wallboard + agent presence`.

### Task 5: Inbound statistics dashboards
**Files:** a `netgsm-statistics.client.ts` in the hub (mode 1 daily ≤7d, mode 2 per-call; 2/min budget via AccountRateBudgeter 'statistics'; prod-IP allow-list caveat like CDR) (+spec); a reports endpoint + a small dashboard panel (answered/abandoned/avg-wait) on the marketing reports page (find the reports module + how existing report panels render; mirror). TR/EN.
Tests: client parses mode-1 aggregates + mode-2 detail tolerantly; budget denial; endpoint shape. Commit `feat(telephony): inbound call statistics dashboard`.

### Task 6: Voicemail (telesekreter) → inbox
**Files:** `voicesms.client.ts` in the hub — `receiveVoicemails(creds, startdate, stopdate)` (`/voicesms/receive`, ≤24h window, 2/min budget) (+spec); a voicemail-poll.service (hourly advisory-locked cron) → for each voicemail row, dedupe (namespaced id like MO poll), download the sesdosya audio → R2, create a Conversation/Message of type VOICEMAIL in the shared inbox (reuse ConversationIngressService like the MO push does — the audio as an attachment/link; optionally STT via SttService for a text preview); surface in the inbox. Gate on the inbox feature. TR/EN.
Tests: poller dedupes, ingests a new voicemail as a VOICEMAIL Message + R2 store, skips already-seen, budget denial, never the parameterless window. Commit `feat(telephony): voicemail (telesekreter) poll into the inbox`.

### Task 7: Onboarding + phase verify + PR
- [ ] Onboarding checklist rows: `recordingStorage` (R2 configured? recordCalls on? → ok/unknown), `recordingsReceiving` (any SalesCall.recordingStorageKey in the last 7d → ok else unknown). i18n.
- [ ] FULL backend `npm test` gate (only pre-existing arch offenders booking/workflows may fail; no telephony offender leaked). Backend build. Frontend tsc+build+`npm test` (only pre-existing AiStudioPage). Exact tallies.
- [ ] Migration inventory (migration.sql + down.sql each; round-trip).
- [ ] Push + `gh pr create --base feat/netgsm-santral-events`. No AI markers.

## Self-review coverage (spec §3 Phase 4)
recordCalls toggle + PBX flags + KVKK note (T1) · webhook seskaydi + CDR ingest → R2 → recordingStorageKey + retention (T2) · in-app player + STT from stored file (T3) · queue wallboard + dynamic/static caveat + agent presence (T4) · inbound statistics (T5) · voicemail poller → inbox (T6). Live-smoke items (real NetGSM acct): record-flag actually records; recording URL `&tomp3` shape; statistics/voicemail prod-IP allow-list.
