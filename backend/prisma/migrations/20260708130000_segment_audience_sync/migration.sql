-- CRM segment → ad-platform Custom Audience sync state. One row per
-- (segment, adAccount) so a re-sync reuses the same Meta audience id.
CREATE TABLE "segment_audience_syncs" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "segmentId"           TEXT NOT NULL,
  "adAccountId"         TEXT NOT NULL,
  "provider"            TEXT NOT NULL,
  "externalAudienceId"  TEXT,
  "lookalikeAudienceId" TEXT,
  "status"              TEXT NOT NULL DEFAULT 'PENDING',
  "lastCount"           INTEGER,
  "lastError"           TEXT,
  "lastSyncedAt"        TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "segment_audience_syncs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "segment_audience_syncs_segmentId_adAccountId_key"
  ON "segment_audience_syncs" ("segmentId", "adAccountId");
CREATE INDEX "segment_audience_syncs_workspaceId_idx"
  ON "segment_audience_syncs" ("workspaceId");
