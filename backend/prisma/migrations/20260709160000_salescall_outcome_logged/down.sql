-- Manual rollback for 20260709160000_salescall_outcome_logged (Prisma
-- migrate is forward-only; run by hand to revert). Drops exactly the column
-- the up added; touches no operator/user data.
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "outcomeLoggedAt";
