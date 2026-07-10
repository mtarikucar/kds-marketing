-- One-off data backfill (no schema change). WHY: EntitlementsService.compute()
-- treats a non-null Workspace.activatedModules as an explicit allow-list —
-- any TOGGLEABLE_MODULE_KEYS entry missing from that array is forced to
-- features[k]=false, regardless of what Package.features grants. The `sms`
-- feature key (entitlements.service.ts FEATURE_KEYS, task-2 of the NetGSM SMS
-- v2 program) was added AFTER the activatedModules allow-list model shipped
-- (20260702160000_workspace_activated_modules) and after some workspaces had
-- already customized their allow-list. Those tenants' allow-lists predate the
-- `sms` key's existence, so without this backfill they'd lose SMS on deploy
-- despite Package.features.sms = true on every plan. Workspaces with
-- activatedModules IS NULL are unaffected either way (NULL = all entitled
-- modules active, back-compat) and are intentionally left untouched here.
--
-- Idempotent: only appends 'sms' to rows that are a JSON array, are non-null,
-- and don't already contain it. Safe to re-run.
UPDATE "workspaces"
SET "activatedModules" = "activatedModules" || '["sms"]'::jsonb
WHERE "activatedModules" IS NOT NULL
  AND jsonb_typeof("activatedModules") = 'array'
  AND NOT ("activatedModules" @> '["sms"]'::jsonb);
