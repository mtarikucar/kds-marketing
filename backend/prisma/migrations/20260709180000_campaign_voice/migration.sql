-- NetGSM Phase 5 Task 2: VOICE campaign channel — TTS/audio blasts via
-- voicesms/send. Additive only; no existing data touched.
--
-- campaigns.voiceConfig: `{ msg?, audioid?, keys? }` — validated in
-- CampaignsService (msg-or-audioid required for a VOICE campaign), not at
-- the DB level. Unused by every other channel.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "voiceConfig" JSONB;

-- campaign_recipients: outcome fields the Task 3 voice-report webhook
-- populates (voice PUSHES call outcomes, unlike SMS's poll-based DLR).
-- Deliberately separate from netgsmJobId/referansId (the SMS v2 DLR-poll
-- reconciler's own signal — see the schema.prisma docstring on this model).
ALTER TABLE "campaign_recipients"
  ADD COLUMN IF NOT EXISTS "voiceState" TEXT,
  ADD COLUMN IF NOT EXISTS "pushButton" TEXT,
  ADD COLUMN IF NOT EXISTS "talkSec" INTEGER;
