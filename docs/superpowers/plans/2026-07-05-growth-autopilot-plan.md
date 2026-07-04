# Growth Studio Autopilot — Implementation Plan (2026-07-05)

> **For agentic workers:** execute task-by-task with TDD (failing test → minimal code → green → commit). Spec: `docs/superpowers/specs/2026-07-05-growth-autopilot-design.md` (decisions D1–D15 are LOCKED — do not relitigate). Branch: `feat/growth-autopilot` off `origin/main`. Worktree: `D:\HDD\projects\kds-marketing-growth`.

**Goal:** credit-funded, fully autonomous growth engine + professional UX, per spec.
**Architecture:** compose existing engines (`budget/`, `wallet/`, `social-campaigns/`, `ads/`, `billing/`); add wallet + closed loop + autonomy lane + trust UX.
**Tech:** NestJS + Prisma + Jest (backend), React/Vite + RTL (frontend), react-i18next.

Phase ownership is file-disjoint so phases 1/2 can run in parallel after Phase 0; 4/5 in parallel after 2.

---

## Phase 0 — Foundations (schema + wallet core + flag) — files: `prisma/schema.prisma`, `prisma/migrations/2026070500_growth_wallet/`, `wallet/growth-wallet.service.ts(+spec)`, `common/growth-flags.ts`
- [x] Additive migration per spec Data Model (GrowthWallet, GrowthWalletLedgerEntry, GrowthBudget.autonomyLevel default 'ASSISTED').
- [x] `GrowthWalletService`: `get`, `credit` (idempotent by unique `ref`, P2002 → replay no-op), `debit` (conditional updateMany `balance >= amount`, fail-closed `InsufficientGrowthCreditError`, ledger row same txn), `tryDebit` variant. Workspace-scoped everywhere. Specs: never-negative, race semantics, idempotent replay, scoping.
- [x] `growthAutopilotAutonomyEnabled()` env-flag helper.

## Phase 1 — Close the revenue loop — files: `leads/attribution-*.ts`, `channels/conversation-ingress*`, `order-forms/*`, `booking/*`, `budget/performance-loop.service.ts(+util)`, `ads/ads-pull.service.ts`
- [ ] `revenue-events.util.ts` (D9 precedence) + rewire `PerformanceLoopService` onto it (verify Invoice/LeadOffer/Estimate field names in schema first).
- [ ] UTM/`jg_cid` → `sourceAdCampaignId` resolver (D10a) applied inside `LeadAttributionService.capture` when source refs absent.
- [ ] Wire `capture()` into conversation ingress (incl. CTWA `referral.source_id` → D10b), order-forms, booking.
- [ ] `ads-pull`: also map provider revenue (`action_values`/`purchase_roas`) into `AdMetric.revenue/conversionValue/roas` when present, never clobbering non-zero CRM-reconciled values.
- [ ] Non-ad signal: social organic post ref (D10c) captured where lead source is a social conversation/form.

## Phase 2 — Autonomy + funding — files: `budget/budget-autopilot.service.ts`, `budget/budget-executor.service.ts`, `budget/budget-anomaly.service.ts(new)`, `budget/budget-autopilot.cron.ts`, `budget/ad-spend-mirror.service.ts(new)`, `billing/billing.service.ts`, `billing/billing-settlement.service.ts`, `controllers/marketing-budget.controller.ts`, `budget/budget-quickstart.service.ts(new)`, spend drawdown seams (`ai/media/media-gen.service.ts`, `budget/conversation-spend.service.ts`, `budget/research-spend.service.ts`)
- [ ] Executor: extract `applyPlan(workspaceId, budgetId, after, opts)` from `apply()`; autonomous entry (flag ∧ AUTONOMOUS ∧ ACTIVE ∧ !killSwitch) — **creates no ApprovalRequest**, records `autonomy='AUTO'` run.
- [ ] Autopilot.propose(): branch on `autonomyLevel` (SHADOW: no enqueue; ASSISTED: today's path; AUTONOMOUS: applyPlan with 6h cooldown D8). Pool = D5 effectiveTotal (wallet-bounded), pacer too.
- [ ] `AdSpendMirrorService` (D3): per tick, mirror engine-scoped AdMetric.spend deltas → SpendLedger `AD_SPEND` (dedup ref) + wallet `AD_GOVERNOR` debits.
- [ ] Anomaly service (D11) evaluated each tick → auto-PAUSE + `ANOMALY_STOP` run.
- [ ] Wallet funding: `WALLET_TOPUP` checkout + settlement branch + reconcile sweep (D2). Engine-context drawdown pre-checks (D4).
- [ ] Quick-start (D12) service + endpoint; activity endpoint (D14). Controller: `POST /quick-start`, `GET /:id/activity`, `PATCH /:id/autonomy`, wallet endpoints (`GET /wallet`, `POST /wallet/topup`).
- [ ] Integration specs for invariants 1–8.

## Phase 3+4 — Content arm + Autopilot UX — files: `budget/budget-quickstart.service.ts` (content arm), frontend `pages/marketing/budget/*`, `pages/marketing/studio/*`, `features/marketing/navigation.ts`, api client `features/marketing/budget*`
- [ ] Content arm: quick-start provisions FULL_AUTO campaign; tick adjusts `dailyPublishCap` from CONTENT allocation (D13).
- [ ] BudgetAutopilotPage → Autopilot panel (hero Growth Multiple, wallet card + top-up, ONE switch + Pause/Kill, Activity Log, config drawer; approvals only when ASSISTED). `money()` uses budget currency + active locale (no hard 'tr-TR').
- [ ] “Enable Autopilot” wizard (single dialog → quick-start; success manifest). CTA in Growth Studio header + command palette entry.
- [ ] Nav: studio tier→core (managerOnly stays; update navigation.test.ts expectations only where semantics intend). Nested tabs URL-synced (`?sub=`).
- [ ] i18n keys en+tr for every new string.

## Phase 5 — System-wide UX sweep — files: the 7 window.confirm pages, `MarketingDashboardPage.tsx`, `LanguageSwitcher.tsx`, locale JSONs
- [ ] window.confirm → ConfirmDialog (7 files, per-row pending isolation), strings via `t()` en+tr.
- [ ] Turkish inline defaults → English; LanguageSwitcher hides <95% locales; seed `common.json` shared strings.
- [ ] Loading-state alignment on touched pages only (no drive-by churn).

## Phase 6 — Verify & ship
- [ ] Full backend + frontend suites, `tsc`, builds; fix regressions.
- [ ] Adversarial review (money paths, scoping, approval-bypass) → fix confirmed findings.
- [ ] Push, PR to main, CI, merge; deploy tag. Autonomy stays dark (flag unset in prod) until user arms it.
