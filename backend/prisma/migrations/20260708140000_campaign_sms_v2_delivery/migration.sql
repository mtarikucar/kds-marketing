-- NetGSM SMS v2 (Phase 1): campaign delivery tracking + İYS message
-- classification. Additive only; no changes to existing columns.
--
-- campaign_recipients: netgsmJobId = the v2 batch jobid this recipient was
-- sent under; referansId = per-recipient correlation id echoed back on
-- report rows (= this recipient's id); deliveryStatus/deliveredAt/errorCode
-- are populated from the DLR poll.
ALTER TABLE "campaign_recipients"
  ADD COLUMN IF NOT EXISTS "netgsmJobId" TEXT,
  ADD COLUMN IF NOT EXISTS "referansId" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "errorCode" TEXT;

CREATE INDEX IF NOT EXISTS "campaign_recipients_campaignId_netgsmJobId_idx"
  ON "campaign_recipients"("campaignId", "netgsmJobId");

-- campaigns: iysMessageType classifies SMS sends for the Phase 2 İYS
-- compliance layer (TICARI | BILGILENDIRME); column lands now to avoid a
-- second migration. netgsmJobIds is the string[] of v2 batch jobids fed to
-- the stats reconciler.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "iysMessageType" TEXT NOT NULL DEFAULT 'BILGILENDIRME',
  ADD COLUMN IF NOT EXISTS "netgsmJobIds" JSONB;
