# Unified AI-Credit Metered Billing — Design Spec

**Date:** 2026-07-21 · **Status:** design approved (pricing owner-decided), not yet planned/built
**Owner decisions locked:** (1) UNIFIED credit wallet (X API + fal.ai + future), not per-vendor; (2) allowances VARY BY PLAN; (3) ABSTRACT units ("credits", not raw $) so vendor price swings are absorbed by margin.

---
## 1. Goal
Introduce a single per-workspace **usage-credit wallet** ("Jeeta Credits") that meters and bills every metered vendor cost the platform incurs on a tenant's behalf — today **X API** (posts/reads/replies) and **fal.ai** (image/video generation), later any new metered vendor. Each subscription plan includes a monthly credit allowance; when it runs out the workspace is blocked until it buys a top-up. Credits are an **abstract unit** with a fixed per-action price, decoupled from raw vendor cents so the platform absorbs vendor price changes.

## 2. Background / why
- Vendor reality ([[x-twitter-integration]]): the platform holds ONE X app + ONE prepaid X credit balance. Every tenant OAuth-connects to that single app, so **all tenants' X usage draws from the platform's one balance — the platform pays.** Same for fal.ai (one `FAL_KEY`). Without per-workspace metering, a heavy tenant drains the shared balance and the platform eats an unbounded, unattributed cost.
- We already meter/attribute internally elsewhere: the Growth Autopilot's `wallet/growth-wallet.service.ts` + `wallet/spend-ledger.service.ts` model a prepaid balance + debit ledger + block-when-empty. **Reuse the PATTERN, add a SEPARATE model** — the ad-budget wallet is the tenant's own money passed through to ad platforms; the AI-credit wallet is the platform's marked-up vendor cost. Different semantics, do not conflate.
- Billing rails already exist and are reused as-is:
  - `WorkspaceSubscription` (`packageId`, `status`, `currentPeriodStart/End`, `billingCycle`, `provider`) → the period boundary that drives the monthly credit grant.
  - `PaymentOrder` (`type`, `amount`, `idempotencyKey @unique`, `status`, and a "stamped when the entitlement/wallet grant SUCCEEDS" marker) → the top-up purchase + grant rail, already idempotent (see the recovery-sweep marker pattern in [[recovery-sweep-window-blindness-bug-class]]).
  - `WorkspaceAddOn` (entitlement grants Json), `WorkspacePspConfig` (STRIPE|PAYTR|MANUAL).
  - `SubscriptionPackage` (referenced by `WorkspaceSubscription.packageId`) → gets a new `monthlyCredits` field.

## 3. Pricing (owner-decided v1 — config, tunable)
**Per-action credit cost (FIXED; margin baked in; NOT mechanically = raw vendor $):**

| Action key | Credits | Raw vendor cost (COGS ref) |
|---|---|---|
| `X_POST_TEXT` (tweet / thread reply, no link) | 20 | $0.015 |
| `X_POST_LINK` (tweet containing a URL) | 250 | $0.200 |
| `X_READ` (listening / timeline / search, per post) | 10 | $0.005 |
| `X_USER_LOOKUP` | 15 | $0.010 |
| `AI_IMAGE` (fal) | 50 | ~$0.03 (per-model) |
| `AI_VIDEO_SHORT` (fal) | 600 | ~$0.50 (per-model) |

> fal costs vary by model → the raw-cost ref (for COGS) is per-model; the credit price is a fixed bucket calibrated to cover the priciest model in that class.

**Plans (USD/mo), included credits reset each billing cycle (use-it-or-lose-it):**

| Package | Price | Monthly credits |
|---|---|---|
| Starter | $29 | 15,000 |
| Growth | $79 | 50,000 |
| Pro | $199 | 150,000 |
| Agency | custom | custom |

**Top-up packs (purchased credits NEVER expire; bulk cheaper):**

| Pack code | Credits | Price |
|---|---|---|
| `topup_10k` | 10,000 | $19 |
| `topup_30k` | 30,000 | $49 |
| `topup_100k` | 100,000 | $149 |

