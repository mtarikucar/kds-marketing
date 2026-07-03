-- AI Research engine: the human-review suggestions queue. Candidates land here
-- PENDING; on accept they are ingested into Lead, on reject they are dismissed.
CREATE TABLE "research_candidates" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "profileId"     TEXT NOT NULL,
  "agentRunId"    TEXT,
  "externalRef"   TEXT NOT NULL,
  "businessName"  TEXT NOT NULL,
  "city"          TEXT,
  "region"        TEXT,
  "businessType"  TEXT NOT NULL,
  "phone"         TEXT,
  "instagram"     TEXT,
  "website"       TEXT,
  "email"         TEXT,
  "branchCount"   INTEGER,
  "currentSystem" TEXT,
  "stage"         TEXT,
  "priority"      TEXT NOT NULL DEFAULT 'MEDIUM',
  "painPoint"     TEXT NOT NULL,
  "evidence"      TEXT NOT NULL,
  "pitch"         TEXT NOT NULL,
  "score"         DOUBLE PRECISION,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "leadId"        TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"     TIMESTAMP(3),
  CONSTRAINT "research_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_candidates_workspaceId_profileId_externalRef_key"
  ON "research_candidates" ("workspaceId", "profileId", "externalRef");
CREATE INDEX "research_candidates_workspaceId_status_createdAt_idx"
  ON "research_candidates" ("workspaceId", "status", "createdAt");
