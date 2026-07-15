-- Multi-workspace membership: the authz join table + a clean 1:1 backfill of
-- every existing user into ONE ACTIVE membership. Additive; the MarketingUser
-- workspaceId/role columns are retained (demoted to a home/login pointer).
CREATE TABLE IF NOT EXISTS "workspace_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "customRoleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invitedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_memberships_userId_workspaceId_key"
  ON "workspace_memberships"("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_memberships_workspaceId_idx"
  ON "workspace_memberships"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_memberships_userId_status_idx"
  ON "workspace_memberships"("userId", "status");
CREATE INDEX IF NOT EXISTS "workspace_memberships_workspaceId_role_idx"
  ON "workspace_memberships"("workspaceId", "role");

-- FK so the guard can include memberships in one round-trip; cascade is inert
-- (users are soft-deactivated, never hard-deleted) but keeps integrity.
DO $$ BEGIN
  ALTER TABLE "workspace_memberships"
    ADD CONSTRAINT "workspace_memberships_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "marketing_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: one ACTIVE membership per existing user (SYSTEM sentinels too, for a
-- clean 1:1 — they never authenticate, so it is inert). Idempotent.
INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "customRoleId", "status", "acceptedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."id", u."workspaceId", u."role", u."customRoleId", 'ACTIVE', u."createdAt", u."createdAt", CURRENT_TIMESTAMP
FROM "marketing_users" u
ON CONFLICT ("userId", "workspaceId") DO NOTHING;
