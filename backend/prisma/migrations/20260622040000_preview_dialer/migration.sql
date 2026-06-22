-- Epic 11b: preview dialer. Additive: two new tables only.
CREATE TABLE "dial_sessions" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "marketingUserId" TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "currentIndex"    INTEGER NOT NULL DEFAULT 0,
  "total"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dial_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dial_sessions_workspaceId_marketingUserId_idx" ON "dial_sessions"("workspaceId", "marketingUserId");

CREATE TABLE "dial_session_items" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "dialSessionId" TEXT NOT NULL,
  "leadId"        TEXT NOT NULL,
  "position"      INTEGER NOT NULL,
  "outcome"       TEXT,
  "callId"        TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dial_session_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dial_session_items_dialSessionId_position_key" ON "dial_session_items"("dialSessionId", "position");
CREATE INDEX "dial_session_items_workspaceId_idx" ON "dial_session_items"("workspaceId");

ALTER TABLE "dial_session_items" ADD CONSTRAINT "dial_session_items_dialSessionId_fkey"
  FOREIGN KEY ("dialSessionId") REFERENCES "dial_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
