-- Migration: env-gated Google Calendar 2-way sync (OAuth, push + pull)
--
-- One GoogleCalendarConnection row per (workspace, marketingUser, googleCalendar).
-- accessToken / refreshToken are stored SEALED (AES-256-GCM secret-box) and are
-- NEVER returned by the API. syncToken drives incremental pulls; channelId/
-- resourceId back the optional push-webhook (Google watch channel).
CREATE TABLE "google_calendar_connections" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "marketingUserId" TEXT NOT NULL,
  "googleCalendarId" TEXT NOT NULL DEFAULT 'primary',
  "accessToken"     TEXT NOT NULL,
  "refreshToken"    TEXT NOT NULL,
  "tokenExpiresAt"  TIMESTAMP(3) NOT NULL,
  "syncToken"       TEXT,
  "channelId"       TEXT,
  "resourceId"      TEXT,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "google_calendar_connections_workspaceId_idx"
  ON "google_calendar_connections" ("workspaceId");
CREATE INDEX "google_calendar_connections_workspaceId_marketingUserId_idx"
  ON "google_calendar_connections" ("workspaceId", "marketingUserId");
-- The push-webhook receiver resolves the connection by Google's channel id.
CREATE UNIQUE INDEX "google_calendar_connections_channelId_key"
  ON "google_calendar_connections" ("channelId");

-- Link an our-side Booking to its mirrored Google event so push patch/delete is
-- idempotent and pull can recognise events it created (avoids echo loops).
ALTER TABLE "bookings" ADD COLUMN "googleEventId" TEXT;
-- Pulled "busy" blocks from Google share the bookings table (status
-- EXTERNAL_BUSY) keyed by googleEventId; this makes the upsert-by-event cheap.
CREATE INDEX "bookings_workspaceId_googleEventId_idx"
  ON "bookings" ("workspaceId", "googleEventId");
