# NetGSM Full Integration — Design Spec

**Date:** 2026-07-08
**Status:** Approved (owner) — scope: everything, no exclusions
**Goal:** Close every gap between the CRM and NetGSM's full API surface. Every CRM-relevant NetGSM capability fully integrated, toggleable from settings, gated by plan entitlements/add-ons per the existing 4-layer gating model.

## 1. Context & audit summary

A 6-agent audit (2026-07-08) cross-referenced the codebase against NetGSM's complete official API catalog (docs at api.netgsm.com.tr, /dokuman/ + /netsantraldokuman/, official Postman collection).

**Already complete (do not redo):** 1:1 SMS send (legacy `/sms/send/get`), workflow `send_sms` step, MO inbound SMS push webhook (HMAC-token URL), click-to-call (linkup bridge + originate dahili + `tel:` fallback), webphone WSS SIP register + outbound dial, CDR poll (5-min cron), post-call AI analysis pipeline, Power Dialer (preview mode), bulk campaign SMS mechanics, settings/entitlement infrastructure.

**Gaps (23 capabilities + ~20 quality issues):** detailed per phase below.

### Owner decisions (2026-07-08)

| Decision | Choice |
|---|---|
| Scope | **Everything** — core + useful + niche (fax, WhatsApp OTP, Netasistan included) |
| İYS policy | **Full auto + hard-block**: every consent change pushed to İYS immediately; commercial campaign sends pre-flight `/iys/search` and hard-block RET recipients; İYS unreachable → commercial sends fail closed |
| Call recording | **Workspace toggle + copy to own storage (R2)**: record flags per workspace, recordings downloaded (`&tomp3`) into R2, in-app player, retention control, AI analysis reads stored file |
| Packaging | `sms` split into its own feature key; `voiceCampaigns` new key (SCALE+ plus add-on); İYS bundled free with `campaigns`; `smsOtp` add-on; `fax` OPERATOR/add-on; **settleSms wired now** (per-segment cost → SpendLedger) |
| Approach | **B) NetGSM hub refactor** — via strangler-fig (no big-bang); phased epics 0→6 |

## 2. Architecture — NetGSM Hub

New module `backend/src/modules/netgsm/` owns ALL NetGSM communication. Domain modules (channels, campaigns, telephony, compliance, workflows) keep business logic and consume hub clients via DI.

```
backend/src/modules/netgsm/
  netgsm.module.ts               # exports all clients; imported by marketing module
  core/
    netgsm-rest.client.ts        # Basic Auth (usercode:password) JSON client for api.netgsm.com.tr;
                                 # TLS mandatory; retry on 5xx/timeout/flood; password scrubbing in logs
    netgsm-credentials.service.ts# workspace → creds resolver. Reads EXISTING sealed stores only:
                                 # Channel.configSealed (SMS/İYS/voice/fax/balance/OTP — same usercode),
                                 # TelephonyConfig.configSealed (santral), MarketingUser.dahiliSecret.
                                 # No new credential table. Purpose-based resolution with fallback
                                 # (dedicated sub-user → shared account creds).
    netgsm-error.map.ts          # unified error vocabulary: legacy send codes (20/30/40/50/51/60/70/80/85),
                                 # REST v2 codes, santral codes (30 = bad creds OR IP-not-allowlisted),
                                 # İYS codes. Turkish user-facing messages per code.
    account-rate-budgeter.ts     # PER-ACCOUNT (usercode) budgets, not global:
                                 # report 60/min, İYS 10/min, autocall 10/min, stats 1/jobid/10min,
                                 # statistics+voicemail 2/min, blacklist 120 numbers/min.
  sms/
    sms-v2.client.ts             # /sms/rest/v2/: send (n:n messages[]), report (jobids[]≤50),
                                 # stats, cancel, inbox (date-ranged ONLY), msgheader, length, otp
    blacklist.client.ts          # /sms/blacklist XML {tip:1 add, tip:2 remove}; write-only (no read API)
  iys/
    iys.client.ts                # /iys/add (batch ≤500, async refid), /iys/search, /iys/webhook (register)
  santral/
    netsantral.client.ts         # MOVED from marketing/telephony + EXTENDED: originate, linkup (callBridge),
                                 # hangup, xfer, atxfer, muteaudio, dynamic_redirect, queuestats,
                                 # agentlogin/agentlogoff/agentpause. GET on crmsntrl.netgsm.com.tr:9111.
    netgsm-cdr.client.ts         # MOVED: /netsantral/report (poll) + /netsantral/statistics (mode 1&2)
  voice/
    voicesms.client.ts           # /voicesms/send (TTS text | audioid; scenario.series + keys[] DTMF;
                                 # iysfilter; relationid; url=report webhook), /voicesms/upload (.wav ≤4MB
                                 # multipart), /voicesms/edit (cancel), /voicesms/receive (telesekreter,
                                 # ≤24h window — poll at least hourly)
    autocall.client.ts           # /autocallservice: addautocall (dynamic list, destination_type=queue,
                                 # iysfilter, retry_count, time windows, url=attempt webhook),
                                 # addnumber/deletenumber, updateliststatus, reportautocall
  fax/
    fax.client.ts                # two-step multipart /fax/send + /fax/receive poll
  netasistan/
    netasistan.client.ts         # SEPARATE auth realm: app-key/user-key → 1h bearer; PUT /break, /queue
                                 # (agent self-service); 60 req/min global
  whatsapp/
    whatsapp-otp.client.ts       # whatsappapi.netgsm.com.tr — fixed netgsm_verify_code Meta template only
  balance/
    balance.client.ts            # POST /balance (stip=3 packages+credit); also the real credential
                                 # verification probe (disambiguates error 30 creds-vs-IP)
  webhooks/
    netgsm-events.controller.ts  # unified public receiver (see §2.3)
    netgsm-event-normalizer.ts   # raw payload → typed domain events
```

