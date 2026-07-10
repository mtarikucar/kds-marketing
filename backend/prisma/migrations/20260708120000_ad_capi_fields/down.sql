-- Manual rollback for 20260708120000_ad_capi_fields
-- (forward-only Prisma migrate). Removes exactly what the up added, in reverse.
ALTER TABLE "ad_accounts" DROP COLUMN IF EXISTS "capiToken";
ALTER TABLE "ad_accounts" DROP COLUMN IF EXISTS "pixelId";
