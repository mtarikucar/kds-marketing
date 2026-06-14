# Code Review Remediation — 2026-06-14

Full-codebase review (9 parallel domain reviewers) + per-area deep-dive, then fixes
applied on branch `harden/code-review-remediation`. Backend & frontend typecheck clean;
backend unit suite + frontend tests green.

This doc tracks (1) what shipped in code, (2) **DB migrations that still need to be
generated/applied** (deliberately NOT auto-applied to the live DB), and (3)
behavioral changes to **smoke-test before deploy**.

---

## 1. Fixed in code (this branch)

### Critical (P0)
- **SSRF in workflow webhook** — `workflow-action.handler.ts` now routes the
  `http_webhook_out` action through a new SSRF-safe `safeFetch` util
  (`common/util/safe-fetch.ts`): scheme allow-list, DNS-resolve + private/loopback/
  link-local/metadata IP block (v4+v6), manual redirect re-validation, timeout.
- **PayTR amount not validated** — `billing/payments/webhooks.controller.ts` now
  compares paid `total_amount` (kuruş) to `amountToKurus(order.amount)`; on mismatch it
  refuses to settle, persists a `needsReview` marker, and still returns `OK`.
- **Outbox `dispatching` orphans → event loss** — `outbox-worker.service.ts` adds a
  `reclaimStale()` sweep (re-queues rows stuck in `dispatching` past
  `OUTBOX_RECLAIM_AFTER_MS`, default 5min), stamps `claimedAt` on claim, makes terminal
  flips conditional (`WHERE status='dispatching'`), and a new
  `outbox_events_dispatching` gauge.
- **NetGSM password in URL** — `netgsm-sms.adapter.ts` now POSTs credentials in a
  form body (never the URL); error paths scrub `password=`.
- **SSE access token in URL** — `InboxPage.tsx` streams via `fetch()` with an
  `Authorization: Bearer` header instead of `EventSource(?access_token=)`. *(Ideal
  follow-up: a short-TTL single-use SSE ticket endpoint — see §4.)*
- **Cross-tenant cache bleed** — `main.tsx` clears the React Query cache on every
  auth-state transition (covers header logout, platform logout, 401-interceptor logout,
  and login).

### High (P1) — selected
- Backend: SIGNUP commission `P2002` dedup catch; entitlement reconciliation sweep
  (`reconcileUngrantedOrders`); outbox `idempotencyKey` app-side dedup guard; commission
  period → UTC; lead `update()` email-dedup; ingest quota refund in `finally`; offer
  `update()` drops client `status`; constant-time login; Anthropic client timeout/retries;
  `interpolate()` no longer HTML-escapes plain-text channel bodies; inbound message text
  capped (8k); atomic AI daily-reply cap (`$executeRaw`) + handoff burst scan; public
  funnel DTO validation (`public-site.dto.ts`) + form field caps; password-policy parity
  (`change-password`, `update-marketing-user`); invoice items nested validation; SVG
  upload dropped + serve-route hardening headers; roles-guard `Math.max` threshold;
  metrics guard fail-closed in prod; platform login lockout atomic; throttler keyed by
  principal; CORS allow-list trim/validate/fail-fast; `forbidNonWhitelisted: true`;
  email send timeouts + PII masking; advisory-lock parameterized.
- Frontend: shared `formatMoney` util (TR-first multi-currency) wired into
  Commissions/Offers/LeadDetail; CalendarPage local-date window; query `isError` states +
  global `QueryCache.onError`; top-level `ErrorBoundary`; referral hook mounted; platform
  admin confirm dialogs + real reject reason; in-place cache-sort fix; payment iframe
  `sandbox`; user-form client validation; mailto guard; Tailwind opacity typos.

### Schema (already edited in `schema.prisma`, needs migration — see §2)
- `OutboxEvent.claimedAt DateTime?` + `@@index([status, claimedAt])` **(code-blocking;
  required for the outbox reclaim sweep)**.
- `onDelete` hardening: `MarketingTask.assignedTo` Cascade→Restrict; `Commission.lead`
  SetNull→Restrict.
- Added indexes: `leads(workspaceId, assignedToId)`, `lead_activities(leadId, createdAt)`,
  `marketing_notifications(workspaceId, createdAt)`, `workspace_subscriptions(packageId)`.

---

## 2. DB migrations — NOT auto-applied (generate + run in a controlled environment)

`schema.prisma` is updated but **no migration was generated** (no shadow/dev DB here, and
applying to the live prod DB is an operator decision). Generate the additive migration
from the current schema, and hand-author the operator-gated ones.

