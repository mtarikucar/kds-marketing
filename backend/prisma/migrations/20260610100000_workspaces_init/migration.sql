-- Workspace multi-tenancy, step 1/3 (EXPAND).
-- New tables + nullable workspace_id columns on every marketing-owned table.
-- Nullable on purpose: existing rows are backfilled in step 2, the NOT NULL
-- contract lands in step 3. No data is touched here.

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "productName" TEXT NOT NULL,
    "productUrl" TEXT,
    "productDescription" TEXT,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "settings" JSONB,
    "coreIntegration" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_operators" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLogin" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");
CREATE UNIQUE INDEX "platform_operators_email_key" ON "platform_operators"("email");

-- AlterTable: nullable workspace_id everywhere (NOT NULL arrives in step 3)
ALTER TABLE "marketing_users" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "leads" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "marketing_tasks" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "lead_offers" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "commissions" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "marketing_notifications" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "marketing_distribution_config" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "sales_calls" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "installation_crews" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "installation_jobs" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "sales_targets" ADD COLUMN "workspaceId" TEXT;

-- CreateIndex (workspace scoping paths)
CREATE INDEX "marketing_users_workspaceId_idx" ON "marketing_users"("workspaceId");
CREATE INDEX "marketing_users_workspaceId_role_idx" ON "marketing_users"("workspaceId", "role");
CREATE INDEX "leads_workspaceId_idx" ON "leads"("workspaceId");
CREATE INDEX "leads_workspaceId_status_idx" ON "leads"("workspaceId", "status");
CREATE INDEX "leads_workspaceId_createdAt_idx" ON "leads"("workspaceId", "createdAt");
CREATE INDEX "marketing_tasks_workspaceId_idx" ON "marketing_tasks"("workspaceId");
CREATE INDEX "marketing_tasks_workspaceId_status_idx" ON "marketing_tasks"("workspaceId", "status");
CREATE INDEX "lead_offers_workspaceId_idx" ON "lead_offers"("workspaceId");
CREATE INDEX "lead_offers_workspaceId_status_idx" ON "lead_offers"("workspaceId", "status");
CREATE INDEX "commissions_workspaceId_idx" ON "commissions"("workspaceId");
CREATE INDEX "commissions_workspaceId_period_idx" ON "commissions"("workspaceId", "period");
CREATE INDEX "marketing_notifications_workspaceId_idx" ON "marketing_notifications"("workspaceId");
CREATE INDEX "sales_calls_workspaceId_idx" ON "sales_calls"("workspaceId");
CREATE INDEX "installation_crews_workspaceId_idx" ON "installation_crews"("workspaceId");
CREATE INDEX "installation_jobs_workspaceId_idx" ON "installation_jobs"("workspaceId");
CREATE INDEX "installation_jobs_workspaceId_status_idx" ON "installation_jobs"("workspaceId", "status");
CREATE INDEX "sales_targets_workspaceId_idx" ON "sales_targets"("workspaceId");
