-- Workspace multi-tenancy, step 3/3 (CONTRACT).
-- Every row now belongs to a workspace; make the column NOT NULL and land
-- the workspace-scoped uniqueness contracts.

ALTER TABLE "marketing_users" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "leads" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "marketing_tasks" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "lead_offers" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "commissions" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "marketing_notifications" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "marketing_distribution_config" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "sales_calls" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "installation_crews" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "installation_jobs" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "sales_targets" ALTER COLUMN "workspaceId" SET NOT NULL;

-- Lead dedup becomes per-workspace: two customers may independently surface
-- the same business.
DROP INDEX "leads_externalRef_key";
CREATE UNIQUE INDEX "leads_workspaceId_externalRef_key" ON "leads"("workspaceId", "externalRef");

-- One distribution config per workspace (was an unenforced singleton).
CREATE UNIQUE INDEX "marketing_distribution_config_workspaceId_key" ON "marketing_distribution_config"("workspaceId");
