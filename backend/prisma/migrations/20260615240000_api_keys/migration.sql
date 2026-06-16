-- Migration: workspace-scoped programmatic API keys (Epic B1)

CREATE TABLE "api_keys" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "keyHash"     TEXT NOT NULL,
  "prefix"      TEXT NOT NULL,
  "scopes"      JSONB NOT NULL DEFAULT '["read", "write"]',
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastUsedAt"  TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"   TIMESTAMP(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys" ("keyHash");
CREATE INDEX "api_keys_workspaceId_status_idx" ON "api_keys" ("workspaceId", "status");
