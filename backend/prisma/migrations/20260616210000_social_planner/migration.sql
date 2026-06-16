-- Migration: env-gated social planner (social_accounts, social_posts, social_post_targets)
CREATE TABLE "social_accounts" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "network"        TEXT NOT NULL,
  "externalId"     TEXT NOT NULL,
  "displayName"    TEXT NOT NULL,
  "accessToken"    TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_accounts_workspaceId_network_externalId_key" ON "social_accounts" ("workspaceId", "network", "externalId");
CREATE INDEX "social_accounts_workspaceId_network_idx" ON "social_accounts" ("workspaceId", "network");

CREATE TABLE "social_posts" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "content"     TEXT NOT NULL,
  "mediaUrls"   TEXT[] NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "scheduledAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_posts_workspaceId_status_idx" ON "social_posts" ("workspaceId", "status");

CREATE TABLE "social_post_targets" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "postId"          TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "network"         TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "externalPostId"  TEXT,
  "error"           TEXT,
  CONSTRAINT "social_post_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_post_targets_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "social_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "social_post_targets_socialAccountId_fkey"
    FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "social_post_targets_workspaceId_postId_idx" ON "social_post_targets" ("workspaceId", "postId");
CREATE INDEX "social_post_targets_workspaceId_status_idx" ON "social_post_targets" ("workspaceId", "status");
