# NetGSM Phase 1 — SMS REST v2 Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all SMS sending to NetGSM REST v2 (true n:n bulk), give campaigns delivery reports for the first time, wire per-segment cost settlement, add sender-ID validation, scheduled-send cancel, blacklist sync, MO poll backup, SMS OTP, and split SMS into its own feature key.

**Architecture:** All new NetGSM transport lives in the hub (`backend/src/modules/netgsm/sms/`), consuming `NetgsmRestClient` (Basic Auth) + `AccountRateBudgeter` from Phase 0. Domain changes: `NetgsmSmsAdapter` (send v2 behind per-channel flag), `CampaignSenderService` (SMS batch path), `NetgsmDlrPollService` (v2 report, per-account budget, campaign coverage), `MessageSenderService` (settleSms). Spec: `docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md` §3 Phase 1.

**Tech Stack:** NestJS 11, Prisma (raw SQL migrations + down.sql), Jest 29 (`npm test -- --testPathPattern='<regex>'` — SINGULAR flag; plural silently runs everything), React+vitest, i18next (TR resources + inline EN fallbacks).

## Global Constraints

- Commits: plain conventional, NEVER any Co-Authored-By/Claude/AI marker (hard rule).
- Migrations: `prisma/migrations/<ts>_<name>/migration.sql` + `down.sql`, both idempotent; down removes exactly what up added. Round-trip up→down→up on a scratch DB (NOT the real dev DB — see Task 9 report of Phase 0 for the scratch-DB recipe).
- Every controller with `@RequiresFeature` wires `FeatureGuard` (the tripwire spec enforces this).
- Never log credentials; scrub creds from errors (NetgsmRestClient does this — always send creds via it).
- Per-account NetGSM rate limits via `AccountRateBudgeter.tryTake(usercode, bucket, limit, perMs)`: report=60/min, blacklist=120 numbers/min, stats=1 query per jobid per 10min.
- New feature keys follow the tripwire chain: FEATURE_KEYS + seed-packages.ts every block + tripwire spec + frontend FeatureKey/nav/MODULE_META + `modules.keys.*` TR i18n.
- Jest 29: SINGULAR `--testPathPattern`, FOREGROUND runs only. Stage exact paths only — never `git add -A`.
- Working branch: `feat/netgsm-sms-v2` off `main` (after Phase 0 merges).

## Key API facts (from the researched official docs — implementers must not re-research)

- **Send v2:** POST `/sms/rest/v2/send`, Basic Auth. Body: `{ msgheader, encoding?, iysfilter?, partnercode?, messages: [{ msg, no }...], startdate?, stopdate? }`. Response: `{ code: "00", jobid: "..." , description?: ... }`. `jobid` is a 26+ digit STRING. `startdate/stopdate` format `ddMMyyyyHHmm` (TR time). Error codes mirror legacy vocabulary (20/30/40/50/51/60/70/80/85) plus REST-specific ones; response may be `{code, description}`.
- **Report v2:** POST `/sms/rest/v2/report`, Basic Auth, `Content-Type: application/json` MANDATORY. Body: `{ jobids: ["..."] }` (≤50 per call). 60 req/min per account. Response: `{ code:"00", jobs: [{ jobid, telno, status, deliveredDate, errorCode?, referansID? }...] }` (field casing per docs; parse tolerantly). Status enum: 0=pending,1=delivered,2..17 failure classes (16/17 İYS), 22=expired; handset errorCodes 101–119.
- **OTP:** POST `/sms/rest/v2/otp` `{ msgheader, msg, no }` — single recipient, single segment ≤155 chars, NO Turkish characters, domestic mobiles only, no scheduling; PAID package (error 60 without).
- **msgheader list:** GET `/sms/rest/v2/msgheader` → `{ code:"00", msgheaders: ["HDR1", ...] }`.
- **Cancel:** POST `/sms/rest/v2/cancel` `{ jobid }` — future-dated jobs only; 60 = not found/not cancellable.
- **Inbox (MO poll):** GET `/sms/rest/v2/inbox?startdate=ddMMyyyyHHmm&stopdate=...` — date-ranged form ONLY (the parameterless form MARKS MESSAGES SEEN and would race the push webhook — never use it). ≤30-day window.
- **Blacklist:** POST `/sms/blacklist` XML `{tip:1}` add / `{tip:2}` remove, legacy form-encoded creds; ≤120 numbers/min; write-only (no read API).
- **B021 suffix:** headed (başlıklı) messages effectively lose ~5 chars/segment (155 GSM-7 in the first segment) — the composer counter must model `reservedSuffixChars = 5`.

