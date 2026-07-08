# NetGSM Phase 2 — İYS Compliance Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-way İYS (İleti Yönetim Sistemi) sync through NetGSM: every CRM consent change is pushed to İYS automatically; İYS-originated changes flow back via webhook; commercial campaigns hard-block RET recipients with a pre-send `/iys/search`; İYS is bundled free with the `campaigns` feature.

**Owner decisions binding this phase:** Full auto + hard-block (fail-closed when İYS unreachable for TİCARİ sends; BİLGİLENDİRME proceeds). Bundled with `campaigns` — NO new feature key.

**Architecture:** `IysClient` in the hub (`backend/src/modules/netgsm/iys/`); an `IysSyncJob`-backed push queue driven by ComplianceService consent writes (marketing side, `backend/src/modules/marketing/compliance/`); the İYS push-back webhook rides Phase 0's unified receiver pattern (`/api/public/netgsm/:workspaceId/:token/iys`); campaign preflight in CampaignSenderService/CampaignsService.

## Global Constraints

(Same as Phase 1: no AI markers in commits; reversible idempotent migrations + scratch-DB round-trip; FeatureGuard tripwire; creds only via NetgsmRestClient; Jest 29 SINGULAR `--testPathPattern`, FOREGROUND; stage exact paths; TR i18n + inline EN fallbacks.)

