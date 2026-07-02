-- Per-workspace progressive-disclosure module allow-list.
-- NULL = every entitled module active (back-compat); string[] = allow-list.
ALTER TABLE "workspaces" ADD COLUMN "activatedModules" JSONB;