---

### Task 0: Branch

- [ ] `cd /home/tarik/Projects/kds-marketing && git checkout main && git pull && git checkout -b feat/netgsm-sms-v2` (create a fresh worktree if the netgsm one is dirty/reused; work only there).

---

### Task 1: `SmsV2Client` (hub) — send/report/otp/msgheader/cancel/inbox/stats

**Files:**
- Create: `backend/src/modules/netgsm/sms/sms-v2.client.ts`
- Test: `backend/src/modules/netgsm/sms/sms-v2.client.spec.ts`
- Modify: `backend/src/modules/netgsm/netgsm.module.ts` (provide+export)

**Interfaces:**
- Consumes: `NetgsmRestClient.request<T>({path, method, creds, body})` → `{httpStatus, body, rawText}`; `netgsmErrorMessage(code)`.
- Produces (exact signatures later tasks rely on):

```typescript
export interface SmsV2SendResult { ok: boolean; code: string; jobid: string | null; message: string | null; retriable: boolean }
export interface SmsV2ReportRow { jobid: string; telno: string; status: number; deliveredDate: string | null; errorCode: string | null; referansId: string | null }
export interface SmsV2ReportResult { ok: boolean; code: string; rows: SmsV2ReportRow[] }

class SmsV2Client {
  send(creds, req: { msgheader: string; messages: Array<{ msg: string; no: string; referansId?: string }>; encoding?: 'TR'; iysfilter?: '0'|'11'|'12'; startdate?: string; stopdate?: string }): Promise<SmsV2SendResult>
  report(creds, jobids: string[]): Promise<SmsV2ReportResult>              // caller chunks to ≤50
  otp(creds, req: { msgheader: string; msg: string; no: string }): Promise<SmsV2SendResult>
  msgheaders(creds): Promise<{ ok: boolean; headers: string[] }>
  cancel(creds, jobid: string): Promise<{ ok: boolean; code: string; message: string | null }>
  inbox(creds, startdate: string, stopdate: string): Promise<{ ok: boolean; messages: Array<{ msg: string; no: string; date: string | null; id: string | null }> }>
}
```

Steps: TDD with fixture-based specs per endpoint (success + error-code + non-JSON body). Retriable = code '80' only (mirror `interpretNetgsmSend`). `send` maps `messages[].referansId` into the wire field NetGSM expects (`referans`/`referansID` — implement tolerantly on the way OUT as documented and PARSE both casings on report rows). OTP method enforces client-side: single segment ≤155, rejects Turkish chars (regex `[çÇğĞıİöÖşŞüÜ]`), rejects non-`05xxxxxxxxx`-normalizable numbers. Commit: `feat(netgsm): SMS REST v2 client (send n:n, report, otp, msgheader, cancel, inbox)`.

---

### Task 2: `sms` feature key split

**Files:**
- Modify: `backend/src/modules/billing/entitlements.service.ts` (FEATURE_KEYS + DEFAULT_ACTIVATED_MODULES if applicable)
- Modify: `backend/prisma/seed-packages.ts` (EVERY package block: `sms: true` — all plans keep SMS, no tenant-visible regression)
- Modify: `backend/src/modules/billing/entitlements.tripwire.spec.ts` (pinned arrays)
- Modify: gates — campaign SMS channel + SMS channel management move from `conversationAi` to `sms`: grep `@RequiresFeature('conversationAi')` and the campaign channel-type validation; ONLY the SMS-specific surfaces move (inbox/conversations stay `conversationAi`). Concretely: campaigns.service channel validation (SMS campaigns require `sms`), marketing-channels controller verify/save for type SMS (feature check in service), MO public route stays ungated (public).
- Modify: frontend `navigation.ts` FeatureKey union + MODULE_META row + Settings>Modules i18n (`modules.keys.sms` TR) + any `useEntitlements`-gated SMS UI (campaign composer channel picker hides SMS without the key).
- Migration: NONE (features live in Package.features JSON — seed re-run updates them; seed is idempotent).

