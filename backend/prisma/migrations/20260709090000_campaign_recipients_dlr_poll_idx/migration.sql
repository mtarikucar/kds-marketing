-- Covers netgsm-dlr-poll.service.ts's every-minute pollV2Campaigns
-- reconciliation query (workspaceId + deliveryStatus IS NULL + netgsmJobId
-- NOT NULL + sentAt >= now-72h), which previously had no covering index.
--
-- A partial index on (workspaceId, sentAt) WHERE deliveryStatus IS NULL AND
-- netgsmJobId IS NOT NULL would be the tighter fit, but schema.prisma has no
-- syntax for a partial/filtered index, and CI's migrations<->schema parity
-- gate (`prisma migrate diff --from-migrations --to-schema-datamodel
-- --exit-code`) always flags a DB index absent from the datamodel as drift,
-- regardless of its WHERE clause — a raw-SQL-only partial index would fail
-- that gate. This is a plain composite index instead, matching
-- `@@index([workspaceId, deliveryStatus, sentAt])` on CampaignRecipient in
-- schema.prisma, so it round-trips clean.
CREATE INDEX IF NOT EXISTS "campaign_recipients_workspaceId_deliveryStatus_sentAt_idx"
  ON "campaign_recipients"("workspaceId", "deliveryStatus", "sentAt");
