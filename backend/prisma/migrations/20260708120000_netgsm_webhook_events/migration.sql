-- NetGSM hub: raw inbound webhook archive + idempotency guard. Additive only;
-- no changes to existing tables.
CREATE TABLE IF NOT EXISTS "netgsm_webhook_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "netgsm_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "netgsm_webhook_events_workspaceId_purpose_externalId_key"
  ON "netgsm_webhook_events"("workspaceId", "purpose", "externalId");
CREATE INDEX IF NOT EXISTS "netgsm_webhook_events_workspaceId_receivedAt_idx"
  ON "netgsm_webhook_events"("workspaceId", "receivedAt");