### 2.1 Strangler migration (no big-bang)

`NetsantralClient`, `netgsm-cdr.client`, `netgsm-send.util` move into the hub **without behavior change**. Old import paths re-export from the hub for one release; consumers (adapters/services) are updated in the same phase; re-exports then deleted. The working SMS/call flow is never interrupted. `channels/adapters/netgsm-sms.adapter.ts` remains a ChannelAdapter (the channel abstraction covers non-NetGSM providers too) but delegates transport to hub clients.

### 2.2 Hard constraint: existing webhook URLs must not break

Tenants have `/api/public/channels/netgsm/:channelId/:token/mo` registered in the NetGSM panel. This exact path is preserved (controller may relocate; route string may not). New endpoints use the unified pattern:

```
/api/public/netgsm/:workspaceId/:token/events            # santral event feed (URL'e Yönlendirme)
/api/public/netgsm/:workspaceId/:token/iys               # İYS consent push-back (JSON ARRAY, unsigned)
/api/public/netgsm/:workspaceId/:token/voice-report      # voicesms per-call report push
/api/public/netgsm/:workspaceId/:token/autocall-report   # autocall per-attempt push
```

NetGSM signs nothing → HMAC-token-in-URL pattern from `netgsm-callback.util.ts` (constant-time compare), token = HMAC(MARKETING_SECRET_KEY, workspaceId + purpose). All receivers: payload size caps, tolerant parsing, idempotency via `NetgsmWebhookEvent` dedupe.

### 2.3 Event distribution — existing outbox/domain-event-bus

The webhook controller does **transport + verification + normalization only**, then publishes typed events (`netgsm.call.inbound`, `netgsm.call.answer`, `netgsm.call.hangup`, `netgsm.call.cdr`, `netgsm.iys.consent`, `netgsm.voice.report`, `netgsm.autocall.attempt`) onto the existing `domain-event-bus` (src/modules/outbox/). Marketing-side subscribers do the domain work: telephony (SalesCall upsert, SSE screen-pop), compliance (ConsentRecord), campaigns (CampaignRecipient outcomes). No circular deps between hub and marketing.

