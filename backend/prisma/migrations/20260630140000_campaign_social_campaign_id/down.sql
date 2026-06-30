-- Manual rollback for 20260630140000_campaign_social_campaign_id (Prisma migrate
-- is forward-only; run by hand to revert). Drops exactly what the up added.
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "socialCampaignId";