- İYS API facts (researched, do not re-research): JSON over the NetGSM API host; auth = header `{username, password, brandCode}` (usercode/password = SMS creds; brandCode = tenant's İYS marka kodu). `/iys/add`: batch ≤500 consent rows, 10 req/min, ASYNC — response gives per-row `refid`s; results confirmed later (poll or webhook). `/iys/search`: query consent state per recipient+type. `/iys/webhook`: registers the push-back URL; İYS pushes a JSON ARRAY (unsigned) — dedupe on `transactionid`/`submitid`. Consent types: ARAMA / MESAJ (SMS) / EPOSTA; statuses ONAY/RET; source values like HS_WEB (web form), HS_MESAJ etc.
- Rate budgets via `AccountRateBudgeter`: `iys` bucket 10/min per account.
- Branch: `feat/netgsm-iys` off `main` (after Phase 1 merges).

---

### Task 0: Branch (same recipe as prior phases)

### Task 1: `IysClient` (hub)

**Files:** Create `backend/src/modules/netgsm/iys/iys.client.ts` (+spec); modify `netgsm.module.ts`.

**Produces:**
```typescript
export type IysConsentType = 'MESAJ' | 'ARAMA' | 'EPOSTA';
export interface IysConsentRow { recipient: string; type: IysConsentType; status: 'ONAY' | 'RET'; consentDate: string; source: string; refid?: string }
class IysClient {
  add(creds: {usercode; password; brandCode}, rows: IysConsentRow[]): Promise<{ ok: boolean; code: string; refids: string[]; message: string|null }>   // caller chunks ≤500
  search(creds, recipient: string, type: IysConsentType): Promise<{ ok: boolean; status: 'ONAY'|'RET'|'YOK'|null; message: string|null }>
  registerWebhook(creds, url: string): Promise<{ ok: boolean; code: string; message: string|null }>
}
```
TDD with doc-shaped fixtures (success, error envelope, non-JSON). Commit: `feat(netgsm): İYS client (add/search/webhook registration)`.

### Task 2: Reversible migration — `IysSyncJob` + channel brandCode

**Files:** schema + `prisma/migrations/<ts>_iys_sync_jobs/{migration.sql,down.sql}`.

```prisma
/// İYS push queue — one row per consent change to prove to İYS. Outbox-style:
/// PENDING → SENT (refid stamped) → CONFIRMED, or FAILED → retried with
/// backoff → DLQ after 8 attempts (surfaced on the SMS channel card).
model IysSyncJob {
  id          String    @id @default(uuid())
  workspaceId String
  leadId      String
  recipient   String    // E.164 phone (or email for EPOSTA)
  type        String    // MESAJ | ARAMA | EPOSTA
  status      String    @default("PENDING") // PENDING | SENT | CONFIRMED | FAILED | DLQ
  direction   String    // ONAY | RET
  consentAt   DateTime
  source      String?
  refid       String?
  attempts    Int       @default(0)
  lastError   String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@index([workspaceId, status])
  @@index([status, updatedAt])
  @@map("iys_sync_jobs")
}
```
`brandCode` + `iysDefault` live in Channel.configPublic (no migration). Round-trip on scratch DB. Commit: `feat(compliance): İYS sync-job queue (reversible)`.

### Task 3: Auto-push — consent writes → İYS

**Files:** Create `backend/src/modules/marketing/compliance/iys-sync.service.ts` (+spec); modify `compliance.service.ts` (recordConsent enqueues), unsubscribe public route (smsOptOut flips also enqueue — locate via `grep -rn "smsOptOut" backend/src --include='*.ts' | grep -v spec`), `marketing.module.ts`.

Behavior: `recordConsent(type: MARKETING_SMS|MARKETING_WHATSAPP→MESAJ?, …)` — ONLY MARKETING_SMS→MESAJ and (future ARAMA when call consent exists; add type MARKETING_CALL now? NO — YAGNI, map MARKETING_SMS only, note ARAMA lands with Phase 5 voice campaigns) enqueue IysSyncJob (ONAY when granted, RET when revoked). A 1-min advisory-locked worker drains PENDING jobs grouped by workspace: resolve channel creds+brandCode (skip + mark FAILED 'no brandCode' when absent), chunk ≤500, budget `tryTake(usercode,'iys',10,60_000)` per call, `IysClient.add`, stamp SENT+refid; backoff via attempts (1m→2m→…cap 1h; after 8 → DLQ). SMS channel card shows a DLQ warning badge + retry button (`POST /marketing/compliance/iys/retry`). Tests: enqueue on both flip directions; worker chunking; DLQ path; missing brandCode. Commit: `feat(compliance): auto-push consent changes to İYS`.

### Task 4: İYS push-back webhook

**Files:** Modify `backend/src/modules/netgsm/webhooks/netgsm-events.controller.ts` (+spec) — add `POST :workspaceId/:token/iys` route (same HMAC pattern, purpose 'iys'); create `backend/src/modules/marketing/compliance/iys-webhook.consumer.ts` (+spec).

Behavior: receiver archives (NetgsmWebhookEvent purpose 'iys'; payload is a JSON ARRAY — externalId = sha256 digest per element batch; store per-element rows: iterate elements, dedupe each on `transactionid`/`submitid`) and publishes `marketing.iys.consent.v1` domain events (one per element) via OutboxService. Consumer applies İYS-originated ONAY/RET: find lead by normalized phone in that workspace → `ComplianceService.recordConsent(..., source: 'IYS_'+payloadSource)` (recordConsent already syncs lead.smsOptOut; guard: skip if the latest consent already matches — idempotency). Registration: `IysClient.registerWebhook` called from a settings action `POST /marketing/telephony/iys/register-webhook`? NO — SMS channel card action `POST /marketing/channels/:id/iys/register-webhook` (channel controller, existing guards) minting the URL via `netgsmWebhookUrl(base, workspaceId, 'iys')`. Checklist row `iysWebhook` added to NetgsmOnboardingService. Tests: array payload fan-out, duplicate transactionid ignored, unknown phone logged+skipped, consent applied with IYS_ source. Commit: `feat(compliance): İYS push-back webhook + registration`.

### Task 5: Campaign TİCARİ/BİLGİLENDİRME + pre-send hard-block

**Files:** Modify `campaigns.service.ts` (+dto) — `iysMessageType` on create/update (column landed in Phase 1 Task 3); campaign composer UI selector (SMS campaigns only; default BİLGİLENDİRME; TR copy explains the legal difference); modify `campaign-sender.service.ts` (+spec).

Behavior in `batch()` SMS branch BEFORE the send call, when `campaign.iysMessageType === 'TICARI'`:
1. For each eligible recipient, `IysClient.search(creds, phone, 'MESAJ')` — budgeted (10/min/account) → cache result on the tick (Map).
2. `status==='RET'` (or 'YOK' for consumer numbers — per İYS, no record = no permission for TİCARİ; treat YOK as blocked, note esnaf/tacir nuance in comment) → mark recipient SKIPPED with error 'İYS RET/izin yok', visible in campaign stats as `iysBlocked` count.
3. İYS unreachable / search fails → the WHOLE TİCARİ batch tick aborts (recipients stay PENDING, campaign stays SENDING, warn log + campaign stats `iysUnavailable: true`) — fail-closed per owner decision. BİLGİLENDİRME campaigns skip preflight entirely and pass `iysfilter: '0'`; TİCARİ passes `iysfilter: '11'` (+brandCode) on the v2 send so NetGSM enforces server-side too (defense-in-depth).
Budget note: search is 1 call/recipient — for large TİCARİ audiences the 10/min budget throttles the batch; the tick sends what it cleared and reschedules (existing batch loop handles remainder). Tests: RET skip + counter; unreachable → abort with PENDING intact; BİLGİLENDİRME bypass; iysfilter values on the send call. Commit: `feat(campaigns): İYS hard-block preflight for commercial SMS`.

### Task 6: Gating + checklist + full verification + PR

- İYS surfaces gate on `campaigns` feature (existing key — no new cell); brandCode field + iysDefault on the SMS channel card (ManualChannelDialog/channelFields.ts) with TR helper text; NetgsmOnboardingService rows: `iysBrandCode` (configPublic presence), `iysWebhook` (registered flag stored on configPublic after successful register), `iysFirstSync` (any CONFIRMED IysSyncJob). Full suites modulo documented pre-existing failures; migration round-trips; push + PR.

## Self-review notes
- Spec §3 Phase 2 rows: client (T1), auto-push outbox (T2/T3), hard-block preflight (T5), webhook+registration (T4), brandCode+selector+iysfilter (T5/T6), bundled-with-campaigns (T6). ARAMA consent deferred to Phase 5 (voice) — documented deviation, matches YAGNI.
- Type consistency: IysSyncJob.type uses İYS vocabulary (MESAJ) mapped from ConsentRecord.type (MARKETING_SMS) in exactly one place (iys-sync.service).
