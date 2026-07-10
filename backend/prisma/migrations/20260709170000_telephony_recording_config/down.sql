-- Manual rollback for 20260709170000_telephony_recording_config (Prisma
-- migrate is forward-only; run by hand to revert). Drops exactly the columns
-- the up added; touches no operator/user data.
ALTER TABLE "sales_calls" DROP COLUMN IF EXISTS "recordingStorageKey";
ALTER TABLE "telephony_configs" DROP COLUMN IF EXISTS "recordingRetentionDays";
ALTER TABLE "telephony_configs" DROP COLUMN IF EXISTS "recordCalls";
