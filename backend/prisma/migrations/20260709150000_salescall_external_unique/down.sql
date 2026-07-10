-- Manual rollback for 20260709150000_salescall_external_unique (Prisma
-- migrate is forward-only; run by hand to revert). Restores the plain,
-- non-unique index this migration replaced; touches no operator/user data.
DROP INDEX IF EXISTS "sales_calls_workspaceId_externalCallId_key";
CREATE INDEX IF NOT EXISTS "sales_calls_externalCallId_idx" ON "sales_calls"("externalCallId");
