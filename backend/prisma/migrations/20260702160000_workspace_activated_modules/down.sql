-- Manual rollback for 20260702160000_workspace_activated_modules (forward-only Prisma migrate).
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "activatedModules";
