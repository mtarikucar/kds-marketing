# NetGSM Phase 6 — Fax + WhatsApp OTP + Netasistan (niche/final)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** The three remaining niche NetGSM surfaces — fax (send from a lead/conversation + inbound fax into the inbox), WhatsApp OTP as an alternate transport for the existing OTP flow, and Netasistan agent self-service (break/queue) synced with the Phase-4 presence toggle — completing the "everything in NetGSM's API" mandate. This is the final phase.

**Architecture:** Three independent hub clients: `fax.client` (`/fax/send` + `/fax/receive`), `whatsapp-otp.client` (whatsappapi.netgsm.com.tr fixed `netgsm_verify_code` template), `netasistan.client` (separate auth realm: app-key/user-key → 1h bearer). Fax inbound rides the MO-poll pattern (hourly cron → ConversationIngressService → FAX Message in the shared inbox). WhatsApp OTP folds into the existing `SmsOtpService` (Phase 1) as an alternate delivery transport (SMS→WhatsApp ordering). Netasistan extends the Phase-4 agent-presence toggle for tenants that also run Netasistan. Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md` §3 Phase 6.

**Tech Stack:** NestJS 11, Prisma (reversible migrations), Jest 29 (`--testPathPattern`, SINGULAR), React + vitest, i18next TR+inline-EN. Reuses the hub client transport + creds-scrub-in-catch, the MO-poll ingest pattern, the shared object storage (R2) + the recording-proxy tokened-stream pattern (for inbound fax PDFs), the Phase-4 agent presence.

## Global Constraints

- No AI markers in any commit. Migrations reversible (migration.sql + down.sql, idempotent, scratch-DB round-trip).
- New `fax` feature key follows the tripwire chain (FEATURE_KEYS + every seed block + tripwire pins + activatedModules backfill if TOGGLEABLE + frontend FeatureKey/nav/MODULE_META/i18n). Owner decision: `fax` OPERATOR plan + add-on. WhatsApp OTP rides the EXISTING `smsOtp` key (no new key — it's an OTP transport). Netasistan rides `telephony`.
- Never log creds; scrub in every client catch (the established convention).
- Inbound fax PDFs are documents — if served to the browser, use the tokened-proxy-stream pattern from Phase 4 (never a public bucket URL); or keep the NetGSM-tokened link (ephemeral) like voicemail. Pick and document.
- Jest 29 SINGULAR; FOREGROUND; stage exact paths.
- Branch: `feat/netgsm-fax-netasistan` off the Phase-5 tip (`feat/netgsm-voice-campaigns`). Stack: #131→…→#139→this.
- Fax + WhatsApp-OTP-package + Netasistan are PAID/separate NetGSM products — surface on the onboarding checklist; degrade gracefully when absent (error 60 / not-enabled).

## Key NetGSM facts (researched — do not re-research)

- Fax: two-step send — `/fax/send` (multipart: the document [PDF/TIFF] + recipient fax number + header) → a fax job id; `/fax/receive` poll → inbound fax rows with a document URL (sesdosya-style) + sender. Fax-enabled number required.
- WhatsApp OTP: `whatsappapi.netgsm.com.tr` — FIXED `netgsm_verify_code` Meta template only (no free-form messaging); params = the code + the recipient. Requires a paid "OTP WhatsApp" package + Meta template approval. Near-zero free-form value — this is purely an OTP transport.
- Netasistan: SEPARATE auth realm from the main API — app-key + user-key → a 1h bearer token; `PUT /break` (per-agent break with a reason) + `PUT /queue` (per-agent queue join/leave) are agent SELF-SERVICE (unlike the admin-level crmsntrl agentpause from Phase 4). 60 req/min global. Only for tenants that run Netasistan alongside the santral.

---

### Task 0: Branch
- [ ] `git checkout -b feat/netgsm-fax-netasistan` from feat/netgsm-voice-campaigns tip. Verify.

### Task 1: Fax client + send action + `fax` feature key
**Files:** create `backend/src/modules/netgsm/fax/fax.client.ts` (+spec) — `send(creds, {to, document: Buffer, filename, header?})` (multipart /fax/send → {ok, jobId, message}); `receive(creds, startdate, stopdate)` (/fax/receive, date-ranged, never parameterless → inbound rows {id, from, date, documentUrl}). Mirror the hub transport + creds-scrub + tolerant parse. Register. `fax` feature key: FEATURE_KEYS + seed (OPERATOR true, others false; add-on grant) + tripwire + activatedModules backfill (toggleable) + frontend FeatureKey/nav/MODULE_META/i18n. A send-fax endpoint `POST /marketing/fax/send` (multipart PDF ≤ a sane limit + magic-byte check %PDF; guarded fax feature + a send permission) → fax.client.send; a "send fax" action on the lead/conversation UI (minimal — a dialog: recipient fax number + file picker). TR/EN.
Round-trip backfill migration. Tests: client send/receive (fixtures+scrub); PDF magic-byte guard on the endpoint (reject non-PDF before NetGSM); tripwire green; backfill round-trip. Commit `feat(netgsm): fax client + send action + fax feature key`.

### Task 2: Inbound fax poll → inbox
**Files:** create `backend/src/modules/marketing/channels/netgsm-fax-poll.service.ts` (+spec): hourly advisory-locked cron ('netgsm-fax-poll'). Per fax-enabled workspace (creds from the SMS channel / a fax config — mirror the voicemail poll's enumeration + gating on the `fax` feature): fax.client.receive for a ≤24h date-ranged window (TR time via the shared fmtTr; NEVER parameterless); dedupe on 'netgsm-fax:<id>' (namespaced like MO/voicemail); missing → download the fax document → R2 (netgsm-fax/<ws>/<id>-<random>.pdf via uploadToKey, random segment like Phase-4 recordings) OR keep the NetGSM link (pick per the Global Constraints — if R2, a tokened proxy route like recordings; if the NetGSM link is short-lived, keep it like voicemail — document); ingest as an inbound FAX Message via ConversationIngressService (the document as an attachment/link). Never throw. Gate on the inbox (conversationAi) feature. TR/EN inbox label for FAX.
Tests: poller dedupes ('netgsm-fax:<id>'), ingests a NEW fax as a FAX Message + stores/links the doc, skips seen, never parameterless, download-failure never throws. Commit `feat(channels): inbound fax poll into the inbox`.

### Task 3: WhatsApp OTP transport
**Files:** create `backend/src/modules/netgsm/whatsapp/whatsapp-otp.client.ts` (+spec) — `sendVerifyCode(creds, {to, code})` (whatsappapi.netgsm.com.tr netgsm_verify_code template; creds-scrub; tolerant parse); register. Fold into the EXISTING SmsOtpService (Phase 1 — backend/src/modules/marketing/services/sms-otp.service.ts): an alternate delivery transport. Read how issue() sends the SMS code; add a transport preference (SMS default, WhatsApp when configured/requested) with SMS→WhatsApp ordering/fallback (try the preferred, fall back to SMS on WhatsApp-package-absent/error). The OTP code generation/hash/verify (Phase-1 hardened) is UNCHANGED — only the delivery channel differs. Ride the EXISTING smsOtp key (no new key). Surface a per-workspace transport preference (config) + note the paid OTP-WhatsApp package prerequisite. Keep the Phase-1 OTP security (HMAC-pepper, atomic attempts, phone-bind, issuance cap) intact — do NOT weaken.
Tests: WhatsApp transport sends via the client when preferred; falls back to SMS on WhatsApp error/absent; the code hash/verify path unchanged (Phase-1 tests still green); no new OTP security regression. Commit `feat(auth): WhatsApp OTP delivery transport (netgsm_verify_code)`.

### Task 4: Netasistan agent self-service sync
**Files:** create `backend/src/modules/netgsm/netasistan/netasistan.client.ts` (+spec) — the SEPARATE auth realm: `authenticate(appKey, userKey)` → a 1h bearer (cache it per-workspace with expiry); `setBreak(token, agentId, reason)` (PUT /break); `setQueue(token, agentId, join:boolean, queueName)` (PUT /queue); 60/min budget bucket 'netasistan'; creds/token scrub. Register. Extend the Phase-4 agent-presence toggle (backend/src/modules/marketing/telephony agent presence endpoint/service): when a workspace has Netasistan configured (a per-rep opt-in + app-key/user-key sealed config on TelephonyCard) AND the rep opts into Netasistan, the available/break toggle ALSO calls Netasistan setBreak (in addition to / instead of the crmsntrl agentpause — the Netasistan path is per-agent self-service). A per-rep Netasistan opt-in + the workspace app-key/user-key config (sealed) on TelephonyCard. TR/EN. Reversible migration if a config column is needed (Netasistan keys on TelephonyConfig.configSealed or a new sealed field).
Tests: client auth caches the 1h token + re-auths on expiry; setBreak/setQueue (fixtures+scrub+budget); presence toggle also calls Netasistan when the rep opted in; token/creds never logged. Commit `feat(telephony): Netasistan agent self-service (break/queue) presence sync`.

### Task 5: Onboarding + phase verify + PR
- [ ] Onboarding rows: `faxNumber` ('unknown' — fax-enabled number required, portal), `whatsappOtpPackage` ('unknown' — paid OTP-WhatsApp package + Meta template approval), `netasistanKeys` ('ok' when app-key/user-key configured else 'unknown'). i18n.
- [ ] FULL backend `npm test` gate (only pre-existing arch offenders). Backend build. Frontend tsc+build+`npm test`. Exact tallies.
- [ ] Migration inventory (each migration.sql + down.sql; round-trip).
- [ ] Push + `gh pr create --base feat/netgsm-voice-campaigns`. No AI markers.
- [ ] Update memory: the WHOLE 7-phase program (Phases 0-6) is COMPLETE; all PRs stacked #131→…→this, UNMERGED (self-merge blocked); the descope items from the design (none — everything shipped) + the live-smoke checklist across all phases.

## Self-review coverage (spec §3 Phase 6)
Fax send + inbound poll → inbox (T1/T2) · WhatsApp OTP transport folded into the existing OTP flow, smsOtp key, Phase-1 security intact (T3) · Netasistan break/queue self-service synced with presence (T4) · `fax` key OPERATOR/add-on (T1). This COMPLETES the program — after this, every CRM-relevant NetGSM capability from the gap analysis is shipped. Live-smoke: fax/send + fax/receive + whatsappapi + netasistan wire shapes; fax number, OTP-WhatsApp package, Netasistan keys all paid/separate prerequisites.
