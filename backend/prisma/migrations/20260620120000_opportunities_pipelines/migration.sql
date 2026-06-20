-- Migration: Sales Opportunities + Pipelines (GoHighLevel parity)
--
-- Adds the kanban sales spine that GHL is built around: a workspace defines one
-- or more named Pipelines, each an ordered list of Stages, and Opportunities
-- (deals) move across those stages.
--   pipelines        — named, ordered, one flagged isDefault per workspace.
--   pipeline_stages  — columns on a pipeline; isWon/isLost mark terminal stages,
--                      probability is an advisory 0-100 forecast weight.
--   opportunities    — deals; value/currency for forecasting, position orders the
--                      card within its stage column.
-- All three are NEW tables — purely additive, no backfill, safe online migration.
-- Pipeline→Stage→Opportunity FKs are real (cascade on pipeline delete; RESTRICT a
-- stage delete while deals reference it). workspaceId/leadId/assignedToId are soft
-- references (no FK), matching the rest of this schema.

-- CreateTable
CREATE TABLE "pipelines" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "leadId" TEXT,
    "assignedToId" TEXT,
    "name" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT,
    "notes" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "lostReason" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipelines_workspaceId_idx" ON "pipelines"("workspaceId");
CREATE INDEX "pipelines_workspaceId_archived_idx" ON "pipelines"("workspaceId", "archived");

-- CreateIndex
CREATE INDEX "pipeline_stages_workspaceId_idx" ON "pipeline_stages"("workspaceId");
CREATE INDEX "pipeline_stages_pipelineId_position_idx" ON "pipeline_stages"("pipelineId", "position");

-- CreateIndex
CREATE INDEX "opportunities_workspaceId_idx" ON "opportunities"("workspaceId");
CREATE INDEX "opportunities_workspaceId_pipelineId_stageId_position_idx" ON "opportunities"("workspaceId", "pipelineId", "stageId", "position");
CREATE INDEX "opportunities_workspaceId_status_idx" ON "opportunities"("workspaceId", "status");
CREATE INDEX "opportunities_assignedToId_idx" ON "opportunities"("assignedToId");
CREATE INDEX "opportunities_leadId_idx" ON "opportunities"("leadId");

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
