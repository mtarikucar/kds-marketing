-- Manual rollback for 20260703110000_budget_cost_ledger
-- (forward-only Prisma migrate). Removes exactly what the up added.
DROP TABLE IF EXISTS "spend_ledgers";
DROP TABLE IF EXISTS "channel_tariffs";
ALTER TABLE "voice_calls" DROP COLUMN IF EXISTS "costAmount";
ALTER TABLE "voice_calls" DROP COLUMN IF EXISTS "billableSeconds";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "smsSegments";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "costAmount";
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "costAmount";
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "billableSeconds";
