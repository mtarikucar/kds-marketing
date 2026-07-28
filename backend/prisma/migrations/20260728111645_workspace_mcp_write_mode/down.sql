-- Manual rollback for 20260728111645_workspace_mcp_write_mode (Prisma migrate
-- is forward-only; run by hand to revert). Drops exactly what the up added.
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "mcpWriteMode";
