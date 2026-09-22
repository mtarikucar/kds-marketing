-- Reverts 20260922102000_campaign_recipient_channel_feedback exactly: the four
-- nullable columns it added to "campaign_recipients". Idempotent, and a safe
-- no-op if already reverted.
-- The backfill disappears with the column it filled, and "channel" is derivable
-- again from the campaign on the next roll-forward. No recipient row is deleted
-- and no column the sender writes (status, sentAt, messageId, error) is touched.
ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "mailLogId",
DROP COLUMN IF EXISTS "complainedAt",
DROP COLUMN IF EXISTS "bouncedAt",
DROP COLUMN IF EXISTS "channel";
