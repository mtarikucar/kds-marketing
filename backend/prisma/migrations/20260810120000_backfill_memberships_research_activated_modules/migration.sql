-- One-off data backfill (no schema change). WHY: with the collapse to a single
-- sellable package (seed-packages.ts, 2026-08) every customer-facing plan now
-- entitles `memberships` and `research`. Those two keys had been excluded from
-- DEFAULT_ACTIVATED_MODULES purely for a leaner first run, so every workspace
-- created since 20260702160000_workspace_activated_modules carries an explicit
-- allow-list that OMITS them.
--
-- EntitlementsService.compute() treats a non-null Workspace.activatedModules as
-- an explicit allow-list: any TOGGLEABLE_MODULE_KEYS entry missing from the
-- array is forced to features[k]=false no matter what Package.features grants.
-- Without this backfill a customer who has just paid for "everything" would
-- still find Courses and Research missing from their console — the exact
-- "I bought it and it isn't there" failure the single-package model must not
-- produce.
--
-- Workspaces with activatedModules IS NULL are unaffected (NULL = all entitled
-- modules active) and are intentionally left untouched.
--
-- Idempotent: appends each key only to rows that are a non-null JSON array and
-- do not already contain it. Safe to re-run.
UPDATE "workspaces"
SET "activatedModules" = "activatedModules" || '["memberships"]'::jsonb
WHERE "activatedModules" IS NOT NULL
  AND jsonb_typeof("activatedModules") = 'array'
  AND NOT ("activatedModules" @> '["memberships"]'::jsonb);

UPDATE "workspaces"
SET "activatedModules" = "activatedModules" || '["research"]'::jsonb
WHERE "activatedModules" IS NOT NULL
  AND jsonb_typeof("activatedModules") = 'array'
  AND NOT ("activatedModules" @> '["research"]'::jsonb);