Steps: tripwire-first TDD (add key to tripwire expectation → fails → implement). Verify seed round-trip: `npx prisma db seed` idempotency is existing behavior — run seed twice on scratch DB, second run no-ops. Commit: `feat(billing): split SMS into its own feature key (granted on all plans)`.

---

### Task 3: Reversible migration — campaign delivery + scheduling columns

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<ts>_campaign_sms_v2_delivery/migration.sql` + `down.sql`

Schema delta (exact):
```prisma
model CampaignRecipient {
  // existing fields unchanged +
  netgsmJobId    String?   // v2 batch jobid this recipient was sent under
  referansId     String?   // per-recipient correlation id echoed on report rows (= recipient id)
  deliveryStatus String?   // DELIVERED | FAILED | PENDING (from report status enum)
  deliveredAt    DateTime?
  errorCode      String?   // provider status/errorCode for failures
  @@index([campaignId, netgsmJobId])
}
model Campaign {
  // existing +
  iysMessageType String @default("BILGILENDIRME") // TICARI | BILGILENDIRME (used by Phase 2; column lands now to avoid a second migration)
  netgsmJobIds   Json?  // string[] of v2 batch jobids (stats reconciler input)
}
```
SQL: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`; down drops exactly these columns/indexes (`DROP COLUMN IF EXISTS`, `DROP INDEX IF EXISTS`). Round-trip on scratch DB + `npx prisma generate`. Commit: `feat(campaigns): delivery-tracking columns for SMS v2 (reversible)`.

---

### Task 4: Adapter send → v2 behind per-channel flag

**Files:**
- Modify: `backend/src/modules/marketing/channels/adapters/netgsm-sms.adapter.ts` (+spec)
- Modify: `backend/src/modules/marketing/channels/netgsm-config.util.ts` (+spec) — accept optional `useLegacySend` boolean in configPublic (not secrets)

Behavior: `send()` reads `config.public.useLegacySend === true` → legacy GET path (unchanged); default → `SmsV2Client.send(creds, { msgheader, messages: [{ msg: text, no: gsmno }] })`; map result onto the existing `SendResult` contract (`externalMessageId = jobid`). Retry wrapper stays (retriable code 80/timeouts). `healthCheck` gains msgheader validation: call `msgheaders(creds)`; configured header NOT in list → `ok:false, details.headerApproved:false` (distinct from bad creds); cache the list into `details.approvedHeaders` for the settings UI. Commit: `feat(channels): NetGSM send via REST v2 behind per-channel legacy flag + live header validation`.

---

### Task 5: Campaign SMS n:n batching

**Files:**
- Modify: `backend/src/modules/marketing/campaigns/campaign-sender.service.ts` (+spec)

Behavior (SMS branch of `batch()` ONLY; EMAIL/WHATSAPP untouched): after the per-recipient claim/render loop builds the eligible set, group SMS sends into ONE `SmsV2Client.send` call per batch: `messages = eligible.map(r => ({ msg: renderedBody(r), no: lead.phone, referansId: r.id }))`. On `ok`: mark all SENT with `netgsmJobId=jobid, referansId=r.id, messageId=jobid`; push jobid into `Campaign.netgsmJobIds`. On error code: all FAILED with the mapped message (retriable 80 → leave PENDING for the next batch tick instead). Quota: reserve `eligible.length` upfront (loop `quota.reserve` per message as today, or add a bulk reserve if MessageQuotaService has one — check; otherwise per-message reserve then refund on batch failure). Keep per-recipient claim semantics (PENDING→SENDING→SENT/FAILED) exactly — the batch call replaces only the N adapter round-trips. Unsubscribe footer/link rendering per recipient unchanged. Note: per-recipient render means bodies differ → v2 n:n supports per-message `msg`, this is the point. Tests: batch of 3 → ONE client call with 3 messages; provider code 40 → 3 FAILED; code 80 → 3 stay PENDING; mixed opt-out skips excluded before the call. Commit: `feat(campaigns): true n:n SMS batching via REST v2 (one jobid per batch)`.

