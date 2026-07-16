-- Manual rollback for 20260716130000_brand_analysis_run (Prisma migrate is
-- forward-only). Drops exactly what the up created; no operator data touched.
DROP TABLE IF EXISTS "brand_analysis_runs";
