-- Faz C Growth Studio: one-click weekly plan + its budget analysis,
-- and the DRAFT items (social/content/campaign/trend) it lays on the calendar.

-- CreateTable
CREATE TABLE "weekly_plans" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "budgetTotal" DECIMAL(14,2),
    "budgetBreakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_plan_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT,
    "title" TEXT NOT NULL,
    "draft" TEXT,
    "estCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_plans_workspaceId_status_idx" ON "weekly_plans"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_plans_workspaceId_weekStart_key" ON "weekly_plans"("workspaceId", "weekStart");

-- CreateIndex
CREATE INDEX "weekly_plan_items_workspaceId_planId_day_idx" ON "weekly_plan_items"("workspaceId", "planId", "day");

-- AddForeignKey
ALTER TABLE "weekly_plan_items" ADD CONSTRAINT "weekly_plan_items_planId_fkey" FOREIGN KEY ("planId") REFERENCES "weekly_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

