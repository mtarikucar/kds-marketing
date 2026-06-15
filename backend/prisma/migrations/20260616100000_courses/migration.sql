-- Migration: courses + modules + lessons (Epic C1)

CREATE TABLE "courses" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "description"   TEXT,
  "status"        TEXT NOT NULL DEFAULT 'DRAFT',
  "priceCents"    INTEGER,
  "currency"      TEXT,
  "coverImageUrl" TEXT,
  "position"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "courses_workspaceId_slug_key" ON "courses" ("workspaceId", "slug");
CREATE INDEX "courses_workspaceId_status_idx" ON "courses" ("workspaceId", "status");

CREATE TABLE "course_modules" (
  "id"       TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "title"    TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "course_modules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "course_modules_courseId_position_idx" ON "course_modules" ("courseId", "position");
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "lessons" (
  "id"          TEXT NOT NULL,
  "moduleId"    TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "type"        TEXT NOT NULL DEFAULT 'VIDEO',
  "content"     TEXT,
  "videoUrl"    TEXT,
  "durationSec" INTEGER,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "isPreview"   BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lessons_moduleId_position_idx" ON "lessons" ("moduleId", "position");
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_moduleId_fkey"
  FOREIGN KEY ("moduleId") REFERENCES "course_modules" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
