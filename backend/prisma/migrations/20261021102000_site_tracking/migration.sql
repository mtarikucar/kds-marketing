-- site snippet keys and the anonymous daily page-view counter (contract: docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md).
-- Purely additive: new tables only, no column on any existing table, so
-- down.sql loses nothing but these tables' rows. Idempotent.

-- CreateTable
CREATE TABLE IF NOT EXISTS "site_tracking_keys" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "allowedHosts" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "site_tracking_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "site_traffic_daily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "siteKeyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '(direct)',
    "medium" TEXT NOT NULL DEFAULT '',
    "campaign" TEXT NOT NULL DEFAULT '',
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "site_traffic_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "site_tracking_keys_key_key" ON "site_tracking_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "site_tracking_keys_workspaceId_idx" ON "site_tracking_keys"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "site_traffic_daily_workspaceId_date_idx" ON "site_traffic_daily"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "site_traffic_daily_siteKeyId_date_path_source_medium_campai_key" ON "site_traffic_daily"("siteKeyId", "date", "path", "source", "medium", "campaign");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_traffic_daily_siteKeyId_fkey') THEN
        ALTER TABLE "site_traffic_daily" ADD CONSTRAINT "site_traffic_daily_siteKeyId_fkey" FOREIGN KEY ("siteKeyId") REFERENCES "site_tracking_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
