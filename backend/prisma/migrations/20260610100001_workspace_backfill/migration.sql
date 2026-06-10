-- Workspace multi-tenancy, step 2/3 (BACKFILL).
-- Pre-workspace deployments carry exactly one organization's data. If any
-- marketing user exists, adopt that data into a deterministic "default"
-- workspace (fixed UUID so ops scripts/the cutover runbook can target it);
-- a fresh database skips everything here. Workspace identity (name, product,
-- language) is operational data — set it after cutover via the platform
-- panel or an ops UPDATE, not in a vendored migration.

INSERT INTO "workspaces"
    ("id", "slug", "name", "status", "productName", "defaultLanguage", "defaultCurrency", "timezone", "updatedAt")
SELECT
    'b6a7c000-0000-4000-8000-000000000001',
    'default',
    'Default Workspace',
    'ACTIVE',
    'Default Product',
    'en',
    'USD',
    'UTC',
    CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "marketing_users")
ON CONFLICT ("slug") DO NOTHING;

-- Adopt every pre-workspace row.
UPDATE "marketing_users" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "leads" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "marketing_tasks" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "lead_offers" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "commissions" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "marketing_notifications" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "marketing_distribution_config" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "sales_calls" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "installation_crews" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "installation_jobs" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;
UPDATE "sales_targets" SET "workspaceId" = 'b6a7c000-0000-4000-8000-000000000001' WHERE "workspaceId" IS NULL;

-- Role taxonomy: workspace-scoped roles replace the legacy ones. Production
-- data also carried an undocumented field role 'AGENT' (rep-equivalent) —
-- discovered at cutover; map it too or those users rank below REP and 403
-- on every role gate.
UPDATE "marketing_users" SET "role" = 'MANAGER' WHERE "role" = 'SALES_MANAGER';
UPDATE "marketing_users" SET "role" = 'REP' WHERE "role" IN ('SALES_REP', 'AGENT');

-- The old GLOBAL research sentinel becomes the default workspace's SYSTEM
-- user (Phase E resolves sentinels per-workspace by role, not by a global
-- email).
UPDATE "marketing_users" SET "role" = 'SYSTEM' WHERE "email" = 'ai-research@system.local';

-- If multiple distribution-config rows ever accumulated (the legacy code
-- treated the table as a singleton but never enforced it), keep the newest
-- and drop the rest so step 3's UNIQUE(workspaceId) can land.
DELETE FROM "marketing_distribution_config" a
USING "marketing_distribution_config" b
WHERE a."workspaceId" = b."workspaceId"
  AND a."updatedAt" < b."updatedAt";