**Margin:** blended platform cost ≈ $0.70 / 1,000 cr; sale ≈ $1.49–1.90 / 1,000 → ~35–50 % COGS at full burn, higher if underused. Listening is credit-hungry (Pro 150k cr ≈ 15,000 reads ≈ 500/day) → heavy listeners top up (intended). Remember X's app-wide **2M post-reads/cycle** hard cap. Full rationale + market anchors: [[unified-ai-credit-billing]].

## 4. Data model (additive migration — no destructive changes)
```prisma
model CreditWallet {
  id               String   @id @default(uuid())
  workspaceId      String   @unique
  includedBalance  Int      @default(0) // resets each cycle (use-it-or-lose-it)
  purchasedBalance Int      @default(0) // top-ups; never expires
  updatedAt        DateTime @updatedAt
  @@map("credit_wallets")
}

/// Append-only audit + COGS log. balanceAfter = included+purchased after the row.
model CreditLedgerEntry {
  id             String   @id @default(uuid())
  workspaceId    String
  kind           String   // DEBIT | GRANT_PLAN | GRANT_TOPUP | REFUND | ADJUST
  credits        Int      // signed: DEBIT negative, GRANT/REFUND positive
  action         String?  // X_POST_TEXT, AI_IMAGE, ...
  vendor         String?  // X | FAL
  vendorCostUsd  Decimal? @db.Decimal(10,5) // COGS estimate for margin reporting
  refType        String?  // social_post | media_job | payment_order | subscription_period
  refId          String?
  balanceAfter   Int
  idempotencyKey String?  @unique // dedup a debit/grant across retries
  createdAt      DateTime @default(now())
  @@index([workspaceId, createdAt])
  @@map("credit_ledger_entries")
}
```
- `SubscriptionPackage` += `monthlyCredits Int @default(0)`.
- Top-up + per-action credit costs live in **config** (a `CREDIT_PRICES` map + `TOPUP_PACKS` in code) with an OPTIONAL DB override table later; do NOT hardcode in call-sites.
- Materialised two-bucket balance is source of truth for the fast path; the ledger is the audit/recompute source (matching the Growth wallet pattern).

## 5. The metering guard (core API)
`CreditMeterService.debit(input): DebitResult`
```
input  = { workspaceId, action, quantity=1, refType?, refId?, idempotencyKey }
result = { ok: true, charged, balanceAfter } | { ok: false, shortfall, balance }
```
Rules:
1. Resolve `cost = CREDIT_PRICES[action] * quantity`.
2. **Idempotency:** if a ledger row with this `idempotencyKey` exists, return its recorded result (no double charge).
3. **Atomic conditional decrement** (oversell-safe): within a tx + a per-workspace advisory lock (same lock idiom as enrollment/ad-rules in [[growth-autopilot]]), require `includedBalance + purchasedBalance >= cost`; spend `includedBalance` FIRST, remainder from `purchasedBalance`; write the `DEBIT` ledger row (with `vendorCostUsd` from the COGS catalog) + `balanceAfter`.
4. If insufficient → NO decrement, return `{ ok:false, shortfall }`.

**Call ORDER:** `debit()` runs **before** the vendor API call.
**Refund on vendor failure:** if the vendor call then throws/fails, call `CreditMeterService.refund(idempotencyKey)` → append a `REFUND` row + re-credit (to the bucket it came from). Idempotent by `idempotencyKey + REFUND`.

## 6. Grant flows
**Monthly plan grant** — a `@Cron` (advisory-locked) that, per ACTIVE `WorkspaceSubscription`, when a new `currentPeriodStart` has begun, **SETS** `includedBalance = package.monthlyCredits` (reset, not add) and appends `GRANT_PLAN` (idempotent per `workspaceId + periodStart` via `idempotencyKey = plan:{workspaceId}:{periodStartISO}`). Cancelled/expired subs grant 0.

