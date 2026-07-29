-- MCP Faz 3 — OAuth 2.1 authorization server storage: the CIMD client cache,
-- single-use authorization codes and the issued access/refresh tokens.
-- Additive only: no existing table or column is touched, so the existing
-- `mk_live_…` API-key path is unaffected. Every statement is guarded so the
-- migration is re-runnable.

-- CIMD (Client ID Metadata Document) cache — one row per client_id URL.
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT,
    "redirectUris" JSONB NOT NULL,
    "metadata" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_clients_clientId_key" ON "mcp_oauth_clients"("clientId");

-- Authorization codes. Hashed at rest (ApiKey.keyHash convention); single-use
-- via consumedAt; PKCE challenge is mandatory (S256 only).
CREATE TABLE IF NOT EXISTS "mcp_oauth_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_oauth_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_codes_codeHash_key" ON "mcp_oauth_codes"("codeHash");
CREATE INDEX IF NOT EXISTS "mcp_oauth_codes_workspaceId_idx" ON "mcp_oauth_codes"("workspaceId");

-- Access + refresh tokens. Hashed at rest; refresh rotation chains via parentId
-- so replaying a revoked refresh can revoke the whole family.
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_oauth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_tokens_tokenHash_key" ON "mcp_oauth_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_workspaceId_type_idx" ON "mcp_oauth_tokens"("workspaceId", "type");
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_parentId_idx" ON "mcp_oauth_tokens"("parentId");
