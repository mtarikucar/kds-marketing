# NetGSM Phase 5 — Voice Campaigns + Auto-Dialer + Dynamic IVR + Callback

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** A new VOICE campaign channel (TTS/audio blasts with press-1 → workflow triggers), a native parallel auto-dialer (`autocallservice`), personalized dynamic IVR (caller-identified greeting + owner-rep routing), and a callback widget — all İYS-gated for commercial use, behind a new `voiceCampaigns` feature key.

**Architecture:** Voice campaigns extend the existing `Campaign`/`CampaignSenderService` with a VOICE branch that sends via a new `voicesms-send` hub client (`/voicesms/send`, `/voicesms/upload`, `/voicesms/edit`) and receives outcomes on a public voice-report webhook (voice DOES push, unlike SMS). The auto-dialer is an `autocall` hub client + a parallel-dialer service streaming the CRM lead queue into a NetGSM dynamic list, with a per-attempt webhook. Dynamic IVR extends the existing `NetgsmIvrService` (already an Özel-API consumer doing `arayan_no` lookup + `result:'dynamic'`+redirect) with lead personalization + configurable menu. Callback uses `NetsantralClient.dynamicRedirect`. Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md` §3 Phase 5.

**Tech Stack:** NestJS 11, Prisma (reversible migrations), Jest 29 (`--testPathPattern`, SINGULAR), React + vitest, i18next TR+inline-EN. Reuses Phase-2 İYS (`iysfilter`, brandCode, hard-block), Phase-3 event/webhook pattern, Phase-1 campaign-sender machinery, the outbox/workflow-trigger service.

## Global Constraints

- No AI markers in any commit. Migrations: migration.sql + down.sql, idempotent, scratch-DB round-trip.
- New `voiceCampaigns` feature key follows the tripwire chain (FEATURE_KEYS + every seed-packages block + tripwire spec + the activatedModules backfill if TOGGLEABLE + frontend FeatureKey/nav/MODULE_META + i18n). Owner decision: `voiceCampaigns` on SCALE/OPERATOR plans + purchasable add-on.
- İYS: commercial (TİCARİ) voice campaigns MUST pass `iysfilter` (0/11/12) + a preflight like Phase-2 SMS (ARAMA consent this time, not MESAJ) — voice consent type is ARAMA. Fail-closed for TİCARİ when İYS unreachable (owner decision). Voice campaigns are consent-gated the same way.
- Public webhooks (voice-report, autocall-report) ride the Phase-0 unified receiver + HMAC-token-in-URL + `@SkipThrottle` + dedupe. Never log creds.
- Jest 29 SINGULAR; FOREGROUND; stage exact paths; scrub creds from client error logs (the Phase-4/5 client convention).
- Branch: `feat/netgsm-voice-campaigns` off the Phase-4 tip (`feat/netgsm-recordings`). Stack: #131→…→#138→this.
- Auto-dialer + voice packages are PAID NetGSM add-ons (error 60 / feature-not-enabled without) — surface on the onboarding checklist; the code degrades gracefully.

## Key NetGSM facts (researched — do not re-research)

- Voice send: POST `/voicesms/send` (JSON) — `msg` (built-in Turkish TTS text) OR `audioid` (an uploaded .wav id); `scenario.series` + `keys[]` for DTMF branch capture (press-1 etc.); `iysfilter` (0/11/12) + brandcode for commercial; `relationid` = our CampaignRecipient id (echoed on the report); `url` = our voice-report webhook. `/voicesms/upload` = multipart .wav ≤4MB → returns an `audioid`. `/voicesms/edit` = cancel a pending voice job.
- Voice report webhook (voice PUSHES, unlike SMS): per-call `durum`/state 1/2/3/7, `bilsec` talk seconds, `push_button` (the DTMF the callee pressed), `record_link`. Correlate by `relationid`.
- Auto-dialer: `/autocallservice` — `addautocall` (a 'Devamlı Dinamik' dynamic list; `destination_type=queue`; `iysfilter` mandatory; `retry_count`; per-day time windows; `url`=attempt webhook), `addnumber`/`deletenumber` (stream the CRM queue in/out), `updateliststatus` (start/stop), `reportautocall` (reconcile); per-attempt webhook `{JobID, called, unique_id, status}`. 10 req/min per account. Needs a configured queue with logged-in agents + the Otomatik Arama add-on.
- Dynamic IVR: the Özel-API consumer already exists (`netgsm-ivr.controller`/`service`, POST `/public/telephony/netgsm-ivr/:token`); `result:'dynamic'` + `redirect` routes to a dahili/queue; `data` is the TTS response. Menu functions are defined per-tenant in the Netsantral portal (manual); our consumer supplies the dynamic `data`/redirect.
- Callback: `NetsantralClient.dynamicRedirect` (GET on crmsntrl host: `dynamic_redirect` with `redirect_menu` + `redirect_type=queue|ivr|announcement`); İYS filter param MANDATORY (brandcode when commercial); named queue/IVR/announcement objects must pre-exist in the portal.

---

### Task 0: Branch
- [ ] `git checkout -b feat/netgsm-voice-campaigns` from feat/netgsm-recordings tip. Verify.

### Task 1: `voicesms-send` client + `voiceCampaigns` feature key
**Files:** create `backend/src/modules/netgsm/voice/voicesms-send.client.ts` (+spec) — `send(creds, req)`, `upload(creds, wavBuffer, name)` (multipart → audioid), `cancel(creds, jobid)` (`/voicesms/edit`); mirror the hub client transport + creds-scrub-in-catch + tolerant parse; register. Add `voiceCampaigns` to FEATURE_KEYS + every seed-packages block (SCALE/OPERATOR true, others false; add-on grant) + tripwire spec + activatedModules backfill (if TOGGLEABLE — decide like Phase-1 `sms` vs `smsOtp`: this is a plan-tier + add-on feature, so TOGGLEABLE with a backfill, OR add-on-only-excluded like smsOtp — pick per owner decision "SCALE+ plus add-on" = it IS in some plans so TOGGLEABLE + backfill) + frontend FeatureKey/nav/MODULE_META/i18n.
Tests: client send/upload/cancel (fixtures + scrub); tripwire green; backfill round-trip if added. Commit `feat(netgsm): voice-send client + voiceCampaigns feature key`.

### Task 2: Campaign VOICE channel + send branch
**Files:** migration `20260709180000_campaign_voice` — Campaign + `voiceConfig Json?` (TTS text|audioid, keys[] DTMF map, retry); CampaignRecipient + `voiceState String?`, `pushButton String?`, `talkSec Int?` (voice outcomes); campaigns.service + dto (create/validate a VOICE campaign: channel VOICE, voiceConfig required, iysMessageType applies); campaign-sender.service — a VOICE branch in batch() (parallel to the SMS branch): for eligible recipients, `voicesms-send.send` per recipient (or the batch shape voicesms supports — check: voicesms/send may take a list; if per-recipient, loop with the 50/60s throttle) with `msg|audioid` from voiceConfig, `iysfilter` (11 for TİCARİ else 0) + brandcode, `relationid`=recipient.id, `url`=voice-report webhook; İYS ARAMA preflight for TİCARİ (mirror Phase-2's MESAJ preflight but consent type ARAMA — reuse IysClient.search with type ARAMA; fail-closed on unreachable); recipient DNC/opt-out recheck (voice opt-out — is there a separate call-opt-out? use the SMS/marketing opt-out or add a call one — check ComplianceService; ARAMA consent maps to a call-opt-out — reuse the marketing opt-out lead flag for now, note it).
Round-trip migration. Tests: VOICE campaign create+validate; batch sends via voicesms with relationid + iysfilter; TİCARİ ARAMA preflight blocks RET; İYS-unreachable → fail-closed; BİLGİLENDİRME sends. Commit `feat(campaigns): VOICE channel — TTS/audio blasts via voicesms`.

### Task 3: Voice-report webhook + press-1 → workflow trigger
**Files:** extend the hub webhook receiver (add `voice-report` route, HMAC purpose 'voice-report', archive+dedupe+publish `marketing.voice.report.v1`); a consumer `voice-report.consumer.ts` → correlate by `relationid` (=CampaignRecipient.id, workspace-scoped) → write voiceState/pushButton/talkSec + roll campaign.stats; PRESS-1 → workflow trigger: when push_button matches a configured key (voiceConfig.keys), emit `marketing.voice.keypress.v1` {workspaceId, leadId, campaignId, key} and wire it into the workflow-trigger service (read workflow-trigger.service.ts + TRIGGER_EVENT_MAP; add a 'voice_keypress' trigger type so a workflow can react — e.g. 'pressed 1 → create task/transfer'); register the voice-report webhook URL on the voice campaign / a settings surface.
Tests: report webhook fans out + dedupes; consumer writes recipient outcomes by relationid; press-1 emits keypress event + triggers a workflow; unknown relationid skipped. Commit `feat(campaigns): voice-report webhook + press-1 workflow trigger`.

### Task 4: Audio upload + voice composer UI
**Files:** an endpoint `POST /marketing/campaigns/voice/audio` (multipart .wav ≤4MB → voicesms upload → returns audioid; guarded voiceCampaigns + campaigns); frontend campaign composer — a VOICE campaign type: TTS text input OR audio upload, a keypress→action mapping editor (key digit → label/action), İYS TİCARİ/BİLGİLENDİRME selector (reuse Phase-2). TR/EN. Gate on voiceCampaigns.
Tests: upload endpoint validates size/type + returns audioid; composer renders VOICE type + keypress editor; tsc+build. Commit `feat(campaigns): voice composer — TTS/audio + keypress mapping`.

### Task 5: Auto-dialer (parallel power dialer)
**Files:** `backend/src/modules/netgsm/voice/autocall.client.ts` (+spec) — `addAutocall`, `addNumber`, `deleteNumber`, `updateListStatus`, `reportAutocall` (10/min budget bucket 'autocall'; iysfilter mandatory; scrub creds); a parallel-dialer service (extend DialerService or a new autocall-dialer.service) — on 'parallel mode', create a session-bound dynamic autocall list (destination_type=queue, iysfilter, retry, time windows, url=attempt webhook), stream the DialerPage lead queue via addNumber (respecting lead DNC + İYS ARAMA), start via updateListStatus; the attempt webhook route (hub receiver purpose 'autocall-report') → correlate {JobID, called, unique_id} to leads → update the dialer session; stop via updateListStatus. DialerPage frontend — a 'parallel mode' toggle creating the session; document the paid add-on + queue-with-agents prerequisite. TR/EN.
Tests: client methods (fixtures+scrub+budget); parallel session creates list + streams numbers (DNC/İYS excluded) + starts; attempt webhook correlates; stop tears down. Commit `feat(telephony): autocall parallel power dialer`.

### Task 6: Dynamic IVR personalization + callback widget
**Files:** extend `netgsm-ivr.service.ts` — lookup lead by `arayan_no` (canonical phone match, workspace resolution from the IVR token) → personalized TTS `data` ('Merhaba <name> Bey/Hanım'); `result:'dynamic'`+`redirect` to the lead's OWNER rep dahili/phone or a priority queue when identified; menu states configurable on the VOICE channel `configPublic` (a small state machine: digit→{data, redirect} — not a visual builder); correlate the IVR `arama_id` to CDR/recording; surface the inbound IVR interactions in a rep-facing log (VoiceCall rows → merge toward the SalesCall INBOUND view from Phase 3, or a small inbound-IVR list). Callback widget: `NetsantralClient.dynamicRedirect` + an endpoint `POST /marketing/telephony/callback` ({phone, redirectType, redirectMenu}) guarded telephony (İYS filter mandatory; brandcode for commercial) + a funnel/webchat block "leave your number, we call you" (find the funnel block registry; add a callback block). TR/EN.
Tests: IVR personalizes a known caller + routes to owner rep; unknown caller → default menu; configurable menu states honored; callback endpoint calls dynamicRedirect with İYS filter; callback block renders. Commit `feat(telephony): dynamic IVR personalization + callback widget`.

### Task 7: Onboarding + phase verify + PR
- [ ] Onboarding rows: `voicePackage` (voice/autocall add-on active? — unknown, error-60 explainer), `voiceReportWebhook` (URL surfaced), `autocallQueue` (portal queue-with-agents reminder). i18n.
- [ ] FULL backend `npm test` gate (only pre-existing arch offenders). Backend build. Frontend tsc+build+`npm test`. Exact tallies.
- [ ] Migration inventory (each migration.sql + down.sql; round-trip).
- [ ] Push + `gh pr create --base feat/netgsm-recordings`. No AI markers.

## Self-review coverage (spec §3 Phase 5)
VOICE campaigns TTS/audio + press-1→workflow (T2/T3/T4) · autocall parallel dialer + attempt webhook (T5) · dynamic IVR personalization + owner-rep routing + configurable menu (T6) · callback widget (T6) · voiceCampaigns key (T1) · İYS ARAMA consent + iysfilter + fail-closed for commercial (T2). Live-smoke: voicesms/send + autocallservice + dynamic_redirect wire shapes; voice/autocall paid add-ons; İYS ARAMA registration.