### Group A — safe additive (generate from schema; low risk)
Run `npx prisma migrate dev --name code_review_additive` against a dev DB to generate the
migration for: `OutboxEvent.claimedAt` + index, the two `onDelete` Restrict changes, and
the four added indexes. All are additive or constrain only *future* deletes — no existing
row violates them. **The `claimedAt` migration MUST be deployed before the new
`outbox-worker` code runs** (the claim UPDATE writes `claimedAt`).

### Group B — needs pre-check/backfill (hand-authored, `CREATE INDEX CONCURRENTLY`)
Each in its own non-transactional migration. Run the pre-check first; resolve dups before
adding the constraint.
- **Invoice number** `@@unique([workspaceId, number])` — pre-check duplicates; also add a
  retry-on-P2002 (regenerate number) in `invoices.service.ts` first, since `number` is
  random with no retry today.
- **PaymentOrder providerRef** → `@@unique([provider, providerRef])` (strictly looser than
  today's global unique; no current insert breaks).
- **SIGNUP commission dedup** — partial unique
  `(leadId, type) WHERE type='SIGNUP' AND leadId IS NOT NULL` (raw SQL).

### Group C — behavior-changing FK reintroduction (operator-gated)
The deep-dive confirmed ~25 Phase-F/billing/omnichannel tables use bare-string refs to
**same-DB** rows (no FK). Restoring FKs is correct but reverses a deliberate decision and
needs orphan cleanup on live data. Recommended order, each as
`ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` (avoids long write locks):
1. `workspace_subscriptions.packageId` → `packages` (Restrict);
   `payment_orders.packageId` → `packages` (Restrict).
2. `campaign_recipients.campaignId` → `campaigns` (Cascade) — **has live orphans**, clean first.
3. `workflow_runs.workflowId` → `workflows` (Cascade) — clean orphans first.
4. `bookings.calendarId` → `booking_calendars` (Cascade or app-guard) — clean orphans first.
5. Then the zero-orphan child edges: `messages.conversationId`, `workflow_step_runs.runId`,
   `voice_transcripts.callId`, and the nullable `*.leadId`/channel edges (SetNull/Cascade
   per the deep-dive table).

### Conversation duplicate-thread uniqueness (corrected key)
Partial unique **`(channelId, contactIdentityId) WHERE status='OPEN'`** — NOT
`(channelId, leadId)` (a lead can have multiple identities on one channel). Requires
merging existing duplicate OPEN threads first AND a P2002-catch/re-fetch in
`conversation-ingress.service.ts` + `workflow-action.handler.ts`. Most involved — gate on
ops.

### Explicitly NOT changed (refuted false positives)
- **SitePage/BookingCalendar slug uniqueness** — public routes key on the workspace UUID
  (`/p/:ws/:slug`), so per-workspace slug uniqueness is correct. Do **not** make global.
- `OutboxEvent.idempotencyKey` unique — left to the app-side guard; a DB unique could
  break intentional re-emits. Add only if a future dedup design requires it.

---

## 3. Behavioral changes to smoke-test before deploy
- `forbidNonWhitelisted: true` — requests with unknown body fields now `400` (was silently
  stripped). Smoke-test create/update endpoints with the real frontend.
- Invoice item DTO — extra per-item keys are rejected; verify the invoice editor payload.
- Password policy tightened (change-password, update-user, convert modal) — weak/oversized
  passwords now rejected client+server.
- SSRF guard — workflow webhooks to internal/private hosts are now blocked; add an env
  CIDR allow-list if any tenant legitimately targets an internal host.
- NetGSM send moved query→POST — do one live test send.
- PayTR amount check — confirm prod prices match order amounts (no false mismatches).
- Money glyph — Commissions/Offers now format in workspace currency (TR-first → `₺`);
  confirm amounts are stored in workspace currency.
- CORS — production boot now **throws** if `CORS_ORIGIN` is empty/non-https. Confirm the
  prod value before deploy.
- Payment iframe `sandbox` — verify a full PayTR 3DS sandbox transaction still completes.

## 4. Follow-ups (tracked, not in this branch)
- SSE single-use ticket endpoint (backend) to fully retire the Bearer-in-fetch approach.
- Referral cookie **consumption** on register/checkout (needs a backend `referralCode`
  field) — capture is now mounted, but nothing sends the cookie yet.
- Wire `reconcileUngrantedOrders()` to a 5-min cron + boot (currently a TODO).
- i18n key-parity CI check (ru/uz/ar drift); backend `lint` script (only frontend has one).
