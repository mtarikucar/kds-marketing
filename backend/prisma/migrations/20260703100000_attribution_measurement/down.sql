-- Manual rollback for 20260703100000_attribution_measurement
-- (forward-only Prisma migrate). Removes exactly what the up added.
ALTER TABLE "social_post_metrics" DROP CONSTRAINT IF EXISTS "social_post_metrics_targetId_fkey";
ALTER TABLE "lead_attributions" DROP CONSTRAINT IF EXISTS "lead_attributions_leadId_fkey";
DROP TABLE IF EXISTS "social_post_metrics";
DROP TABLE IF EXISTS "lead_attributions";
ALTER TABLE "ad_metrics" DROP COLUMN IF EXISTS "roas";
ALTER TABLE "ad_metrics" DROP COLUMN IF EXISTS "conversionValue";
ALTER TABLE "ad_metrics" DROP COLUMN IF EXISTS "revenue";
