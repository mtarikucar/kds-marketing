-- Migration: custom roles + granular permissions (Epic F)

ALTER TABLE "marketing_users" ADD COLUMN "customRoleId" TEXT;

CREATE TABLE "custom_roles" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "permissions" JSONB NOT NULL DEFAULT '[]',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custom_roles_workspaceId_name_key" ON "custom_roles" ("workspaceId", "name");
CREATE INDEX "custom_roles_workspaceId_idx" ON "custom_roles" ("workspaceId");
