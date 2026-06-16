# Epic F — Custom roles + granular permissions — design

**Date:** 2026-06-16 · autonomous (no-ask) · independent off main

## Goal
Workspace-defined roles with granular permissions, **additive** over the legacy
OWNER/MANAGER/REP system (which still works unchanged).
- `CustomRole` (name + permission-key array) + `MarketingUser.customRoleId`.
- Permission **catalog** (constants) + legacy-role → permission fallback mapping.
- `RolesService` — CRUD + assign-to-user + `resolvePermissions`/`hasPermission`
  (custom role overrides legacy; else legacy mapping).
- `@RequirePermission('x')` + `PermissionsGuard` — opt-in fine-grained checks for
  new endpoints (existing endpoints untouched). Management `/marketing/roles`
  (OWNER/MANAGER): catalog, CRUD, assign.

## Testing
Unit: validate perms + dup, resolve custom vs legacy, hasPermission, assign scope.
E2E: catalog, create+assign, unknown-perm 400, REP-forbidden. Full suite green
(633 unit + 59 e2e).