Santral event transport: **URL webhook** (multi-tenant SaaS choice; mutually exclusive with NetGSM's TCP socket per their docs). Registration is manual per tenant in the Netsantral portal (Ayarlar > Genel Ayarlar > API Talep Ayarları) — the generated URL is surfaced on TelephonyCard like the existing MO URL, tracked by the onboarding checklist.

### 2.4 Data model delta (ALL migrations reversible up/down, idempotent)

- `CampaignRecipient`: + `netgsmJobId String?`, `referansId String?`, `deliveryStatus String?`, `deliveredAt DateTime?`, `errorCode String?`
- `Campaign`: + `iysMessageType String @default("BILGILENDIRME")` (TICARI | BILGILENDIRME), + `voiceConfig Json?` (TTS text/audioid, keys[] mapping, retry); `channel` gains `VOICE` value (string column — validation code updates)
- `SalesCall`: + `queueName String?`, `recordingStorageKey String?`, `answeredByUserId String?` (direction/externalCallId/recordingUrl/billableSeconds already exist)
- `TelephonyConfig`: + `recordCalls Boolean @default(false)`, `webhookToken String?`, `recordingRetentionDays Int?`
- `Channel.configPublic` (JSON, no migration): `brandCode`, `iysDefault`, `approvedHeaders[]` cache, `lowCreditThreshold`, `useLegacySend`
- New: `NetgsmWebhookEvent` (id, workspaceId, purpose, externalId unique-per-purpose, payload Json, processedAt — dedupe + raw archive), `IysSyncJob` (outbox-style queue: consent payload, refid, status PENDING/SENT/CONFIRMED/FAILED/DLQ, attempts)
- Voicemail and fax land as `Message` rows (channel types `VOICEMAIL`, `FAX`) in existing Conversation/inbox — no new tables
- Recordings: R2 at `netgsm-recordings/<workspaceId>/<salesCallId>.mp3` (generalize `r2-storage.service.ts` out of social-planner into a shared helper)

## 3. Phases

### Phase 0 — Hub foundation (invisible to users)
Hub skeleton + core; strangler moves; **BalanceClient + real "Verify"** on SMS channel card and TelephonyCard (live auth probe; error-30 disambiguation; local-dev caveat: santral report endpoints only work from allowlisted prod IP — UI says so); `NetgsmWebhookEvent` + unified webhook controller skeleton; dead-code cleanup (delete `RecordingSyncService` + `NETGSM_RECORDING_BASE_URL` path, fix `capabilities` array lying about `delivery-receipts`, move voice-AI credit literals into the cost map, CDR sync iterates only workspaces WITH TelephonyConfig); **Onboarding checklist card** in Account Center enumerating manual portal steps (create dahili + WSS connection type, register event webhook URL, approve sender IDs, İYS setup, OTP/auto-dialer package activation) with live verification where an API read exists (balance, msgheader list, queuestats).

### Phase 1 — SMS REST v2 chain
- **Send migration** to `/sms/rest/v2/send` (Basic Auth): per-channel `useLegacySend` flag, default v2 after bake. `jobid` is a 26+ digit STRING (externalMessageId column already string). Map REST error codes onto the existing `interpretNetgsmSend` vocabulary.
- **Campaign n:n batching**: chunk recipients into `messages[]` (one jobid per batch), store jobid + per-recipient `referansID` on CampaignRecipient. Rework the 50/60s throttle accordingly.
- **DLR v2**: point report poller at POST `/sms/rest/v2/report` (documented JSON; jobids[]≤50; mandatory Content-Type; per-number status/deliveredDate/errorCode/referansID; 60 req/min) — closes the silent-parse trap (`parseNetgsmReport` null → stuck SENT 72h). Extend poller to CampaignRecipient jobids → per-campaign delivered/failed rollups. Budget per account via rate-budgeter (fixes global MAX_REPORTS_PER_TICK).
- **Stats reconciler**: `/sms/rest/v2/stats` per jobid (1 jobid/request, each queryable once per 10 min — slow reconciler) → campaign analytics (delivered, blacklist, iysNotValid, repeated, refunded…).
- **Scheduled + cancel**: keep app-side scheduling primary; optionally pass `startdate` for NetGSM-side scheduling; "Cancel scheduled send" via `/sms/rest/v2/cancel` (future-dated only; 60 = not found).
- **Sender-ID**: `/sms/rest/v2/msgheader` in healthCheck/verify (configured header must be in approved list); approved list cached on configPublic; dropdown in settings + per-campaign header selection. New header approval stays portal-manual.
- **Segment counter**: expose `wallet/sms-segments.util.ts` math in campaign/inbox/workflow composers (chars/segments/cost preview); model NetGSM's ~5-char B021 suffix (155-char headed segments); optionally validate against no-auth `/sms/rest/v2/length` in tests.
- **settleSms wired**: every outbound SMS debits per-segment cost to growth SpendLedger via ChannelTariffService (owner-approved billing change). Shown segments = billed segments.
- **Blacklist sync**: on smsOptOut=true → XML {tip:1}; re-consent → {tip:2}; through outbox, ≤120 numbers/min; write-only defense-in-depth.
- **MO poll backup**: low-frequency date-ranged `/sms/rest/v2/inbox` poller (NEVER the parameterless form — it marks messages seen and races the push path); dedupe on `netgsm-mo:<id>`; alert when poll finds messages push never delivered (webhook-health signal). ≤30-day window per query.
- **SMS OTP**: `/sms/rest/v2/otp` ({msgheader,msg,no}) — 2FA second factor + lead phone-verification flow. Enforce in code: single segment ≤155 chars, NO Turkish characters, domestic mobiles only, no scheduling. Distinct rate limiting + audit log. PAID package prerequisite (error 60 without) surfaced on the settings card.
- **New `sms` feature key** split from `conversationAi` (all plans keep it → no tenant-visible regression; enables selling email-without-SMS later).

### Phase 2 — İYS compliance layer
- `IysClient` (JSON, header{username,password,brandCode}).
- **Auto-push**: ComplianceService MARKETING_SMS/ARAMA consent writes → `IysSyncJob` → `/iys/add` batches (ONAY on opt-in, RET on opt-out; ≤500/batch, 10 req/min; async result matched by refid).
- **Pre-send hard-block**: commercial campaigns run `/iys/search` preflight on the audience; RET recipients excluded with a visible count on the campaign report. İYS unreachable → commercial send BLOCKED (fail-closed) with clear error; informational sends proceed.
- **Push-back webhook**: `/api/public/netgsm/:wsId/:token/iys` — payload is a JSON ARRAY, unsigned; dedupe on transactionid/submitid; registered via `/iys/webhook`; İYS-originated ONAY/RET (source IYS_*) → ConsentRecord + lead.smsOptOut.
- **Config**: `brandCode` + `iysDefault` on SMS channel; campaign composer gains TİCARİ/BİLGİLENDİRME selector; `iysfilter` (0/11/12) passed on v2 sends.
- **Gating**: bundled free with `campaigns` (legal necessity, not sold separately).
- Tenant onboarding prerequisites (manual, checklist card): İYS module active on NetGSM account, brand registered (brandCode), NetGSM selected as both İş Ortağı and Aracı Hizmet Sağlayıcı in the İYS portal.

### Phase 3 — Santral live events + inbound calls + call control
- **Events webhook**: scenarios Inbound_call / Answer / Hangup / cdr. Correlate by `crm_id` echo (sent on every originate/linkup already) + `unique_id` (normalize `sip8-…` asteriskId vs bare id). Backfill `externalCallId`. Replaces the fragile last-10-digit CDR match; CDR poll remains as reconciliation.
- **INBOUND SalesCalls**: create rows from events (direction=INBOUND); missed calls (yon/sondurum) recorded + optional follow-up task/workflow trigger; lead-timeline mirror.
- **Screen-pop**: on Inbound_call → lead lookup by customer_num → SSE to the rep registered on internal_num → frontend ringing dialog (caller number + matched lead + accept/reject).
- **Webphone inbound UX**: auto-answer ONLY the originate ring-back (correlate with a just-started outbound SalesCall); genuine inbound INVITEs get the ringing dialog (fixes the auto-answer privacy/mic hazard).
- **In-call controls**: NetsantralClient hangup/xfer/atxfer/muteaudio (need live unique_id from events — this is why call control depends on the webhook); webphone hold/mute via SIP.js session methods; DTMF keypad; transfer picker listing teammates' dahilis. New endpoints under sales-call controller behind `telephony` + leads.write.
- **Live status**: SalesCall status pill driven by Answer/Hangup events (INITIATED→RINGING→CONNECTED→ENDED).
- Fix (shipped Phase 3 Task 6): `maxConcurrentCalls` enforcement is per-rep where the provider supports it (netsantral, 50 lines) — one busy rep no longer blocks a teammate; the single-line lite provider (1) stays per-workspace.

### Phase 4 — Recording pipeline + queues + stats + voicemail
- **Recording**: `recordCalls` toggle on TelephonyConfig → pass caller_record/called_record on linkup/originate (KVKK: settings card links announcement guidance); ingest from webhook `seskaydi` (instant) + CDR `recording` field (reconciliation) → download `&tomp3` → R2 → `recordingStorageKey`; retention job honoring `recordingRetentionDays`; in-app `<audio>` player from own storage (replaces raw cross-origin tokenized link); CallAnalysis STT reads the stored file (no more link-longevity dependency).
- **Queue wallboard**: `queuestats` poll → CallsPage widget (calls waiting, holdtime, per-agent state). Caveat documented: only DYNAMIC queue members are API-manageable; static members read-only. Queue name format `{santral}-queue-{name}`.
- **Agent presence**: rep "available/break" toggle → agentpause (with reason) / agentlogin / agentlogoff.
- **Inbound statistics**: `/netsantral/statistics` (mode 1 daily aggregates ≤7-day window; mode 2 per-call detail with recording links; 2 req/min; prod-IP allowlist) → reports module dashboards (answered/abandoned/avg wait).
- **Voicemail (telesekreter)**: `/voicesms/receive` poller — window is only ≤24h, schedule hourly; creates inbox Message (VOICEMAIL) with sesdosya.netgsm.com.tr audio (downloaded to R2, same pipeline); optional STT via existing SttService.

### Phase 5 — Voice campaigns + auto-dialer + dynamic IVR + callback
- **Voice campaigns**: Campaign channel=VOICE; voiceConfig = TTS text (built-in Turkish TTS) or uploaded audioid (`/voicesms/upload`, .wav ≤4MB) + `scenario.series`/`keys[]` DTMF branches; İYS filter; `relationid`=campaignRecipientId; `url`=voice-report webhook. Cancel via `/voicesms/edit`. Report webhook (voice DOES push, unlike SMS): per-call state 1/2/3/7, bilsec talk seconds, push_button, record_link → CampaignRecipient outcomes; **press-1 → workflow trigger** (e.g. create task / transfer). Composer UI: voice campaign type with TTS/audio picker + keypress mapping.
- **Auto-dialer (parallel power dialer)**: AutocallClient — addautocall ('Devamlı Dinamik' list, destination_type=queue, iysfilter mandatory, retry_count, per-day time windows, url=attempt webhook); addnumber/deletenumber streams the CRM lead queue in; updateliststatus start/stop; reportautocall reconciliation; per-attempt webhook ({JobID, called, unique_id, status}) correlated to leads. DialerPage gains "parallel mode" creating a session-bound dynamic list; respects lead DNC + İYS. 10 req/min. Prerequisite: auto-dialer feature enabled on the Netsantral subscription (checklist item) + a configured queue with logged-in agents.
- **Dynamic IVR personalization**: extend NetgsmIvrService (Özel API consumer at `/public/telephony/netgsm-ivr/:token`) — lookup lead by arayan_no → personalized TTS ("Merhaba Ahmet Bey"); `result:'dynamic'` + redirect to lead's owner rep dahili/phone or priority queue; menu states configurable on VOICE channel configPublic (simple state machine, not a visual builder); correlate arama_id to CDR/recording; surface VoiceCall rows in the rep-facing inbound log (merge toward SalesCall INBOUND view).
- **Callback widget**: NetsantralClient.dynamicRedirect (redirect_menu + redirect_type=queue|ivr|announcement); funnel/webchat block "leave your number, we connect you now". İYS filter param MANDATORY (brandcode when commercial). Prerequisite: named queue/IVR/announcement objects pre-created in the portal.
- **New `voiceCampaigns` feature key**: SCALE/OPERATOR plans + purchasable add-on.

### Phase 6 — Niche: fax + WhatsApp OTP + Netasistan
- **Fax**: two-step multipart `/fax/send` + `/fax/receive` poll → Message rows (FAX) in inbox; send-fax action from lead/conversation. Prerequisite: fax-enabled number. New `fax` key (OPERATOR/add-on).
- **WhatsApp OTP**: fixed `netgsm_verify_code` Meta template client; offered as an alternative OTP transport (ordering SMS→WhatsApp) under the `smsOtp` add-on umbrella. Prerequisite: paid OTP WhatsApp package + Meta template approval.
- **Netasistan sync**: separate auth realm (app-key/user-key → 1h bearer); PUT /break and /queue as per-agent self-service, synced with the Phase-4 presence toggle for tenants that run Netasistan alongside (per-rep opt-in config on TelephonyCard). 60 req/min global.

## 4. Settings & gating model (4 layers, existing architecture)

| Layer | Mechanism | Additions |
|---|---|---|
| Plan | `seed-packages.ts` features/limits matrix | `sms` in ALL plans (no regression); `smsOtp` add-on; `voiceCampaigns` SCALE+ (+add-on grant); `fax` OPERATOR/add-on; İYS inside `campaigns` |
| Workspace | Settings > Modules (`activatedModules`, OWNER) | 4 new module toggles (sms, smsOtp, voiceCampaigns, fax) |
| Capability | Card configs (not plan cells) | TelephonyCard: recordCalls, retention, event-webhook URL + register instructions, wallboard on/off, Netasistan opt-in; SMS card: brandCode, iysDefault, header dropdown, lowCreditThreshold, useLegacySend |
| User | Rep settings | dahili/phone (existing) + agent presence toggle |

Per-new-key tripwire chain (mandatory, each key): FEATURE_KEYS + (optional) DEFAULT_ACTIVATED_MODULES + every package block in seed-packages.ts + tripwire spec pinned arrays + `@RequiresFeature` WITH FeatureGuard in the controller chain + frontend FeatureKey + nav + MODULE_META + `modules.keys.*` i18n (TR/EN). No new required env vars (PUBLIC_BASE_URL, MARKETING_SECRET_KEY, R2 config, NETGSM_IVR_TOKEN already exist).

## 5. Error handling

- Unified `NetgsmError` + per-code Turkish user messages; error 30 disambiguated (creds vs IP allowlist) via balance probe.
- Compliance fail-closed: İYS unreachable → commercial sends blocked; informational proceed.
- Webhooks: dedupe via NetgsmWebhookEvent; out-of-order tolerant upserts (status monotonic guard: never regress CONNECTED→RINGING); tolerant parsing; size caps; constant-time token compare.
- Outbox retries: exponential backoff (1m→2m→4m→… capped at 1h); after 8 attempts → DLQ status + warning badge on the settings card; manual retry action from the card.
- Flood (code 80) → per-account backoff via rate-budgeter.
- Degradation: events webhook down → CDR poll reconciles everything within ~5 min (no data loss); MO push down → inbox poll backup catches + alerts.
- Recording download failure → retry queue + alert; provider URL kept as fallback until stored copy exists.

## 6. Testing

- Unit specs per hub client with documented fixture payloads (existing `netsantral.util.spec.ts` idiom); REST v2/İYS/voice fixtures from official docs.
- Event-handler specs: out-of-order delivery, duplicate delivery, unknown scenario tolerance.
- Campaign batching specs: chunking, jobid/referansID attribution, DLR rollups, İYS preflight exclusion counts.
- Tripwire updates for every new feature key; **new meta-test: any controller with `@RequiresFeature` but missing FeatureGuard in its @UseGuards chain fails CI** (closes the silent-bypass hazard).
- Migration round-trip up→down→up for every migration (repo rule).
- Live verify diagnostics per capability (balance, msgheader, queuestats, İYS search probe, webhook self-test "events received in last N minutes").
- Per-phase manual smoke checklist against the real NetGSM account (documented in each phase's plan).

## 7. Rollout

Phases 0→6 in order; each phase = separate branch/PR/release; deploy with toggles off → enable on canary workspace → general. SMS v2 dual-path: default legacy on release, flip to v2 after bake, remove legacy in the following release. Manual portal steps (webhook URL registration, İYS onboarding, OTP/auto-dialer/fax package activation) tracked per tenant by the onboarding checklist card.

**Account prerequisites to confirm with NetGSM (tracked on checklist, non-blocking for code):** OTP SMS package active? İYS module + brandCode + İş Ortağı/Aracı Hizmet Sağlayıcı set? Otomatik Arama enabled on the Netsantral subscription? Fax-enabled number? OTP WhatsApp package?

## 8. Quality-issue backlog folded into phases

Phase 0: RecordingSyncService deletion; CDR-sync workspace filter; capabilities-array lie; voice-AI credit literals.
Phase 1: DLR silent-parse trap; campaign delivery blindness; global DLR budget → per-account; settleSms dead seam; segment counter absence.
Phase 3: crm_id correlation unconsumed; last-10-digit CDR mis-attach; webphone blanket auto-answer; bridge calls unkillable from UI; per-workspace concurrency blocking unrelated reps.
Phase 4: raw cross-origin recording links; recording flags never passed.
Cross-cutting (Phase 0 + each phase): FeatureGuard meta-test; frontend FeatureKey duplication documented as sync-checklist; entitlements cache staleness accepted (existing behavior, out of scope to re-architect).

## 9. Out of scope

- Extension (dahili) provisioning via API — NetGSM publishes no API (portal-only); covered by the onboarding checklist instead.
- Bulk tenant provisioning via NetGSM reseller channel — operational, not code.
- Re-architecting the in-process entitlements cache for multi-instance — pre-existing, unrelated.
