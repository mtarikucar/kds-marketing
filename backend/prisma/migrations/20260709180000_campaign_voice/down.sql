-- Manual rollback for 20260709180000_campaign_voice (Prisma migrate is
-- forward-only; run by hand to revert). Drops exactly what the up added.
ALTER TABLE "campaign_recipients"
  DROP COLUMN IF EXISTS "voiceState",
  DROP COLUMN IF EXISTS "pushButton",
  DROP COLUMN IF EXISTS "talkSec";

ALTER TABLE "campaigns"
  DROP COLUMN IF EXISTS "voiceConfig";
