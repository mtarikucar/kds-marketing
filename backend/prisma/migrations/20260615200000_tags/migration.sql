-- Migration: lead tags taxonomy + Tag<->Lead membership (Epic A2)

CREATE TABLE "tags" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "nameLower"   TEXT NOT NULL,
  "color"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tags_workspaceId_nameLower_key" ON "tags" ("workspaceId", "nameLower");
CREATE INDEX "tags_workspaceId_idx" ON "tags" ("workspaceId");

CREATE TABLE "lead_tags" (
  "leadId"       TEXT NOT NULL,
  "tagId"        TEXT NOT NULL,
  "assignedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedById" TEXT,
  CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("leadId", "tagId")
);

CREATE INDEX "lead_tags_tagId_idx" ON "lead_tags" ("tagId");

ALTER TABLE "lead_tags"
  ADD CONSTRAINT "lead_tags_leadId_fkey" FOREIGN KEY ("leadId")
  REFERENCES "leads" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_tags"
  ADD CONSTRAINT "lead_tags_tagId_fkey" FOREIGN KEY ("tagId")
  REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
