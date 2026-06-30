-- Manual rollback for 20260630120000_ai_media_assets (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created
-- and touches no operator/user data.
DROP TABLE IF EXISTS "generated_assets";
DROP TABLE IF EXISTS "brand_kits";
