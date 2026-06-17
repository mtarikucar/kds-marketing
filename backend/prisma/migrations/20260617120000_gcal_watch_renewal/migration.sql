-- Migration: real-time Google Calendar push (events.watch) — renewal + verification
--
-- Adds the two fields the push-channel lifecycle needs on top of the existing
-- channelId/resourceId:
--   channelToken      — a per-channel verification nonce we send to Google in the
--                       watch request and validate against the incoming webhook's
--                       X-Goog-Channel-Token header (rejects forged notifications).
--   channelExpiration — when the Google watch channel expires; the renewal cron
--                       re-registers a fresh channel before this passes so the
--                       real-time push never silently lapses.
-- Both are nullable/additive — safe online migration, no backfill, no downtime.
ALTER TABLE "google_calendar_connections"
  ADD COLUMN "channelToken"      TEXT,
  ADD COLUMN "channelExpiration" TIMESTAMP(3);