**Top-up grant** — a top-up checkout creates a `PaymentOrder{ type:"CREDIT_TOPUP", packageId: <topup code>, amount, idempotencyKey }`. On PSP success (existing webhook/settlement path), the grant hook ADDS `pack.credits` to `purchasedBalance` + appends `GRANT_TOPUP` (idempotent via the PaymentOrder's existing wallet-grant marker → no double grant on webhook retry).

## 7. Insufficient-credit block + UX
- The guard's `{ ok:false }` surfaces to the caller, which aborts the action and returns a typed **`INSUFFICIENT_CREDITS`** error (HTTP 402) carrying `{ shortfall, balance, topupPacks }`.
- Frontend: a "Krediniz yetersiz — kredi al" modal listing top-up packs (→ PSP checkout); a persistent low-balance banner when balance < a threshold; a wallet widget (balance + this-cycle usage from the ledger); optional **auto-recharge** (buy a pack when below threshold — reuse PaymentOrder, mirror X's own auto-recharge idea).

## 8. Integration points (where the guard wraps)
- **fal media generation** `ai/media/media-gen.service.ts`: before enqueuing/calling fal → `debit(AI_IMAGE|AI_VIDEO_SHORT, refType:'media_job', refId:jobId, idempotencyKey:jobId)`; refund on job failure.
- **X publish** `social-planner/network-adapters.ts` `publishTwitter`: before `POST /2/tweets` → pick `X_POST_LINK` if the tweet body contains a URL else `X_POST_TEXT`; `idempotencyKey = socialPost.id + targetId`; refund on publish failure. (The publisher already keys posts, so idempotency is natural.)
- **X read / search / thread-reply (NOT BUILT YET — [[x-twitter-integration]] is publish-only):** when those engagement features are built, wrap each read batch with `debit(X_READ, quantity:N)` and each reply with `X_POST_TEXT/LINK`. Design the read features with a per-workspace read budget from the outset (they are the dominant cost).
- Guard should live at the SERVICE boundary (one wrap per vendor call), never scattered per call-site.

## 9. COGS / margin
Every `DEBIT` records `vendorCostUsd` from a COGS catalog (X raw rates; fal per-model). A margin report = Σ(credit-sale-value consumed) − Σ(vendorCostUsd) per workspace/period. This makes the "is a plan profitable" question answerable from the ledger.

## 10. Concurrency, idempotency, edge cases
- Oversell: atomic conditional decrement under per-workspace advisory lock (never two debits racing the same balance).
- Double charge: `idempotencyKey` on every debit/grant/refund.
- Vendor fail after debit: refund path.
- Partial multi-item (e.g. a carousel = N images): debit `quantity:N` atomically; if the vendor partially fails, refund the failed count.
- Plan change mid-cycle: next monthly grant reflects the new package; do NOT retro-adjust the current included balance (keep simple v1).
- Currency: credits are currency-agnostic; only the PSP charge (plan/top-up) carries currency (USD primary; TRY localization later, packages already carry currency).

## 11. Phasing
1. **P1 — wallet + ledger + guard + monthly grant + fal wrap.** Metering live for AI media (fal is already the biggest live metered cost). Block+buy UX. COGS logging.
2. **P2 — X publish wrap + top-up purchase flow + auto-recharge + wallet UI.**
3. **P3 — X engagement (read/search/reply) features WITH per-workspace read budgets, wrapped in the guard.** (Depends on building those X features first.)

## 12. Testing
- Unit: guard math (cost resolve, two-bucket spend order, insufficient), idempotent debit/refund, atomic decrement under concurrency (simulate parallel debits → no oversell), monthly grant reset idempotency, top-up grant idempotency on webhook replay.
- Integration: fal/X wrap debits then refunds on simulated vendor failure; INSUFFICIENT_CREDITS surfaces as 402 with packs.
- TZ trap: monthly grant boundary uses `WorkspaceSubscription.currentPeriodStart` (already tz-correct), NOT server-local — see [[server-local-vs-workspace-tz-bug-class]].

## 13. Out of scope (v1) / open questions
- Per-model fal credit sub-pricing (v1 uses one bucket per class; refine later).
- Roll-over of unused included credits (decided: NO — use-it-or-lose-it).
- BYO-vendor-credentials (a tenant using their OWN X app + balance) — separate future model, not this.
- Exact TRY price table for Turkey — localize post-launch.
- Volume/enterprise X (beyond the 2M read/cycle cap) — separate commercial track.
