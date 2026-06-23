-- Epic 12: Outlook/O365 calendar connection (inert until MS_OAUTH creds). New table.
CREATE TABLE "outlook_calendar_connections" (
  "id"                     TEXT NOT NULL,
  "workspaceId"            TEXT NOT NULL,
  "marketingUserId"        TEXT NOT NULL,
  "outlookCalendarId"      TEXT NOT NULL DEFAULT 'primary',
  "accessToken"            TEXT NOT NULL,
  "refreshToken"           TEXT NOT NULL,
  "tokenExpiresAt"         TIMESTAMP(3) NOT NULL,
  "deltaToken"             TEXT,
  "subscriptionId"         TEXT,
  "clientState"            TEXT,
  "subscriptionExpiration" TIMESTAMP(3),
  "enabled"                BOOLEAN NOT NULL DEFAULT true,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outlook_calendar_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outlook_calendar_connections_workspaceId_idx" ON "outlook_calendar_connections"("workspaceId");
CREATE INDEX "outlook_calendar_connections_workspaceId_marketingUserId_idx" ON "outlook_calendar_connections"("workspaceId", "marketingUserId");
CREATE UNIQUE INDEX "outlook_calendar_connections_subscriptionId_key" ON "outlook_calendar_connections"("subscriptionId");
