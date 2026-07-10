# NetGSM Phase 3 — Santral Live Events + Inbound Calls + Call Control

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Turn the Netsantral integration from outbound-only + poll into a live two-way phone system: consume santral call-event webhooks, create INBOUND/missed SalesCalls, screen-pop the rep on an incoming call, fix the webphone to auto-answer ONLY the originate ring-back, add in-call controls (hangup/transfer/hold/mute/DTMF), drive a live call-status pill, and enforce concurrency per-rep.

**Architecture:** The Phase-0 unified public receiver (`backend/src/modules/netgsm/webhooks/netgsm-events.controller.ts`, purpose `events`) already archives santral pushes + publishes to the outbox. This phase adds: an event NORMALIZER (raw santral scenario → typed domain event), a marketing-side CONSUMER that writes SalesCall rows + fires screen-pop, a per-workspace SSE `TelephonyStreamService` (mirror `ConversationStreamService`), webphone changes (SIP.js), and `NetsantralClient` control methods. The CDR poll stays as reconciliation. Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md` §3 Phase 3.

**Tech Stack:** NestJS 11, Prisma (reversible migrations), Jest 29 (`--testPathPattern`, SINGULAR), React + SIP.js + vitest, RxJS SSE, i18next TR+inline-EN.

## Global Constraints

- No AI markers in any commit (hard rule). Migrations: migration.sql + down.sql, idempotent, scratch-DB round-trip (never the real dev DB — recipe in prior task reports, `kds-marketing-postgres` container).
- Every `@RequiresFeature` controller wires `FeatureGuard` (tripwire enforces). Telephony surfaces gate on the existing `telephony` feature key (no new key this phase).
- Never log NetGSM credential-carrying URLs; scrub creds (NetsantralClient already does).
- The public santral webhook is unsigned → the Phase-0 HMAC-token-in-URL is the only guard; keep that. Add `@SkipThrottle()` (or a dedicated bucket) to the santral event route — NetGSM sends all tenants' events from a few IPs, so the global 300/min-per-IP throttle would 429 at volume (Phase-0 deferral).
- Jest 29 SINGULAR flag; FOREGROUND test runs; stage exact paths only.
- Branch: `feat/netgsm-santral-events` off the Phase-2 tip (`feat/netgsm-iys`). This stack is #131→#133→#136→this.

## Key santral-event facts (researched — do not re-research)

NetGSM Netsantral "URL'e Yönlendirme" pushes JSON events to the registered URL (registered manually in the portal; the URL is minted by `netgsmWebhookUrl(base, workspaceId, 'events')`, already surfaced on TelephonyCard). Scenario field (`scenario`/`durum`/`event`) values seen: `Inbound_call` (a call arrives at the santral), `Answer` (a leg answered), `Hangup` (a leg ended), and a CDR-style `cdr`/end-of-call record. Correlation fields (casing varies — parse tolerantly): `unique_id`/`uniqueid`, `crm_id` (echoed from originate/linkup — our SalesCall.id for outbound), `customer_num`/`arayan`/`caller`, `internal_num`/`aranan`/`dahili` (the rung extension), `yon`/`direction` (inbound/outbound), `sondurum`/`status`, `seskaydi`/`recording` (recording URL, consumed in Phase 4), `bilsec`/`billsec`/`duration`. asteriskId prefix quirk: some ids arrive as `sip8-<digits>` — normalize by stripping a `sip\d+-` prefix when correlating. Control endpoints on `crmsntrl.netgsm.com.tr:9111/<user>/<path>`: `hangup`, `xfer` (blind transfer), `atxfer` (attended), `muteaudio` — all take `unique_id` + creds in the query string (same GET+scrub pattern as originate/linkup); they need the LIVE unique_id, which only the event webhook provides.

---

### Task 0: Branch
- [ ] `git checkout -b feat/netgsm-santral-events` (from feat/netgsm-iys tip). Verify with `git branch --show-current`.

---

### Task 1: Santral event normalizer + typed domain events

**Files:**
- Create: `backend/src/modules/netgsm/webhooks/santral-event-normalizer.ts` (+spec)
- Modify: `backend/src/modules/netgsm/webhooks/netgsm-events.controller.ts` (the existing `events` route: after archive, normalize + publish typed events) (+spec)
- Modify: `backend/src/modules/marketing/events/marketing-event-types.ts` (add the event-name constants)

**Interfaces:**
- Produces: `normalizeSantralEvent(raw): SantralEvent | null` where `SantralEvent = { kind: 'inbound_call'|'answer'|'hangup'|'cdr'; uniqueId: string|null; crmId: string|null; customerNum: string|null; internalNum: string|null; direction: 'INBOUND'|'OUTBOUND'|null; status: string|null; recording: string|null; durationSec: number|null; raw: object }`. Normalizes id casing + strips `sip\d+-` prefix. Publishes `marketing.telephony.call_event.v1` with `{workspaceId, ...SantralEvent}` per event (one outbox append per archived-new event, mirroring the İYS fan-out idempotency: append keyed `${workspaceId}:santral:${uniqueId||digest}:${kind}`).

Steps: TDD — fixtures for each scenario (Inbound_call/Answer/Hangup/cdr, sip8-prefixed id, missing fields → null-safe). The controller's `events` route currently just archives; extend it to also normalize each element and `outbox.append` a typed event for NEW archived rows only (reuse the read-existing→insert-missing→publish-missing pattern the `iys` route already uses — factor a shared private helper if clean). Commit: `feat(netgsm): normalize santral call events + publish typed domain events`.

---

### Task 2: Telephony event consumer — INBOUND/missed SalesCalls + correlation

**Files:**
- Create: `backend/src/modules/marketing/telephony/telephony-event.consumer.ts` (+spec)
- Modify: `backend/src/modules/marketing/marketing.module.ts` (register)
- Migration (if needed): SalesCall already has direction/externalCallId/status; add `ringingAt DateTime?`, `answeredByUserId String?` only if not already present (Phase 0 added answeredByUserId per the spec §2.4 — CHECK schema first; skip the migration if present). If a column is missing, `20260709140000_salescall_inbound_fields` reversible.

**Interfaces:**
- Consumes: `marketing.telephony.call_event.v1` (DomainEventBus.on, dedupe on event.id).
- Behavior:
  - `hangup`/`cdr` for an OUTBOUND call: correlate by `crmId` (our SalesCall.id) FIRST, fall back to `uniqueId`→externalCallId, then last-10-digit within the window. Backfill `externalCallId`, stamp terminal status (CONNECTED when durationSec>0 / answered, NO_ANSWER/BUSY/FAILED from `status`), `endedAt`, `durationSec`, `recordingUrl` (from `recording`). Replaces the fragile poll-only correlation; the CDR poll stays as a reconciliation backstop (idempotent — don't double-write a call already terminal).
  - `inbound_call`/`cdr` with direction INBOUND: create (or upsert on uniqueId) an INBOUND SalesCall (workspaceId resolved from the webhook's :workspaceId — carried on the event; marketingUserId resolved from `internal_num`→MarketingUser.dahili, null if unmatched), status INITIATED/RINGING; lead lookup by `customer_num` (canonical phone match — reuse the Phase-2 `toLocalMsisdn`/`localMsisdnVariants` idiom via the shared util); mirror onto the lead timeline (LeadActivity type CALL) when linked. A `hangup` with no answer on an inbound call → status NO_ANSWER = **missed call**: create a follow-up (a ScheduledJob or a Task — check how leads create follow-up tasks; also emit an event a workflow can trigger on: `marketing.call.missed.v1`).
  - Idempotency: dedupe on event.id AND monotonic status guard (never regress CONNECTED→RINGING).
- Specs: outbound hangup correlates by crm_id + backfills externalCallId + stamps CONNECTED; inbound_call creates INBOUND row + lead link; missed (inbound hangup no-answer) → NO_ANSWER + missed event; out-of-order (hangup before answer) tolerated; duplicate event.id no-ops.

Commit: `feat(telephony): inbound + missed SalesCalls from santral events; crm_id correlation`.

---

### Task 3: Screen-pop SSE — TelephonyStreamService + endpoint

**Files:**
- Create: `backend/src/modules/marketing/telephony/telephony-stream.service.ts` (+spec) — per-workspace RxJS Subject, mirror `channels/conversation-stream.service.ts` EXACTLY (in-process, single-replica documented).
- Create/modify: a controller SSE route `GET /marketing/telephony/stream` guarded by the existing SSE token guard (`guards/sse-token.guard.ts` — read how conversations SSE authenticates; mirror) — streams events for the authenticated rep's workspace, filtered to events targeting THIS rep (by internal_num→their dahili).
- Modify: `telephony-event.consumer.ts` — on `inbound_call`, after lead lookup, push a `screen_pop` event `{customerNum, lead: {id,name,...}|null, salesCallId, internalNum}` onto the stream for that workspace (the frontend filters to the rep whose dahili === internalNum).

**Interfaces:**
- Produces: SSE event kinds `screen_pop` | `call_status` (call_status used by Task 6). `TelephonyStreamService.push(workspaceId, event)` + `forRep(workspaceId, dahili)` filtered observable.

Steps: TDD the service (push/subscribe/filter-by-dahili) + a light controller test. Frontend consumer lands in Task 4. Commit: `feat(telephony): per-workspace SSE stream for screen-pop + live status`.

---

### Task 4: Webphone inbound UX — ring-back-only auto-answer + ringing dialog

**Files:**
- Modify: `frontend/src/features/marketing/webphone/webphone.store.ts` — the delegate `onCallReceived` currently auto-answers EVERY inbound INVITE (privacy/mic hazard). Change: auto-answer ONLY when it correlates to a just-started OUTBOUND originate (the store initiated a `call()`/originate within the last ~30s → this INVITE is the ring-back); otherwise set status `ringing` + expose the incoming call to the UI (caller number from the INVITE, matched via the screen-pop SSE) for explicit accept/reject.
- Modify: `frontend/src/features/marketing/webphone/WebphoneHost.tsx` — subscribe to `GET /marketing/telephony/stream` (EventSource, SSE token); on `screen_pop` matching this rep, show a ringing dialog (caller number + matched lead name/link + Accept/Reject). Accept → `user.answer()` + navigate to the lead; Reject → decline the INVITE. Keep the originate ring-back path auto-answering silently.
- Modify: `webphone.store.test.ts` (+ any WebphoneHost test) — assert genuine inbound is NOT auto-answered; originate ring-back IS.

Steps: read the store fully first; the correlation flag is a store field set when `call()` fires, cleared on connect/hangup/timeout. TR/EN i18n for the dialog. Frontend tsc+build+vitest. Commit: `feat(webphone): screen-pop ringing dialog; auto-answer only the originate ring-back`.

---

### Task 5: In-call controls — NetsantralClient + webphone + endpoints

**Files:**
- Modify: `backend/src/modules/netgsm/santral/netsantral.client.ts` (+spec) — add `hangup(creds, uniqueId)`, `blindTransfer(creds, uniqueId, exten)` (xfer), `attendedTransfer(creds, uniqueId, exten)` (atxfer), `mute(creds, uniqueId, on)` (muteaudio) — same GET+scrub pattern; params unique_id + exten + creds.
- Create/modify: endpoints on `sales-call.controller.ts` (or a new telephony-control controller) — `POST /marketing/telephony/calls/:id/hangup|transfer|mute` behind `telephony` feature + `leads.write`; resolve the call's live `externalCallId`/uniqueId (from the event-populated SalesCall), call the client. Transfer body = target dahili (validate it's a teammate's MarketingUser.dahili in the workspace).
- Modify: webphone UI — hold/mute buttons (SIP.js `session.hold()`/mute via the store), a DTMF keypad (SIP.js `sendDTMF`), a transfer picker listing teammates' dahilis (fetch from a small endpoint or reuse the users list). Server-side hangup/transfer for bridge calls (no SIP leg) go through the new endpoints; SIP-side hold/mute/DTMF go through SIP.js directly.
- Specs: client methods (fixture + scrub); endpoints (guard + resolves uniqueId + calls client + 404 when call has no live id); webphone store hold/mute/DTMF unit coverage.

Commit: `feat(telephony): in-call control — hangup/transfer/hold/mute/DTMF`.

---

### Task 6: Live status pill + per-rep concurrency + throttle/CDR-note fixes

**Files:**
- Modify: `telephony-event.consumer.ts` — on `answer`/`hangup`, push a `call_status` SSE event (INITIATED→RINGING→CONNECTED→ENDED) for the call's rep.
- Modify: frontend CallsPage / webphone — a live status pill driven by the `call_status` SSE (reflects the real leg state, not just the local SIP state).
- Modify: `sales-call.service.ts` — the `maxConcurrentCalls` concurrency check is currently per-WORKSPACE; make it per-REP where the provider's maxConcurrentCalls>1 (netsantral=50) so one busy rep can't block another; keep per-workspace only for the single-line lite provider (maxConcurrentCalls=1). (Phase-0 finding.)
- Modify: the santral event route — add `@SkipThrottle()` (Phase-0 finding: NetGSM sends from a few IPs).
- Modify: `TelephonyCard.tsx` — the CDR-prod-only note logic (Phase-0 deferral: `testFetch` returns `{httpStatus}` even on a pre-auth error, so the note hides off-prod when the CDR leg actually failed auth). Fix: show the note whenever the CDR result carries a NetGSM error `code` (not just on transport failure).
- Specs: per-rep concurrency (rep A busy doesn't block rep B on netsantral; single-line lite still blocks); status pill transitions.

Commit: `feat(telephony): live call-status pill; per-rep concurrency; throttle + CDR-note fixes`.

---

### Task 7: Phase-3 verification + onboarding + PR

- [ ] Onboarding checklist: add `eventsWebhookReceiving` row — since NetGSM has no read-back, check whether any NetgsmWebhookEvent purpose=`events` row arrived in the last 7d for the workspace (→ ok "receiving events" else unknown "register the URL + place a test call"). Extend NetgsmOnboardingService + i18n.
- [ ] FULL backend `npm test` (gate) — only the pre-existing arch offenders (booking/workflows) may fail; confirm no telephony offender leaked. Backend build. Frontend tsc+build+`npm test` (only pre-existing AiStudioPage). Capture exact tallies.
- [ ] Migration inventory (if any added) — each migration.sql + down.sql; round-trip.
- [ ] Push + `gh pr create --base feat/netgsm-iys` — summarize the 7 tasks; no AI markers.

## Self-review coverage (spec §3 Phase 3)
Events webhook consumers (T1/T2) · INBOUND+missed SalesCalls + lead mirror + workflow trigger (T2) · screen-pop SSE (T3) · webphone ring-back-only auto-answer + ringing dialog (T4) · in-call controls hangup/xfer/hold/mute/DTMF (T5) · live status pill (T6) · crm_id correlation replacing last-10-digit (T2, poll stays reconciliation) · per-rep concurrency (T6) · Phase-0 deferrals folded in: throttle bucket + TelephonyCard CDR-note (T6), webhook live-receiving checklist (T7).
