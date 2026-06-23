-- Epic 10c: membership gamification (points ledger + badges). Additive: new tables only.
CREATE TABLE "points_ledger" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "source"      TEXT NOT NULL,
  "points"      INTEGER NOT NULL,
  "refId"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "points_ledger_workspaceId_leadId_source_refId_key"
  ON "points_ledger"("workspaceId", "leadId", "source", "refId");
CREATE INDEX "points_ledger_workspaceId_leadId_idx" ON "points_ledger"("workspaceId", "leadId");

CREATE TABLE "badges" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "iconUrl"     TEXT,
  "ruleType"    TEXT NOT NULL,
  "threshold"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "badges_workspaceId_key_key" ON "badges"("workspaceId", "key");
CREATE INDEX "badges_workspaceId_idx" ON "badges"("workspaceId");

CREATE TABLE "earned_badges" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "badgeId"     TEXT NOT NULL,
  "earnedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "earned_badges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "earned_badges_workspaceId_leadId_badgeId_key" ON "earned_badges"("workspaceId", "leadId", "badgeId");
CREATE INDEX "earned_badges_workspaceId_leadId_idx" ON "earned_badges"("workspaceId", "leadId");
