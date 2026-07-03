-- Budget-pacing controller state (Faz 7): persists PID integral/last-error
-- per (budget, channel) so spend tracks the ideal curve across ticks.

-- CreateTable
CREATE TABLE "pacing_states" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT '',
    "spentToDate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "idealToDate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pidIntegral" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "pidLastError" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "recommendedDailyCap" DECIMAL(14,2),
    "status" TEXT NOT NULL DEFAULT 'ON_PACE',
    "lastPacedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pacing_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pacing_states_budgetId_channel_key" ON "pacing_states"("budgetId", "channel");