---

### Task 6: DLR v2 — poller rework (Message + CampaignRecipient, per-account budget)

**Files:**
- Modify: `backend/src/modules/marketing/channels/netgsm-dlr-poll.service.ts` (+spec)
- Modify: `backend/src/modules/marketing/channels/netgsm-dlr.util.ts` (+spec) — add v2 numeric-status mapping (`mapNetgsmV2Status(status:number, errorCode?:string)` → same NetgsmDlrMapping shape: 1→DELIVERED terminal, 0→SENT pending, {2,3,4,11,12,13,15,16,17,22}→FAILED terminal with reasons incl. İYS 16/17, expired 22; unknown → pending)
- Delete after flag-flip (keep this phase): `netgsm-report.client.ts` stays for legacy-flag channels; new path uses `SmsV2Client.report`

Behavior: the tick (advisory-locked, unchanged) now:
1. Enumerates channels (Phase 0 union fix pattern) and groups by account `usercode`.
2. Per account, budget = `AccountRateBudgeter.tryTake(usercode, 'report', 60, 60_000)` per report CALL.
3. 1:1 messages: batch pending Message jobids (v2 sends → jobid strings) into ≤50-jobid `report()` calls; apply per-row mapping by matching `telno` (Message conversation identity) — for 1:1 sends each jobid has one row.
4. Campaigns: pending `CampaignRecipient` rows (`deliveryStatus IS NULL AND netgsmJobId NOT NULL AND sentAt > now-72h`) grouped by `netgsmJobId` → one `report()` call covers ALL recipients of that jobid; attribute rows by `referansId` (fallback `telno` match); write deliveryStatus/deliveredAt/errorCode; roll up into `campaign.stats` json (`delivered`, `undelivered` counters) via `recomputeStats`-style update.
5. Legacy-flag channels keep the old single-bulkid path (existing code path preserved until legacy removal).
Tests: fake budgeter (deny after N) → tick stops for that account but continues others; campaign attribution by referansId; unknown status stays pending; İYS 16 writes reason. Commit: `feat(channels): DLR via REST v2 report — campaign delivery tracking + per-account budgets`.

---

### Task 7: Stats reconciler + campaign analytics

**Files:**
- Create: `backend/src/modules/marketing/campaigns/campaign-sms-stats.service.ts` (+spec)
- Modify: `backend/src/modules/netgsm/sms/sms-v2.client.ts` — add `stats(creds, jobid): Promise<{ok:boolean; rows: Array<{status:string; count:number}>}>` (POST `/sms/rest/v2/stats`, 1 jobid/call, each jobid queryable once per 10 min)

Behavior: 15-min advisory-locked cron; for SENDING/SENT campaigns with `netgsmJobIds`, budget `tryTake(usercode, 'stats:'+jobid, 1, 600_000)`; merge NetGSM rollups (delivered/blacklist/iysNotValid/repeated/refunded/…) into `campaign.stats.sms` json. UI: CampaignDetail page shows the delivery block when `stats.sms` present (locate the campaign detail component via `grep -rn "stats" frontend/src/pages/marketing/campaigns` and add a small "Delivery" stat row; TR i18n + EN fallbacks). Commit: `feat(campaigns): NetGSM job stats reconciler + delivery rollups`.

---

### Task 8: Scheduled-send cancel ("undo")

**Files:**
- Modify: `backend/src/modules/marketing/campaigns/campaigns.service.ts` (+controller) — cancel action
- Modify: frontend campaign list/detail — "Cancel scheduled send" button for SCHEDULED campaigns

