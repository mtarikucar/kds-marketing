-- NetGSM Phase 5 Task 5: parallel auto-dialer session state. Additive only;
-- no existing data touched.
--
-- autocall_sessions: one NetGSM "Devamlı Dinamik" autocall-list run per row.
-- netgsmListId is the id AutocallClient.addAutocall returned; iysfilter is the
-- classification the list was created with (mandatory — see AutocallClient).
CREATE TABLE IF NOT EXISTS "autocall_sessions" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "startedByUserId" TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "netgsmListId"    TEXT NOT NULL,
  "queueName"       TEXT NOT NULL,
  "iysfilter"       TEXT NOT NULL,
  "brandCode"       TEXT,
  "retryCount"      INTEGER,
  "total"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "stoppedAt"       TIMESTAMP(3),
  CONSTRAINT "autocall_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "autocall_sessions_workspaceId_status_idx"
  ON "autocall_sessions"("workspaceId", "status");

-- autocall_session_items: one lead streamed into the session's NetGSM list.
-- lastAttemptStatus/lastUniqueId/attemptedAt are populated by the per-attempt
-- webhook consumer and only ever reflect the MOST RECENT attempt (no full
-- attempt history — kept minimal per the Task 5 scope decision).
CREATE TABLE IF NOT EXISTS "autocall_session_items" (
  "id"                TEXT NOT NULL,
  "workspaceId"       TEXT NOT NULL,
  "autocallSessionId" TEXT NOT NULL,
  "leadId"            TEXT NOT NULL,
  "phone"             TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "lastAttemptStatus" TEXT,
  "lastUniqueId"      TEXT,
  "attemptedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "autocall_session_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "autocall_session_items_autocallSessionId_leadId_key"
  ON "autocall_session_items"("autocallSessionId", "leadId");

CREATE INDEX IF NOT EXISTS "autocall_session_items_workspaceId_idx"
  ON "autocall_session_items"("workspaceId");

ALTER TABLE "autocall_session_items" ADD CONSTRAINT "autocall_session_items_autocallSessionId_fkey"
  FOREIGN KEY ("autocallSessionId") REFERENCES "autocall_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
