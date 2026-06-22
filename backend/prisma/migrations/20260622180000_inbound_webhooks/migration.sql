-- Epic 4c: inbound webhook trigger (GoHighLevel parity).
-- New table only — additive, safe to deploy ahead of the code on one replica.
CREATE TABLE "inbound_webhooks" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "secretHash"     TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "lastReceivedAt" TIMESTAMP(3),
  "receivedCount"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbound_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_webhooks_slug_key" ON "inbound_webhooks"("slug");
CREATE INDEX "inbound_webhooks_workspaceId_idx" ON "inbound_webhooks"("workspaceId");
