-- Brand Brain: the workspace's consolidated brand/product profile (structured
-- header). Additive; no changes to existing tables.
CREATE TABLE IF NOT EXISTS "brand_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT,
    "valueProps" JSONB,
    "toneWords" JSONB,
    "voiceGuide" TEXT,
    "icpDescription" TEXT,
    "audienceObjections" JSONB,
    "offerings" JSONB,
    "sources" JSONB,
    "socialHandles" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brand_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brand_profiles_workspaceId_key" ON "brand_profiles"("workspaceId");
