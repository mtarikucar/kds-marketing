-- Migration: Slack incoming-webhook integrations (Epic B4)

CREATE TABLE "slack_integrations" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "webhookUrl"     TEXT NOT NULL,
  "channel"        TEXT,
  "events"         JSONB NOT NULL DEFAULT '[]',
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastNotifiedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "slack_integrations_workspaceId_status_idx" ON "slack_integrations" ("workspaceId", "status");
