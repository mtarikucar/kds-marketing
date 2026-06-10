-- P3: workflow automation. All additive (three new tables). The only
-- non-Prisma-expressible bit is the partial-unique "one active run per
-- (workflow, lead)" index — same raw technique as scheduled_jobs_pending_dedup.

CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "trigger" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflows_workspaceId_status_idx" ON "workflows"("workspaceId", "status");

CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersion" INTEGER NOT NULL DEFAULT 1,
    "leadId" TEXT,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "cursor" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_runs_workspaceId_status_idx" ON "workflow_runs"("workspaceId", "status");
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");
CREATE INDEX "workflow_runs_leadId_idx" ON "workflow_runs"("leadId");
-- One LIVE run per (workflow, lead): re-triggering the same lead while a run is
-- still RUNNING/WAITING is a no-op rather than a pile-up.
CREATE UNIQUE INDEX "workflow_runs_active_per_lead"
  ON "workflow_runs"("workflowId", "leadId")
  WHERE "status" IN ('RUNNING', 'WAITING') AND "leadId" IS NOT NULL;

CREATE TABLE "workflow_step_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_step_runs_runId_idx" ON "workflow_step_runs"("runId");
