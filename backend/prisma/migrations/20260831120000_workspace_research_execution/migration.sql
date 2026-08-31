-- Per-workspace research execution lane.
--
-- SERVER (default, today's behaviour): the in-process ResearchWorkerService
-- drains `scheduled_jobs` rows of kind 'research.run' and pays Anthropic on the
-- PLATFORM's single API key.
--
-- MCP: those rows are excluded from the generic scheduled-job claim and wait in
-- the queue until the workspace's own Claude leases them over MCP, so the
-- reasoning is billed to the owner's subscription instead.
--
-- Defaulted and NOT NULL so every existing workspace keeps behaving exactly as
-- it does today and no read path has to handle a NULL lane.
ALTER TABLE "workspaces"
  ADD COLUMN "researchExecution" TEXT NOT NULL DEFAULT 'SERVER';
