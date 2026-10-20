-- Commerce ingest (contract: docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md §2).
-- Purely additive: three new tables, no column on any existing table, so
-- down.sql loses nothing but the rows of these tables. Idempotent — every
-- statement is a no-op when its object already exists.

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_sources" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "signingSecret" TEXT NOT NULL,
    "previousSecret" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "commerce_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "external_orders" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "groupRef" TEXT,
    "status" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "items" JSONB,
    "orderedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "leadId" TEXT,
    "attribution" JSONB,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "external_order_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_sources_workspaceId_slug_key" ON "commerce_sources"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "external_orders_workspaceId_status_paidAt_idx" ON "external_orders"("workspaceId", "status", "paidAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "external_orders_workspaceId_leadId_idx" ON "external_orders"("workspaceId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "external_orders_workspaceId_sourceId_externalId_key" ON "external_orders"("workspaceId", "sourceId", "externalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "external_order_events_workspaceId_receivedAt_idx" ON "external_order_events"("workspaceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "external_order_events_sourceId_eventId_key" ON "external_order_events"("sourceId", "eventId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_orders_sourceId_fkey') THEN
        ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "commerce_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_orders_leadId_fkey') THEN
        ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_order_events_sourceId_fkey') THEN
        ALTER TABLE "external_order_events" ADD CONSTRAINT "external_order_events_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "commerce_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_order_events_orderId_fkey') THEN
        ALTER TABLE "external_order_events" ADD CONSTRAINT "external_order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "external_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
