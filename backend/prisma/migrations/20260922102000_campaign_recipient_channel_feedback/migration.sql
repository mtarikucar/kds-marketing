-- What actually happened to one campaign recipient, on the recipient row.
-- `status` says how the send went; a bounce or a complaint arrives minutes or
-- hours later, from a DSN in the tenant's own mailbox or an ESP webhook, and
-- there is nowhere to put it. `mailLogId` is the hop that lets it land:
-- Message-ID -> mail_log -> this row.
-- `channel` is frozen here at launch so a feedback event does not have to join
-- back through "campaigns" to learn what was sent, and so editing a campaign's
-- channel never rewrites what a recipient already received.

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "channel" TEXT,
ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "complainedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "mailLogId" TEXT;

-- Backfill: existing recipients get their campaign's channel, which is the
-- value they were sent under. Bounded by "channel" IS NULL, so it touches each
-- row once and a re-run (or a re-deploy of this migration) is a no-op that
-- cannot overwrite a value the sender has since written.
UPDATE "campaign_recipients" r
   SET "channel" = c."channel"
  FROM "campaigns" c
 WHERE c."id" = r."campaignId"
   AND r."channel" IS NULL;
