-- Manual rollback for 20260716120000_brand_profile (Prisma migrate is
-- forward-only). Drops exactly what the up created; no operator data touched.
DROP TABLE IF EXISTS "brand_profiles";
