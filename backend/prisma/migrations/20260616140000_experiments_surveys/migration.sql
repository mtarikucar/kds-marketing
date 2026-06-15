-- Migration: A/B experiments + surveys (Epic E)

CREATE TABLE "experiments" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "pageId"      TEXT,
  "variants"    JSONB NOT NULL DEFAULT '[]',
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "experiments_workspaceId_status_idx" ON "experiments" ("workspaceId", "status");

CREATE TABLE "experiment_events" (
  "id"           TEXT NOT NULL,
  "experimentId" TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "variantKey"   TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experiment_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "experiment_events_experimentId_variantKey_kind_idx" ON "experiment_events" ("experimentId", "variantKey", "kind");
ALTER TABLE "experiment_events" ADD CONSTRAINT "experiment_events_experimentId_fkey"
  FOREIGN KEY ("experimentId") REFERENCES "experiments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "surveys" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "questions"   JSONB NOT NULL DEFAULT '[]',
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "redirectUrl" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "surveys_workspaceId_status_idx" ON "surveys" ("workspaceId", "status");

CREATE TABLE "survey_responses" (
  "id"          TEXT NOT NULL,
  "surveyId"    TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "leadId"      TEXT,
  "answers"     JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "survey_responses_surveyId_createdAt_idx" ON "survey_responses" ("surveyId", "createdAt");
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_surveyId_fkey"
  FOREIGN KEY ("surveyId") REFERENCES "surveys" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
