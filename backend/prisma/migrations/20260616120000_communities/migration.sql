-- Migration: community spaces + members + posts + comments (Epic C3)

CREATE TABLE "communities" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "description" TEXT,
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "communities_workspaceId_slug_key" ON "communities" ("workspaceId", "slug");
CREATE INDEX "communities_workspaceId_status_idx" ON "communities" ("workspaceId", "status");

CREATE TABLE "community_members" (
  "id"          TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "role"        TEXT NOT NULL DEFAULT 'MEMBER',
  "joinedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "community_members_communityId_leadId_key" ON "community_members" ("communityId", "leadId");
CREATE INDEX "community_members_communityId_idx" ON "community_members" ("communityId");
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_communityId_fkey"
  FOREIGN KEY ("communityId") REFERENCES "communities" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "community_posts" (
  "id"           TEXT NOT NULL,
  "communityId"  TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "authorUserId" TEXT,
  "authorLeadId" TEXT,
  "title"        TEXT,
  "body"         TEXT NOT NULL,
  "pinned"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "community_posts_communityId_pinned_createdAt_idx" ON "community_posts" ("communityId", "pinned", "createdAt");
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_communityId_fkey"
  FOREIGN KEY ("communityId") REFERENCES "communities" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "community_comments" (
  "id"           TEXT NOT NULL,
  "postId"       TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "authorUserId" TEXT,
  "authorLeadId" TEXT,
  "body"         TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "community_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "community_comments_postId_createdAt_idx" ON "community_comments" ("postId", "createdAt");
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "community_posts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
