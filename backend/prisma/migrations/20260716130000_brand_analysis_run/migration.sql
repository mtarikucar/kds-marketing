-- Brand Brain: one async extraction-pipeline run per analysis. Additive; no
-- changes to existing tables.
CREATE TABLE IF NOT EXISTS "brand_analysis_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "inputs" JSONB NOT NULL,
    "sourceResults" JSONB,
    "draft" JSONB,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "brand_analysis_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "brand_analysis_runs_workspaceId_status_idx" ON "brand_analysis_runs"("workspaceId", "status");
