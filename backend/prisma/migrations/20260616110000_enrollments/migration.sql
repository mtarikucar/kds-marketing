-- Migration: course enrollments + lesson progress (Epic C2)

CREATE TABLE "enrollments" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "courseId"    TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "progressPct" INTEGER NOT NULL DEFAULT 0,
  "enrolledAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enrollments_courseId_leadId_key" ON "enrollments" ("courseId", "leadId");
CREATE INDEX "enrollments_workspaceId_courseId_idx" ON "enrollments" ("workspaceId", "courseId");
CREATE INDEX "enrollments_workspaceId_leadId_idx" ON "enrollments" ("workspaceId", "leadId");
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "lesson_progress" (
  "id"           TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "lessonId"     TEXT NOT NULL,
  "completed"    BOOLEAN NOT NULL DEFAULT false,
  "completedAt"  TIMESTAMP(3),
  CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lesson_progress_enrollmentId_lessonId_key" ON "lesson_progress" ("enrollmentId", "lessonId");
CREATE INDEX "lesson_progress_enrollmentId_completed_idx" ON "lesson_progress" ("enrollmentId", "completed");
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "enrollments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