Behavior: app-side scheduling stays primary (ScheduledJob). Cancel of a SCHEDULED (not yet SENDING) campaign: cancel the ScheduledJob (existing service has cancel by dedupKey — verify via `grep -n "cancel" scheduling/scheduled-job.service.ts`) + status→CANCELLED. IF the campaign was NetGSM-side scheduled (startdate passthrough — only when a later task enables it; default OFF), also call `SmsV2Client.cancel(jobid)` per jobid best-effort. This task does NOT add NetGSM-side scheduling (YAGNI — app-side covers the product need; the client method from Task 1 stays available). Tests: SCHEDULED→CANCELLED path + job cancellation; SENDING campaigns refuse cancel (existing pause flow covers). Commit: `feat(campaigns): cancel scheduled sends`.

---

### Task 9: Composer segment counter + settleSms wiring

**Files:**
- Create: `frontend/src/lib/smsSegments.ts` (port of `backend .../wallet/sms-segments.util.ts` + `reservedSuffixChars` param modeling the ~5-char B021 suffix and the unsubscribe footer length)
- Test: `frontend/src/lib/smsSegments.test.ts` (mirror backend spec cases + suffix cases)
- Modify: campaign SMS composer + inbox SMS composer + workflow send_sms step editor (locate each; add "X karakter · Y segment" caption; TR i18n + EN fallback)
- Modify: `backend/src/modules/marketing/channels/message-sender.service.ts` — after a successful SMS send persists the Message row, call `ConversationSpendService.settleSms(workspaceId, { messageId, text, budgetId: null })` best-effort (`.catch(log)` — settlement failure must NOT fail the send; mirrors settleVoice usage if any)
- Modify: `backend/src/modules/marketing/campaigns/campaign-sender.service.ts` — after SMS batch marks SENT, settle per recipient (same guard)

Consumes: `ConversationSpendService.settleSms(workspaceId, {messageId, text, country?, budgetId?})` (backend/src/modules/marketing/budget/conversation-spend.service.ts:42 — currently zero callers; owner-approved billing change). Campaign recipients have no Message row — extend `settleSms` opts with `{campaignRecipientId}`? NO — keep the seam untouched: `debitAndStampMessage` stamps a Message. For campaigns, call `tariffs.price` + ledger write via a new thin `settleCampaignSms(workspaceId, {recipientId, text})` method on ConversationSpendService mirroring settleSms but stamping CampaignRecipient (needs `costAmount` column? NO — write ONLY the SpendLedger entry, no recipient stamp; keep scope tight and note it). Tests: send success → settle called with the message text; settle throw → send still succeeds. Commit: `feat(budget,composer): live SMS segment counter + per-segment cost settlement`.

---

### Task 10: Blacklist sync (defense-in-depth)

**Files:**
- Create: `backend/src/modules/netgsm/sms/blacklist.client.ts` (+spec) — legacy XML endpoint, form creds via POST body, `{tip:1|2, no}` (batch ≤ budget 120 numbers/min via `tryTake(usercode,'blacklist',120,60_000)` per number)
- Create: `backend/src/modules/marketing/channels/netgsm-blacklist-sync.service.ts` (+spec) — subscribes to lead smsOptOut transitions

Trigger: locate where `smsOptOut` flips (unsubscribe public route + ComplianceService consent writes — `grep -rn "smsOptOut" backend/src --include="*.ts" | grep -v spec`); enqueue via the outbox (`OutboxService.append` with `marketing.sms.optout.v1` / `optin.v1` events) and a consumer in the sync service calls the client (add→tip 1, remove→tip 2). Write-only; failures logged + retried by outbox worker semantics. Tests: optout event → tip1 call; optin → tip2; budget denial → requeue (throw → outbox retry). Commit: `feat(channels): mirror SMS opt-outs to NetGSM blacklist`.

---

### Task 11: MO inbox poll backup + webhook-health alert

**Files:**
- Create: `backend/src/modules/marketing/channels/netgsm-mo-poll.service.ts` (+spec)

