-- Budget Autopilot core data model (Faz 7): the single growth budget, its
-- per-channel allocations, and the decision audit log. Inert until the
-- allocator/services use it.

-- CreateTable
CREATE TABLE "growth_budgets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'HOLISTIC',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "explorationPct" INTEGER NOT NULL DEFAULT 20,
    "targetRoas" DECIMAL(10,4),
    "targetCac" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_allocations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "campaignRef" TEXT NOT NULL DEFAULT '',
    "plannedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "spentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginalRoas" DECIMAL(10,4),
    "lastPacedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopilot_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT,
    "kind" TEXT NOT NULL,
    "objective" JSONB,
    "before" JSONB,
    "after" JSONB,
    "autonomy" TEXT NOT NULL DEFAULT 'AUTO',
    "approvalRequestId" TEXT,
    "approvedBy" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autopilot_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "growth_budgets_status_idx" ON "growth_budgets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "growth_budgets_workspaceId_periodKey_key" ON "growth_budgets"("workspaceId", "periodKey");

-- CreateIndex
CREATE INDEX "budget_allocations_workspaceId_channel_idx" ON "budget_allocations"("workspaceId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "budget_allocations_budgetId_channel_campaignRef_key" ON "budget_allocations"("budgetId", "channel", "campaignRef");

-- CreateIndex
CREATE INDEX "autopilot_runs_workspaceId_budgetId_createdAt_idx" ON "autopilot_runs"("workspaceId", "budgetId", "createdAt");

-- AddForeignKey
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "growth_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

