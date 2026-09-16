-- Why the AI stayed silent, kept where the inbox can read it.
-- `decline()` (conversation-ai-engine.service.ts) has always named the gate it
-- closed — paused thread, no agent attached, no usable key — but only to the
-- server log, so the one person who could act on it never saw it.
-- Both columns are nullable and written ONLY by that decline path.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "aiLastDeclineReason" TEXT,
ADD COLUMN IF NOT EXISTS "aiLastDeclineAt" TIMESTAMP(3);
