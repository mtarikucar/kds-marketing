-- Per-provider server-side conversion-feedback destinations on the ad account.
-- tiktokPixelCode: TikTok Events API event_source_id (non-secret).
-- googleConversionActionId: Google Ads offline conversion action resource id.
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "tiktokPixelCode" TEXT;
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "googleConversionActionId" TEXT;
