-- Manual rollback for 20260703120000_growth_budget
-- (forward-only Prisma migrate). Drops exactly what the up created.
DROP TABLE IF EXISTS "autopilot_runs";
DROP TABLE IF EXISTS "budget_allocations";
DROP TABLE IF EXISTS "growth_budgets";
