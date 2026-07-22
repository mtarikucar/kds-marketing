-- Strategy Engine — per-workspace connected community channels (Discord webhook /
-- Reddit OAuth) the COMMUNITY_ENGAGE executor posts to (OWNED channels only).
-- One row per (workspace, provider). Secrets are AES-256-GCM sealed at rest.
-- Additive; no changes to existing tables.
CREATE TABLE IF NOT EXISTS "community_channel_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sealedSecret" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "community_channel_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "community_channel_configs_workspaceId_provider_key" ON "community_channel_configs"("workspaceId", "provider");
CREATE INDEX IF NOT EXISTS "community_channel_configs_workspaceId_idx" ON "community_channel_configs"("workspaceId");
