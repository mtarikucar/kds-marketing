-- Meta Conversions API (CAPI) destination on the ad account.
-- pixelId: the dataset id we POST /<pixelId>/events to (non-secret).
-- capiToken: an optional dedicated System-User token (SEALED); falls back to
-- the existing sealed accessToken when NULL.
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "pixelId" TEXT;
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "capiToken" TEXT;