Behavior: hourly advisory-locked cron per SMS channel account: `SmsV2Client.inbox(creds, <last 2h window in ddMMyyyyHHmm TR time>)` (NEVER parameterless); for each row build the dedupe id `netgsm-mo:<id>` and skip Messages that already exist (`externalMessageId` lookup); missing ones → ingest through the SAME path as the push webhook (locate `ConversationIngressService` usage in netgsm-public.controller.ts and reuse) AND increment a `webhookMissCount`; when a tick ingests ≥1 missed message, log warn + surface on the SMS channel card (`configPublic.lastMoPollRecovery` timestamp → Account Center badge "MO webhook'u mesaj kaçırıyor — panel URL'sini kontrol edin"). Tests: duplicate id skipped; missed row ingested + flagged. Commit: `feat(channels): MO inbox poll backup with webhook-health signal`.

---

### Task 12: SMS OTP — 2FA factor + phone verification + `smsOtp` add-on key

**Files:**
- Create: `backend/src/modules/marketing/services/sms-otp.service.ts` (+spec) — issue/verify codes (6-digit, 3-min TTL, hashed at rest [sha256], max 5 attempts, per-user+per-number rate limit via existing throttler patterns)
- Modify: `backend/src/modules/marketing/services/two-factor.service.ts` (+controller) — add 'SMS' as a second factor alongside TOTP (enroll = verify a code to the rep's phone; challenge on login mirrors TOTP flow — read the service first and mirror its enroll/verify shape)
- Modify: lead phone-verification: endpoint pair `POST /marketing/leads/:id/verify-phone/start|confirm` stamping `lead.phoneVerifiedAt` (new column — reversible migration `<ts>_lead_phone_verified/`)
- Feature key `smsOtp`: FEATURE_KEYS + seed (add-on only: `smsOtp: false` in all plan blocks) + a `WorkspaceAddOn` grant path (existing add-on machinery — grep AddOnPurchased consumer) + tripwire + frontend gate on the verify-phone button + MODULE_META + TR i18n
- Settings card note: OTP package is a PAID NetGSM add-on (error 60 without) — surface `netgsmErrorMessage('60')` when the client returns 60 + a checklist row (`otpPackage`) in NetgsmOnboardingService with a live probe (send is the only probe — so state 'unknown' with detail explaining error-60 semantics; do NOT send a real OTP as a probe).

OTP text template: `Jeeta dogrulama kodunuz: {code}` (NO Turkish chars — enforced by client). Commit: `feat(auth,leads): SMS OTP second factor + lead phone verification behind smsOtp add-on`.

---

### Task 13: Full verification + PR

- [ ] Backend full suite green modulo the 2 documented pre-existing failures (workspace-scoping offenders booking/workflows; AiStudioPage on frontend). `npm run build` both sides; `npx tsc --noEmit`; `npm run lint` 0 errors.
- [ ] Migration round-trips (both new migrations) on scratch DB.
- [ ] Onboarding checklist gains `senderHeaders` row (live `msgheaders()` check — configured header in approved list) — small NetgsmOnboardingService + card addition if not landed in Task 4.
- [ ] Push + `gh pr create` (base main) — body summarizes the 12 deliverables; no AI markers.

## Deferred-from-Phase-0 items folded in

- `channels.verifyFail` headline split (outage vs bad creds) → Task 4 (healthCheck details now carry `headerApproved`; extend ChannelsSettingsPage failure headline mapping: credsValid false → 'bad creds' copy, null → 'unreachable' copy).
- usercode regex-escape in NetgsmRestClient scrubber → Task 1 (one-line: escape usercode like password).
- AccountRateBudgeter first consumer arrives (Task 6) — no eviction work needed (bounded keys).

## Self-review notes

- Spec §3 Phase 1 rows all covered: send v2 (T4), n:n batching (T5), DLR v2 + campaign DLR + budgets (T6), stats (T7), scheduled+cancel (T8 — NetGSM-side scheduling deliberately YAGNI'd, cancel delivered; deviation documented), msgheader (T4+T13), segment counter + B021 (T9), settleSms (T9), blacklist (T10), MO poll (T11), OTP (T12), `sms` key (T2).
- Type consistency: `SmsV2SendResult.jobid` string|null used by T4/T5; `SmsV2ReportRow.referansId` matches CampaignRecipient.referansId (T3).
