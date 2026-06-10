-- Phase E: research profiles (customer-authored ICP prompts), per-workspace
-- ingest tokens (hashed) and daily usage counters for lead-quota clipping.

-- CreateTable
CREATE TABLE "research_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "icpDescription" TEXT NOT NULL,
    "productPitch" TEXT,
    "geo" JSONB,
    "language" TEXT NOT NULL DEFAULT 'en',
    "businessTypes" JSONB,
    "exclusions" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_tokens" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ingest_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_profiles_workspaceId_status_idx" ON "research_profiles"("workspaceId", "status");
CREATE UNIQUE INDEX "ingest_tokens_tokenHash_key" ON "ingest_tokens"("tokenHash");
CREATE INDEX "ingest_tokens_workspaceId_idx" ON "ingest_tokens"("workspaceId");
CREATE UNIQUE INDEX "usage_counters_workspaceId_metric_periodKey_key" ON "usage_counters"("workspaceId", "metric", "periodKey");
