-- Migration: saved lead segments (Epic A3)

CREATE TABLE "segments" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "kind"            TEXT NOT NULL DEFAULT 'DYNAMIC',
  "definition"      JSONB NOT NULL,
  "lastCount"       INTEGER,
  "lastEvaluatedAt" TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "segments_workspaceId_idx" ON "segments" ("workspaceId");
