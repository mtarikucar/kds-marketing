-- NetGSM Phase 6 Task 4 — Netasistan agent self-service (break/queue)
-- presence sync. `telephony_configs.netasistanConfigSealed` holds the sealed
-- {appKey,userKey} for the SEPARATE Netasistan auth realm (app-key+user-key
-- -> a 1h bearer), independent of `configSealed` (the santral
-- username/password) so either can be rotated/cleared without touching the
-- other. `marketing_users.netasistanOptIn` is the per-rep explicit opt-in
-- that makes the existing available/break presence toggle
-- (TelephonyQueueService.setPresence) ALSO call Netasistan setQueue/setBreak,
-- on top of the existing crmsntrl agentlogin/agentpause. Both default to
-- off/null — additive only, no existing data touched.
ALTER TABLE "telephony_configs" ADD COLUMN IF NOT EXISTS "netasistanConfigSealed" TEXT;
ALTER TABLE "marketing_users" ADD COLUMN IF NOT EXISTS "netasistanOptIn" BOOLEAN NOT NULL DEFAULT false;
