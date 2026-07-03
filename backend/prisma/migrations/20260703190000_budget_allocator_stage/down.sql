-- Reverses 20260703190000_budget_allocator_stage.
ALTER TABLE "growth_budgets"
  DROP COLUMN IF EXISTS "allocatorStage";
