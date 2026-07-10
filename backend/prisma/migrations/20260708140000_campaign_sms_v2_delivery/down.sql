-- Manual rollback for 20260708140000_campaign_sms_v2_delivery (Prisma migrate
-- is forward-only; run by hand to revert). Drops exactly what the up added.
DROP INDEX IF EXISTS "campaign_recipients_campaignId_netgsmJobId_idx";

ALTER TABLE "campaign_recipients"
  DROP COLUMN IF EXISTS "netgsmJobId",
  DROP COLUMN IF EXISTS "referansId",
  DROP COLUMN IF EXISTS "deliveryStatus",
  DROP COLUMN IF EXISTS "deliveredAt",
  DROP COLUMN IF EXISTS "errorCode";

ALTER TABLE "campaigns"
  DROP COLUMN IF EXISTS "iysMessageType",
  DROP COLUMN IF EXISTS "netgsmJobIds";
