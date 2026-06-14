-- Insight-digest routine (#3): weekly AI insights digest per workspace.
-- Additive only; no changes to existing tables.

-- CreateTable
CREATE TABLE "insight_digests" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insight_digests_workspaceId_createdAt_idx" ON "insight_digests"("workspaceId", "createdAt");
