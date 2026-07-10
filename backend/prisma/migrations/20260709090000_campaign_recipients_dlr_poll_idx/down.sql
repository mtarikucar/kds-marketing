-- Manual rollback for 20260709090000_campaign_recipients_dlr_poll_idx
-- (Prisma migrate is forward-only; run by hand to revert). Drops exactly
-- the index the up added.
DROP INDEX IF EXISTS "campaign_recipients_workspaceId_deliveryStatus_sentAt_idx";
