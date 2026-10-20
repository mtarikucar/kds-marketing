-- GA4 connection (sealed OAuth tokens) and daily stats (contract: docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md).
-- Purely additive: new tables only, no column on any existing table, so
-- down.sql loses nothing but these tables' rows. Idempotent.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ga4_connections" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "marketingUserId" TEXT NOT NULL,
    "googleEmail" TEXT,
    "propertyId" TEXT,
    "propertyName" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ga4_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ga4_daily_stats" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "totalUsers" INTEGER NOT NULL DEFAULT 0,
    "newUsers" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "purchaseCount" INTEGER NOT NULL DEFAULT 0,
    "purchaseValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3),
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ga4_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ga4_connections_workspaceId_key" ON "ga4_connections"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ga4_daily_stats_workspaceId_date_idx" ON "ga4_daily_stats"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ga4_daily_stats_workspaceId_propertyId_date_dimension_key_key" ON "ga4_daily_stats"("workspaceId", "propertyId", "date", "dimension", "key");
