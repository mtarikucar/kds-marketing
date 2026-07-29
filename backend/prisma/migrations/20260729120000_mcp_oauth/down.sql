-- Manual rollback for 20260729120000_mcp_oauth (Prisma migrate is forward-only;
-- run by hand to revert). Drops exactly the three tables the up created and
-- nothing else — the up added no column to any pre-existing table. Dropping a
-- table drops its indexes with it, so no separate DROP INDEX is needed.
-- Re-runnable (IF EXISTS).
--
-- CAVEAT: Prisma never sees this file run, so its row in _prisma_migrations
-- still says finished afterwards. A later `npx prisma migrate deploy` will
-- report "No pending migrations to apply" and will NOT recreate the tables.
-- `prisma migrate resolve --rolled-back` will NOT fix this either — it
-- errors P3012 because it only applies to migrations Prisma recorded as
-- failed, not ones that finished cleanly and were reverted out-of-band.
-- To genuinely re-apply: delete this migration's row first, then deploy —
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260729120000_mcp_oauth';
--   npx prisma migrate deploy
DROP TABLE IF EXISTS "mcp_oauth_tokens";
DROP TABLE IF EXISTS "mcp_oauth_codes";
DROP TABLE IF EXISTS "mcp_oauth_clients";
