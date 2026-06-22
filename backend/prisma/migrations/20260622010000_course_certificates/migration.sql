-- Epic 10b: completion certificates. Additive — new table + defaulted/nullable columns.
ALTER TABLE "courses" ADD COLUMN "certificateEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "courses" ADD COLUMN "certificateTemplate" JSONB;

CREATE TABLE "certificates" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "courseId"     TEXT NOT NULL,
  "leadId"       TEXT NOT NULL,
  "serial"       TEXT NOT NULL,
  "issuedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pdfUrl"       TEXT,
  CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "certificates_serial_key" ON "certificates"("serial");
-- One certificate per (course, lead) completion — keyed on the stable business
-- identity, not the enrollment row (which an unenroll+re-enroll would change).
CREATE UNIQUE INDEX "certificates_workspaceId_courseId_leadId_key"
  ON "certificates"("workspaceId", "courseId", "leadId");

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
