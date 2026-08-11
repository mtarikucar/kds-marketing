-- Manual rollback for 20260811090000_ai_credit_wallet_and_usage_log
-- (forward-only Prisma migrate, matching this repo's manual-down convention).
--
-- DESTRUCTIVE, and worth saying plainly: dropping `ai_credit_wallets` destroys
-- prepaid balances customers PAID for, along with the ledger that is the only
-- record of those payments. Export both tables before running this on anything
-- with real data. `ai_usage_logs` is pure telemetry and safe to drop.
DROP TABLE IF EXISTS "ai_usage_logs";
DROP TABLE IF EXISTS "ai_credit_ledger_entries";
DROP TABLE IF EXISTS "ai_credit_wallets";
