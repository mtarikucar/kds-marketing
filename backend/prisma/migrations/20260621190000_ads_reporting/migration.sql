-- Migration: Ads reporting — Meta Ads + TikTok Ads (GoHighLevel parity)
--
-- A workspace connects its own ad account (per-tenant sealed token); a periodic
-- sweep pulls spend/impressions/clicks/leads into ad_metrics for reporting. New
-- tables only — purely additive, safe online migration. The (adAccountId, date,
-- campaignId) unique index makes a re-pull idempotent (upsert, never duplicate).

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "externalAdId"   TEXT NOT NULL,
    "displayName"    TEXT NOT NULL,
    "accessToken"    TEXT NOT NULL,
    "refreshToken"   TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
    "currency"       TEXT,
    "lastPulledAt"   TIMESTAMP(3),
    "lastError"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_metrics" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "date"        DATE NOT NULL,
    "campaignId"  TEXT NOT NULL DEFAULT '',
    "spend"       DECIMAL(14,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks"      INTEGER NOT NULL DEFAULT 0,
    "leads"       INTEGER NOT NULL DEFAULT 0,
    "rawMetrics"  JSONB,
    "pulledAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_workspaceId_provider_externalAdId_key" ON "ad_accounts"("workspaceId", "provider", "externalAdId");
CREATE INDEX "ad_accounts_workspaceId_provider_idx" ON "ad_accounts"("workspaceId", "provider");
CREATE INDEX "ad_accounts_status_lastPulledAt_idx" ON "ad_accounts"("status", "lastPulledAt");

CREATE UNIQUE INDEX "ad_metrics_adAccountId_date_campaignId_key" ON "ad_metrics"("adAccountId", "date", "campaignId");
CREATE INDEX "ad_metrics_workspaceId_date_idx" ON "ad_metrics"("workspaceId", "date");

-- AddForeignKey
ALTER TABLE "ad_metrics" ADD CONSTRAINT "ad_metrics_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
