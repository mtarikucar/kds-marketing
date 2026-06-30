-- AI Social Content Studio (Milestone 1): Brand Kit + generated media assets.
-- Additive only; no changes to existing tables.
CREATE TABLE "brand_kits" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "logoR2Key" TEXT,
    "palette" JSONB,
    "tone" TEXT,
    "referenceImages" JSONB NOT NULL DEFAULT '[]',
    "defaultHashtags" TEXT[],
    "defaultCta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_kits_workspaceId_key" ON "brand_kits"("workspaceId");

CREATE TABLE "generated_assets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "url" TEXT,
    "r2Key" TEXT,
    "mime" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "thumbnailUrl" TEXT,
    "thumbnailR2Key" TEXT,
    "costCredits" INTEGER,
    "costCreditsReserved" INTEGER,
    "costUsd" DECIMAL(10,4),
    "error" TEXT,
    "socialCampaignId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "generated_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "generated_assets_workspaceId_status_idx" ON "generated_assets"("workspaceId", "status");
CREATE INDEX "generated_assets_providerRequestId_idx" ON "generated_assets"("providerRequestId");
