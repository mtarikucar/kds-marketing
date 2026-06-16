-- Migration: outbound webhook endpoints + deliveries (Epic B2)

CREATE TABLE "webhook_endpoints" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "url"            TEXT NOT NULL,
  "events"         JSONB NOT NULL DEFAULT '[]',
  "secret"         TEXT NOT NULL,
  "description"    TEXT,
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "failureCount"   INTEGER NOT NULL DEFAULT 0,
  "lastDeliveryAt" TIMESTAMP(3),
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_endpoints_workspaceId_status_idx" ON "webhook_endpoints" ("workspaceId", "status");

CREATE TABLE "webhook_deliveries" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "endpointId"   TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "eventType"    TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "responseCode" INTEGER,
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "error"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt"  TIMESTAMP(3),
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_deliveries_endpointId_status_idx" ON "webhook_deliveries" ("endpointId", "status");
CREATE INDEX "webhook_deliveries_workspaceId_createdAt_idx" ON "webhook_deliveries" ("workspaceId", "createdAt");
