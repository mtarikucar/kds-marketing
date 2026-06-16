-- Migration: env-gated enterprise SSO via OIDC (Epic G)
-- One SsoConnection row per workspace IdP. clientSecret is stored SEALED
-- (AES-256-GCM secret-box) and never returned by the API.

CREATE TABLE "sso_connections" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "provider"       TEXT NOT NULL DEFAULT 'OIDC',
  "issuer"         TEXT NOT NULL,
  "clientId"       TEXT NOT NULL,
  "clientSecret"   TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT false,
  "allowedDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sso_connections_workspaceId_idx" ON "sso_connections" ("workspaceId");
CREATE INDEX "sso_connections_workspaceId_enabled_idx" ON "sso_connections" ("workspaceId", "enabled");
