-- Manual rollback for 20260709120000_iys_sync_jobs (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up created and
-- touches no operator/user data.
DROP TABLE IF EXISTS "iys_sync_jobs";
