-- Budget Autopilot: which allocator stage the autopilot uses for this budget.
-- MARGINAL (Stage-1, default) | BANDIT (Stage-2 Thompson sampling) | MMM (Stage-3 MMM-lite).
ALTER TABLE "growth_budgets"
  ADD COLUMN IF NOT EXISTS "allocatorStage" TEXT NOT NULL DEFAULT 'MARGINAL';
