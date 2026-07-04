# Growth Studio Autopilot — Design Spec (2026-07-05)

**Goal:** a workspace loads credit, sets caps + a goal once, flips Autopilot ON — and the system autonomously spends that credit in the most sales-optimal way (ads + AI content + organic posting + messaging), continuously re-optimizing against real CRM revenue, **never asking the user anything while running**. Only interrupts: global Pause / Kill. Everything is audited in a plain-language Activity Log.

Grounding: ~80% of the engine already exists (`budget/` allocators + PID pacer + performance loop + `SpendLedger` + kill-switch; `social-campaigns` FULL_AUTO content factory; `ad-rules` autonomous ad writes). This spec adds the missing 20%: a funded wallet, a closed revenue loop, the autonomy lane, anomaly auto-stop, one-click provisioning, and the trust UX.

## Locked decisions

| # | Decision | Choice + rationale |
|---|----------|--------------------|
| D1 | Wallet model | New `GrowthWallet` (1/workspace, cached `balance Decimal(14,2)`, workspace-currency) + append-only `GrowthWalletLedgerEntry` (`delta`, `balanceAfter`, `kind`, unique `ref` for idempotency). Race-safe conditional debit copied from `CustomerWallet` (`updateMany where balance >= amount`); **fail-closed, never negative**. Major units (Decimal) to match `SpendLedger`/`GrowthBudget` (NOT CustomerWallet's int minor units). |
| D2 | Top-up | `PaymentOrder.type='WALLET_TOPUP'` (type is a free String — additive). New checkout path (amount-based, no package). Settlement: `grantEntitlement` gets a WALLET_TOPUP branch that credits the wallet **idempotently** (ledger `ref = order:{id}` unique). Recovery: `reconcileUngrantedOrders` gains a WALLET_TOPUP sweep (SUCCEEDED order with no matching ledger ref → re-credit). |
| D3 | Ad-spend semantics (Mode 1, "governor") | The platform does NOT pay ad networks; the customer's own ad account does. The wallet still governs ads: engine-scoped ad spend is **mirrored daily** from `AdMetric.spend` into `SpendLedger` (`reason='AD_SPEND'`, dedup `ref=admetric:{campaignId}:{ISO-day}`) **and debited from the wallet as clearly-labeled non-cash bookkeeping** (`kind='AD_GOVERNOR'`). Result: wallet balance = remaining credit the engine may still commit anywhere; balance 0 → engine idles. Mirror scope = campaigns present as `campaignRef` in the budget's allocations; channel-level rollup ('' ref) mirrors account-level spend for that channel. UI copy states explicitly: “Ad spend is billed by Meta/TikTok on your connected ad account; your credit governs how much the engine commits.” Mode 2 (platform-paid ads via System User) is a future seam, not built. |
| D4 | Real (cash) wallet drawdown | Engine-initiated platform-paid work debits the wallet for real at action time: AI media (via `estimateMediaUsd`), engine SMS/WhatsApp/voice (`conversation-spend`), research (`research-spend`) — **only when the spend carries a `budgetId`** (engine context). Manual user actions keep today's metering untouched. Pre-check: insufficient balance → action rejected fail-closed (reserved amounts refunded on failure). |
| D5 | Effective pool (the credit bound) | For pacer + allocator: `effectiveTotal = min(GrowthBudget.totalAmount, netSpent + wallet.balance)`. Since ALL engine spend (cash + governor) debits the wallet, `netSpent + balance` is monotone-correct: when the wallet hits 0 the pool collapses to what's already spent → allocator no-ops → engine idles until top-up. |
| D6 | `autonomyLevel` | New String column on `GrowthBudget`, values `SHADOW \| ASSISTED \| AUTONOMOUS`, **default `ASSISTED`** (= exactly today's behavior: propose + approval queue, zero surprise for existing rows). `SHADOW` = record proposals only, never enqueue approvals. `AUTONOMOUS` = propose → auto-apply, **no ApprovalRequest row is ever created**. Arming AUTONOMOUS is the user's one explicit opt-in (via the wizard). |
| D7 | Feature flag | Env `GROWTH_AUTOPILOT_AUTONOMY=1` gates the autonomous lane + quick-start arming. Unset → autonomous branches inert (propose falls back to ASSISTED behavior), UI hides the arm switch. Ships dark. |
| D8 | Autonomous apply cadence | Cron stays hourly; auto-apply respects a **6h cooldown** per budget (last `autonomy='AUTO'` run < 6h → propose records but does not apply). Combined with allocator `maxStepPct=20%`, worst case ±20%/6h per channel. Kill/pause/status checks re-verified at apply time. |
| D9 | Unified sale signal | `revenue-events.util.ts` consumed by `PerformanceLoopService`: per lead in window, revenue = WON `Opportunity`s if any; else PAID `Invoice`s; else ACCEPTED `LeadOffer`s; else ACCEPTED `Estimate`s (precedence prevents double-counting the same deal across records). Loop becomes source-agnostic; field names verified against schema at implementation. |
| D10 | Click→campaign resolution (v1, deterministic only) | (a) UTM: `utm_campaign`/`jg_cid` matching a workspace `AdMetric.campaignId` → `sourceAdCampaignId`; (b) Meta CTWA webhook `referral.source_id`/ads context → `sourceAdCampaignId` at conversation ingress; (c) social organic: `utm_source=social` + post ref → `sourceSocialPostId`. Bare `fbclid` without UTM stays stored-but-unresolved (documented; no fragile API lookups in v1). Capture wired into conversation ingress, order-forms, booking, CTWA webhooks (today: site forms only). |
| D11 | Anomaly auto-stop | `budget-anomaly.service.ts`, evaluated each tick: (a) 24h netSpent delta > 3× `recommendedDailyCap`; (b) ROAS collapse: 7d-baseline revenue > 0 and current-day ROAS < 30% of baseline with spend > 20% of cap; (c) ≥5 consecutive failed live ad writes in 24h. Trigger → `status=PAUSED` + `AutopilotRun kind='ANOMALY_STOP'` (plain-language reason) — stops itself, never asks. |
| D12 | One-click provisioning | `POST /marketing/budget/quick-start`: ensures wallet, upserts current-period `GrowthBudget` (HOLISTIC), seeds channel allocations from actually-connected assets (AdAccounts→META/…, social accounts→CONTENT, messaging channels→SMS/WHATSAPP), optionally provisions one FULL_AUTO `SocialCampaign` (content arm), arms `autonomyLevel` per request (+flag), activates. Returns a manifest of everything it did (wizard renders it). This is the “one click → dozens of operations” surface. |
| D13 | Content arm | Quick-start provisions FULL_AUTO campaign; hourly tick keeps `dailyPublishCap` proportional to the CONTENT allocation (clamped 1–3/day). Existing brand-safety (Claude SAFE/BLOCK) + brand-brain grounding untouched. |
| D14 | Activity Log | `GET /marketing/budget/:id/activity`: merged, time-desc feed of `AutopilotRun` + `SpendLedger` + `GrowthWalletLedgerEntry` + `AdRuleLog` rows mapped to `{ts, kind, title-args, ok}`; strings localized client-side. Replaces the approval queue as the trust surface for AUTONOMOUS budgets (approve/reject UI remains only for ASSISTED). |
| D15 | Hero metric | “Growth Multiple” = attributed revenue (this period, from the closed loop) ÷ engine net spend. Shown with credit loaded / spent / sales generated. |

## Data model (additive migration only)

```prisma
model GrowthWallet {
  id          String   @id @default(uuid())
  workspaceId String   @unique
  balance     Decimal  @default(0) @db.Decimal(14, 2)
  currency    String   @default("TRY")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  entries     GrowthWalletLedgerEntry[]
  @@map("growth_wallets")
}

model GrowthWalletLedgerEntry {
  id           String       @id @default(uuid())
  workspaceId  String
  walletId     String
  wallet       GrowthWallet @relation(fields: [walletId], references: [id], onDelete: Cascade)
  delta        Decimal      @db.Decimal(14, 2) // signed
  balanceAfter Decimal      @db.Decimal(14, 2)
  kind         String // TOPUP | ENGINE_SPEND | AD_GOVERNOR | REFUND | ADJUST
  ref          String?      @unique // idempotency: order:{id}, spend:{ledgerId}, admetric:{campaign}:{day}
  note         String?
  createdAt    DateTime     @default(now())
  @@index([workspaceId, createdAt])
  @@map("growth_wallet_ledger_entries")
}

// GrowthBudget: + autonomyLevel String @default("ASSISTED")
```

`SpendLedger.reason` gains `AD_SPEND` (mirror entries; column is a free String — no migration).

## Autonomy state machine

```
                     ┌────────────┐   arm (wizard, flag on)   ┌──────────────┐
 create (classic) →  │  ASSISTED  │ ─────────────────────────▶│  AUTONOMOUS  │
                     │ propose +  │ ◀───────────────────────── │ propose →    │
                     │ approvals  │      disarm (1 click)      │ auto-apply   │
                     └────────────┘                            └──────┬───────┘
                        ▲    SHADOW = propose-only (no approvals)     │ anomaly / pause / kill
                        └─────────────────────────────────────────────▼
                                              PAUSED / KILLED (instant, cron skips)
```

Apply gates in AUTONOMOUS (all must hold): flag on ∧ status=ACTIVE ∧ !killSwitch ∧ cooldown elapsed ∧ plan non-noop ∧ per-channel guardrails (maxStep/floors/exploration — already in allocator math) ∧ pool ≤ min(cap, funded credit).

## Invariants (tested)

1. Wallet balance can never go negative (concurrent debits race-safe; insufficient → reject).
2. In AUTONOMOUS mode **no `ApprovalRequest` row is ever created**.
3. Auto-apply never runs when killSwitch/PAUSED/flag-off; re-checked at apply time.
4. Effective pool ≤ min(totalAmount, netSpent + wallet.balance) at every propose.
5. Top-up settlement is idempotent (replayed webhook credits once).
6. All new queries/mutations workspace-scoped; no optional-id `where` that can drop to undefined.
7. Anomaly trip → PAUSED + logged run, no user prompt.
8. Ad-spend mirror is idempotent per (campaign, day).

## UX (Growth Studio)

- Studio nav: promoted out of “More” (tier core), stays managerOnly. All tabs URL-synced (top level already is; nested `defaultValue` tabs get `?sub=` params).
- Budget tab becomes **Autopilot**: hero Growth Multiple + credit loaded/spent/sales; wallet card (balance, Top up, burn-down); ONE switch (Autopilot on/off) + Pause + Kill; Activity Log feed; config drawer (cap, goal, guardrails — set once); allocations table read-only. Approvals UI only when ASSISTED.
- “Enable Autopilot” wizard: one dialog → wallet/top-up, cap+goal (pre-filled from wallet), arm → single quick-start call; success screen lists everything provisioned.
- Part B sweep per brief §3.2 (#4–#12): ConfirmDialog everywhere, i18n fixes (English inline defaults, hidden <95% locales, common.json), workspace-currency money, loading-convention alignment on touched pages.

## Out of scope (documented seams)

Mode 2 platform-paid ads; TikTok/Google/LinkedIn live budget writes (write-capability gate stays); fbclid→campaign API lookup; MMM stage tuning; per-rep onboarding revamp (tracked, minimal touch).
