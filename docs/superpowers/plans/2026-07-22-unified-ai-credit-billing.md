# Unified AI-Credit Billing — Implementation Plan

> Execute task-by-task, TDD (jest, mocked Prisma), commit after each green task. Spec: `docs/superpowers/specs/2026-07-21-unified-ai-credit-billing-design.md`.

**Branch:** `feat/ai-credit-billing` (off main). **Module:** `backend/src/modules/marketing/credit/` (new). Frontend under `frontend/src/pages/marketing/credit/` (new) + wallet widget.

**Locked design (from spec + codebase idioms):**
- Two-bucket wallet (`includedBalance` resets monthly, `purchasedBalance` persists). Debit = **interactive tx + `pg_advisory_xact_lock(hashtext(workspaceId))`** → read → check total ≥ cost → spend included-first → update both → append ledger. (Matches enrollment advisory-lock idiom; two buckets can't use single conditional updateMany.)
- Idempotency: `CreditLedgerEntry.ref @unique` (e.g. `debit:{action}:{refId}`, `plan:{ws}:{periodStartISO}`, `topup:order:{id}`). Duplicate ref = already applied → no-op.
- Credit prices + top-up packs + package allowances = **config** (`credit-pricing.config.ts`), not call-site literals. COGS raw-cost ref logged per debit.
- Prisma: edit schema → `npm run prisma:generate` (no DB needed for types) → migration SQL hand-written, parity-checked vs shadow PG before merge.
- Tests = jest with the repo's deep-mocked PrismaService (see enrollment count-mock trap: override `.count`/`$transaction`/`$queryRaw` explicitly).

---
## P1 — core (wallet + ledger + guard + monthly grant + fal wrap + block)

### Task 1 — schema models + generate
- Modify: `backend/prisma/schema.prisma` — add `CreditWallet`, `CreditLedgerEntry`; add `monthlyCredits Int @default(0)` to `SubscriptionPackage`.
- Migration: `backend/prisma/migrations/20260722100000_ai_credit_billing/migration.sql` (hand-write CREATE TABLE + ALTER).
- Run `npm run prisma:generate`; commit.

### Task 2 — pricing config
- Create `credit/credit-pricing.config.ts`: `CREDIT_PRICES: Record<CreditAction, number>`, `VENDOR_COST_USD: Record<CreditAction, number>`, `TOPUP_PACKS`, `PACKAGE_CREDITS` fallback. Export `CreditAction` union. Pure, unit-tested (every action has a price + cost; price ≥ cost/… sanity).

### Task 3 — CreditMeterService.debit/refund (TDD, the core)
- Create `credit/credit-meter.service.ts` + `.spec.ts`.
- `debit({workspaceId, action, quantity=1, refType?, refId, ref})` → tx+advisory-lock, included-first split, ledger row (with `vendorCostUsd`), `{ok,charged,balanceAfter}` | `{ok:false,shortfall,balance}`. Duplicate `ref` → returns prior result (query ledger by ref first inside the lock).
- `refund(ref)` → append REFUND (idempotent), re-credit to source buckets.
- Tests: sufficient/insufficient, included-first order, idempotent debit (same ref twice = one charge), refund re-credits, concurrent debits don't oversell (simulate via mocked tx sequencing / assert conditional guard).

### Task 4 — plan grant service + cron
- `credit/credit-grant.service.ts`: `grantPlanCredits(workspaceId, now)` → resolve ACTIVE `WorkspaceSubscription` + package.monthlyCredits → SET `includedBalance = allowance` (reset) + ledger `GRANT_PLAN` ref `plan:{ws}:{periodStartISO}` (idempotent per period). 0 if no active sub.
- `credit/credit-grant.cron.ts`: `@Cron` daily, advisory-locked `credit:grant`, iterate ACTIVE subs whose `currentPeriodStart` began and lack this-period grant. Tests: reset semantics, idempotent per period, tz via `currentPeriodStart` (assert Asia/Tokyo — see server-local-vs-workspace-tz trap).

### Task 5 — INSUFFICIENT_CREDITS error + guard helper
- `credit/insufficient-credits.exception.ts` (Http 402, payload `{shortfall,balance,topupPacks}`).
- `credit/credit.guard.ts` thin helper `chargeOrThrow(action, ctx)` wrapping `debit` → throws the 402 on `{ok:false}`. Test the mapping.

### Task 6 — wire module
- `credit/credit.module.ts` (providers + export CreditMeterService/CreditGrantService); register in `marketing.module.ts` (imports + cron). Build-compile validates DI (no boot test in repo — grep-verify registration like siblings).

### Task 7 — fal integration wrap
- Modify `ai/media/media-gen.service.ts`: inject CreditMeterService; before enqueue/fal call → `debit(AI_IMAGE|AI_VIDEO_SHORT, ref:'media:'+jobId)`; on job failure → `refund('media:'+jobId)`. Tests: charged on gen, refunded on failure, blocked (402) when insufficient. (Carousel N images → quantity N.)

### Task 8 — controller (read wallet + usage)
- `credit/credit.controller.ts`: `GET /marketing/credit/wallet` → `{included,purchased,total,periodEnd}`; `GET /marketing/credit/ledger?limit` → recent entries; `GET /marketing/credit/topup-packs`. Guarded (workspace-scoped auth). DTO + tests.

### P1 gate: backend `npm test` (targeted suites) + build green. Commit + push.

---
## P2 — X publish wrap + top-up purchase + wallet UI
### Task 9 — X publish wrap
- Modify `social-planner/network-adapters.ts` `publishTwitter`: pick `X_POST_LINK` if body has a URL else `X_POST_TEXT`; `debit(ref:'xpost:'+postId+':'+targetId)`; refund on failure. Tests.
### Task 10 — top-up checkout + grant
- Extend billing: `PaymentOrder` type `CREDIT_TOPUP` (packageId = topup pack code). Checkout endpoint creates the order via existing PSP flow; on success the grant hook adds `pack.credits` to `purchasedBalance` + ledger `GRANT_TOPUP` ref `topup:order:{id}` (idempotent, reuse PaymentOrder wallet-grant marker). Tests incl. webhook-replay idempotency.
### Task 11 — auto-recharge (optional) + wallet UI
- Frontend `credit/CreditWalletWidget.tsx` (balance + this-cycle usage), `InsufficientCreditsModal` (top-up packs → PSP), low-balance banner. Wire the 402 → modal in the api layer. Vitest.

---
## P3 — X engagement (read/search/thread-reply) WITH per-workspace read budget
> Depends on building the X read/search/reply features first (not yet in code — publish-only today). Each read batch → `debit(X_READ, quantity:N)`; each reply → post cost. Design a per-workspace daily/monthly read budget cap from the outset. Separate plan when those features are scoped.

---
## Verification checklist
- [ ] Every new service TDD'd (watched red→green), mocked-Prisma.
- [ ] Migration parity-checked vs shadow PG (`No difference detected`).
- [ ] `prisma generate` run; backend build + targeted suites green; frontend tsc + vitest green.
- [ ] DI registration grep-verified in `marketing.module.ts`.
- [ ] No destructive migration; additive only.
