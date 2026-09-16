-- Reverts 20260916100000_ai_decline_reason exactly: the two nullable columns it
-- added to "conversations". Idempotent, and a safe no-op if already reverted.
-- No operator or customer data lives here — both columns are written only by the
-- AI engine's decline path and are derivable again on the next decline.
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "aiLastDeclineAt",
DROP COLUMN IF EXISTS "aiLastDeclineReason";
