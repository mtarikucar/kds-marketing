-- Migration: agency config snapshots (GoHighLevel "snapshot" parity).
--
-- Additive only: one new table `snapshots`. A snapshot is workspace-OWNED by the
-- AGENCY that captured it (`workspaceId` is the agency's id, carrying the same
-- workspaceId-scoping invariant as every other owned delegate). `payload` is the
-- captured CONFIG (not customer data) as portable JSON. No FK to `workspaces`,
-- matching this schema's soft-reference style (the agency relationship is bounded
-- by the service layer's workspaceId scoping + assertAgencyOwns on apply, not a
-- DB cascade).

CREATE TABLE "snapshots" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "payload"     JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "snapshots_workspaceId_idx" ON "snapshots" ("workspaceId");
