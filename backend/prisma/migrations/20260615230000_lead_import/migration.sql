-- Migration: CSV lead import jobs + rows (Epic A5)

CREATE TABLE "import_jobs" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "filename"     TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'MAPPING',
  "mapping"      JSONB,
  "dedupePolicy" TEXT NOT NULL DEFAULT 'SKIP',
  "total"        INTEGER NOT NULL DEFAULT 0,
  "processed"    INTEGER NOT NULL DEFAULT 0,
  "created"      INTEGER NOT NULL DEFAULT 0,
  "updated"      INTEGER NOT NULL DEFAULT 0,
  "skipped"      INTEGER NOT NULL DEFAULT 0,
  "failed"       INTEGER NOT NULL DEFAULT 0,
  "errors"       JSONB,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_jobs_workspaceId_status_idx" ON "import_jobs" ("workspaceId", "status");

CREATE TABLE "import_job_rows" (
  "id"          TEXT NOT NULL,
  "importJobId" TEXT NOT NULL,
  "rowIndex"    INTEGER NOT NULL,
  "raw"         JSONB NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "leadId"      TEXT,
  "error"       TEXT,
  CONSTRAINT "import_job_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_job_rows_importJobId_status_idx" ON "import_job_rows" ("importJobId", "status");

ALTER TABLE "import_job_rows"
  ADD CONSTRAINT "import_job_rows_importJobId_fkey" FOREIGN KEY ("importJobId")
  REFERENCES "import_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
