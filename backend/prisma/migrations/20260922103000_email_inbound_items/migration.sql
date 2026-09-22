-- One row per inbound item the pipeline EXAMINED — ingested, skipped, failed or
-- quarantined.
-- Today a mail that throws mid-ingest leaves a logger.warn and nothing else, so
-- "where did my customer's mail go?" has no answer anyone can give a tenant.
-- state + reason + attempts is that answer, and the row is what the retry job
-- re-fetches (dedupKey inbound:<id>) before it gives up and quarantines.
-- The unique on (channelId, source, itemKey) is what keeps a re-poll of the same
-- uid from writing a second row; the IMAP cursor itself stays in
-- channel.configPublic, so losing this table loses the ledger, never the position.

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_inbound_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "messageId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "fromAddress" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_inbound_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_inbound_items_workspaceId_state_updatedAt_idx" ON "email_inbound_items"("workspaceId", "state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_inbound_items_channelId_source_itemKey_key" ON "email_inbound_items"("channelId", "source", "itemKey");
