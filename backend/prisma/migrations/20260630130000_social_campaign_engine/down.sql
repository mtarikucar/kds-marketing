-- Manual rollback for 20260630130000_social_campaign_engine (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created and
-- touches no operator/user data beyond the additive columns/tables it introduced.
ALTER TABLE "generated_assets" DROP CONSTRAINT IF EXISTS "generated_assets_socialCampaignId_fkey";
DROP INDEX IF EXISTS "social_posts_socialCampaignId_idx";
ALTER TABLE "social_posts" DROP COLUMN IF EXISTS "campaignItemId";
ALTER TABLE "social_posts" DROP COLUMN IF EXISTS "socialCampaignId";
DROP TABLE IF EXISTS "social_campaign_items";
DROP TABLE IF EXISTS "social_campaigns";
DROP TYPE IF EXISTS "SocialCampaignItemStatus";
DROP TYPE IF EXISTS "SocialCampaignPlanningMode";
DROP TYPE IF EXISTS "SocialCampaignAutomationMode";
DROP TYPE IF EXISTS "SocialCampaignStatus";
