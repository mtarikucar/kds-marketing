-- İYS push queue (outbox-style): one row per consent change to prove to İYS.
-- Additive only; no changes to existing tables.
CREATE TABLE IF NOT EXISTS "iys_sync_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "direction" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "refid" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "iys_sync_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "iys_sync_jobs_workspaceId_status_idx"
  ON "iys_sync_jobs"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "iys_sync_jobs_status_updatedAt_idx"
  ON "iys_sync_jobs"("status", "updatedAt");
