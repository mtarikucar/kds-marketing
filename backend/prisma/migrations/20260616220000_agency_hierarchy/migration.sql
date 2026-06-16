-- Migration: agency / sub-account hierarchy (Epic D1, GoHighLevel parity).
--
-- Additive only: two nullable columns on the existing `workspaces` table plus a
-- supporting index. No data migration — every existing row defaults to
-- STANDALONE with a NULL parent, so current single-workspace tenancy is
-- unchanged. `kind` is a TEXT column (matching the status-string convention),
-- `parentWorkspaceId` is a nullable self-reference (no FK cascade, matching the
-- codebase's soft-reference style; workspace closure stays a status flip).

ALTER TABLE "workspaces"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STANDALONE';

ALTER TABLE "workspaces"
  ADD COLUMN "parentWorkspaceId" TEXT;

CREATE INDEX "workspaces_parentWorkspaceId_idx"
  ON "workspaces" ("parentWorkspaceId");
