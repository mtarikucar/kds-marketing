-- Reverses 20260709120000_conversion_feedback_config (reverse order, idempotent).
ALTER TABLE "ad_accounts" DROP COLUMN IF EXISTS "googleConversionActionId";
ALTER TABLE "ad_accounts" DROP COLUMN IF EXISTS "tiktokPixelCode";
