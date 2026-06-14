-- Lead-scoring routine (#4): advisory AI fit/value score on leads.
-- Additive: nullable columns + one index. No data migration / no table rewrite.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "aiScore" INTEGER,
ADD COLUMN     "aiScoreReason" TEXT,
ADD COLUMN     "scoredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_workspaceId_scoredAt_idx" ON "leads"("workspaceId", "scoredAt");
