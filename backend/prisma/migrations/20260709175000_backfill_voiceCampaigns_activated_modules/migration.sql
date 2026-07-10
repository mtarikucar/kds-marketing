-- One-off data backfill (no schema change). WHY: EntitlementsService.compute()
-- treats a non-null Workspace.activatedModules as an explicit allow-list —
-- any TOGGLEABLE_MODULE_KEYS entry missing from that array is forced to
-- features[k]=false, regardless of what Package.features grants. The
-- `voiceCampaigns` feature key (entitlements.service.ts FEATURE_KEYS, NetGSM
-- Phase 5 Task 1 — voice campaigns via `/voicesms/send`) was added AFTER the
-- activatedModules allow-list model shipped
-- (20260702160000_workspace_activated_modules) and after some workspaces had
-- already customized their allow-list. Unlike `smsOtp`, `voiceCampaigns` IS
-- plan-entitled (Package.features.voiceCampaigns = true on SCALE + OPERATOR,
-- see seed-packages.ts) and so IS a real Settings > Modules toggle
-- (TOGGLEABLE_MODULE_KEYS does NOT exclude it). Those pre-existing
-- customized allow-lists predate the `voiceCampaigns` key's existence, so
-- without this backfill a SCALE/OPERATOR tenant with a customized allow-list
-- would lose voice campaigns on deploy despite their plan entitling it.
-- Workspaces with activatedModules IS NULL are unaffected either way (NULL =
-- all entitled modules active, back-compat) and are intentionally left
-- untouched here.
--
-- Idempotent: only appends 'voiceCampaigns' to rows that are a JSON array,
-- are non-null, and don't already contain it. Safe to re-run.
UPDATE "workspaces"
SET "activatedModules" = "activatedModules" || '["voiceCampaigns"]'::jsonb
WHERE "activatedModules" IS NOT NULL
  AND jsonb_typeof("activatedModules") = 'array'
  AND NOT ("activatedModules" @> '["voiceCampaigns"]'::jsonb);
