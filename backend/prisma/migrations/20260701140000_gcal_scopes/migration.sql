-- Phase 4: record the OAuth scopes Google granted per connection so advanced
-- Meet (meetings.space.created — recording/transcript/co-host) can be gated on
-- their presence. Additive + nullable; existing connections keep the base
-- calendar scope behaviour until re-consented.
ALTER TABLE "google_calendar_connections" ADD COLUMN "scopes" TEXT;
