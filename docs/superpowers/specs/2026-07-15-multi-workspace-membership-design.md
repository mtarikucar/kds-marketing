# Multi-Workspace Membership — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design) — pending implementation plan
**Branch:** `feat/multi-workspace-membership`

## Problem

Today a `MarketingUser` belongs to **exactly one** workspace. There is no per-user
"switch workspace" capability — the only cross-workspace movement is the
agency → sub-account impersonation (`AgencyService.accessLocation`), which is
OWNER-of-an-AGENCY-only and mints a session for the *child's own owner user*, not
the actor. Users asked for a real membership model:

- One person may own/run **several of their own brands** and manage all of them
  from a single login.
- A person may be a **team member in several different companies**, with a
  **different role per workspace** (OWNER in one, REP in another).

This is structurally impossible in the current model because:

- `MarketingUser.workspaceId` is a single scalar column (`schema.prisma:106`); no
  membership/join table exists.
- The JWT carries exactly one workspace claim `wsp`, and `MarketingGuard` hard-binds
  `payload.wsp === marketingUser.workspaceId` (COND 5, `marketing.guard.ts:82`).
- `email` is globally `@unique` (`schema.prisma:107`), and `createLocation` refuses a
  duplicate owner email — so one human running two brands needs two separate logins.

## Goal

A user is **one identity** that holds **N workspace memberships**, each with its own
role, and can **switch the active workspace** from a top-bar switcher. Cross-org
membership is **consent-based** (invite + accept). Existing single-workspace users are
unaffected.

## Non-goals

- Simultaneous multi-workspace views (one active workspace at a time; switching
  re-scopes the whole session).
- Changing the agency → sub-account impersonation feature (it stays as-is and
  coexists).
- Merging pre-existing duplicate identities — none exist (email is globally unique
  today), so the migration is a clean 1:1 backfill.

## Chosen approach — Normalized `WorkspaceMembership` (Approach A)

Rejected alternatives:

- **B — Linked sibling rows** (one `MarketingUser` row per (workspace, person),
  linked by a `personId`, relax `email` uniqueness to `(workspaceId, email)`, switch
  = mint a session for the sibling row). Minimal query churn, but **fragments
  identity**: password/name/profile per row drift independently, password reset is
  ambiguous, "one login" becomes a fiction. Rejected.
- **C — A but self-owned only in phase 1** (defer cross-org invites). Rejected as the
  default because the requested use case explicitly includes cross-org team
  membership; instead we *phase* Approach A (invites land in Phase 2) without changing
  the target model.

### Key insight that bounds the blast radius

~941 backend call-sites read the active workspace from the **request JWT payload**
(`user.workspaceId` / `user.role` on `MarketingUserPayload`), not from the DB row.
**If the token keeps carrying exactly one active workspace, none of those 941
call-sites change** — only the *source* of the payload's `workspaceId`/`role` moves
from the user row to the active membership. This makes the work an identity + session
layer change, not an "every query becomes multi-workspace" rewrite.

## 1. Data model & migration

### New table `WorkspaceMembership` (authoritative source of authorization)

```
model WorkspaceMembership {
  id              String    @id @default(uuid())
  userId          String    // → MarketingUser (the identity)
  workspaceId     String    // → Workspace
  role            String    // OWNER | MANAGER | REP  (workspace-scoped)
  customRoleId    String?   // Epic F granular role (workspace-scoped)
  status          String    @default("ACTIVE") // ACTIVE | INVITED | SUSPENDED
  invitedByUserId String?
  acceptedAt      DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([userId, workspaceId])
  @@index([workspaceId])
  @@index([userId, status])
  @@index([workspaceId, role])
  @@map("workspace_memberships")
}
```

### `MarketingUser` becomes the pure identity

`email @unique`, `password`, name fields, `tokenVersion`, `referralCode` stay.
`workspaceId` / `role` / `customRoleId` columns are **retained** but demoted to a
**home / login-landing pointer** only: authorization decisions read the active
*membership*, never these columns. This avoids a dual source of truth for
authz while keeping login's "which workspace do I land in" answer trivial and keeping
the migration reversible without data loss. (`customRoleId` on the user row is left in
place but unused for authz; the membership's `customRoleId` wins.)

### Migration (reversible — CLAUDE.md up/down pair)

- **up:** create `workspace_memberships`; backfill **one `ACTIVE` membership per
  existing user** from `(id → userId, workspaceId, role, customRoleId, createdAt)`.
  Idempotent: `CREATE TABLE IF NOT EXISTS` + backfill `INSERT … ON CONFLICT (userId,
  workspaceId) DO NOTHING`. SYSTEM-role sentinel users are backfilled too for a clean
  1:1 (they never authenticate, so it is inert).
- **down:** `DROP TABLE IF EXISTS workspace_memberships`. Because the user columns are
  retained, no data is lost. Round-trip (up → down → up) must be verified.

## 2. Auth / session / switch

- **JWT payload unchanged** (`{sub,email,role,wsp,ver,type}`). `role` + `wsp` now
  reflect the **active membership**. `(sub, wsp)` identifies the membership — no new
  claim.
- **Guard change (`marketing.guard.ts`, COND 5):** replace
  `payload.wsp === marketingUser.workspaceId` with: load the `ACTIVE`
  `WorkspaceMembership` for `(marketingUser.id, payload.wsp)`; if none → `401 "Session
  revoked"`. Populate the request payload's `role` / `customRoleId` **from the
  membership** (not the user row). `tokenVersion` check (global logout) is unchanged.
  Load the membership in the same query round-trip as the user (join / single
  `findFirst` with an include) so the guard stays one DB hit.
- **`generateTokens` / `issueSession` generalized** to take an explicit active
  `workspaceId` and resolve `role` from that membership. Login picks the default
  membership: the user's `workspaceId` home pointer if a membership for it exists, else
  the most-recently-created `ACTIVE` membership.
- **Switch endpoint:** `POST /marketing/auth/switch-workspace { workspaceId }`
  (authenticated). Verify an `ACTIVE` membership for `(req.user.id, workspaceId)`;
  re-issue access + refresh with the new `wsp` + `role`; update the user's home pointer
  to the new workspace (so next login lands there); `@Audit` the switch. Same identity —
  unlike agency impersonation there is no "return-to" stash; switching back is just
  another switch. Non-member target → `403`/`404` (no enumeration).
- **Refresh fix (required):** `refreshToken` currently derives the workspace from
  `user.workspaceId`. It must instead read the `wsp` embedded in the **refresh token**
  and re-verify that membership is still `ACTIVE`; otherwise a refresh silently resets
  the active workspace back to home, and a revoked membership would survive a refresh.
- **Agency impersonation unchanged.** `accessLocation` (impersonate the child's owner)
  and workspace switching (act as yourself in another workspace) are distinct and
  coexist.

## 3. Invitations & membership lifecycle

- **Invite:** `POST /marketing/users/invite { email, role, customRoleId? }` — requires
  `users.manage`.
  - Existing identity (email match) → create an `INVITED` membership for
    `(thatUser, myWorkspace, role)`; send an in-app pending invite + email.
  - New email → create a pending identity (no usable password) + `INVITED` membership;
    send a signup+accept link that sets the password on accept.
  - An existing `ACTIVE`/`INVITED` membership for the pair → `409`.
- **Accept:** `POST /marketing/auth/accept-invite { token }` (or, when logged in,
  `POST /marketing/memberships/:id/accept`) → set `ACTIVE` + `acceptedAt`; the
  new-identity path also sets the password here.
- **Decline / revoke / remove:** an invitee may decline (delete `INVITED`); an admin may
  revoke an `INVITED` membership or `SUSPEND`/remove an `ACTIVE` one. Removing a member
  from a workspace **never deletes the identity** (it may hold other memberships).
- **`marketing-users.service` reframed to membership granularity** (the largest refactor
  surface):
  - "add user" → invite (creates a membership), not a new `MarketingUser` row.
  - "list users" → list this workspace's memberships joined to their identities.
  - "deactivate user" → `SUSPEND` the membership, not the global identity.
  - the seat-limit advisory lock counts **`ACTIVE` memberships in the workspace**, not
    user rows.
  - OWNER-protection, no-promote-to-OWNER, and privilege-floor/escalation guards operate
    at membership granularity.
  - SSO login (`sso.service`) ensures/attaches a membership for the target workspace.

## 4. Frontend

- **Auth store (`marketingAuthStore`):** `user` (identity) + `activeWorkspace {id, name,
  role}` + `memberships: [{workspaceId, name, role}]`. `switchWorkspace(workspaceId)`
  calls the endpoint, swaps the stored tokens, **clears the react-query cache**
  (`queryClient.clear()` — every cached list belongs to the previous workspace), and
  routes to the dashboard. This is a full session re-scope, distinct from the agency
  `enterLocation` stash (which is retained for impersonation).
- **Top-bar workspace switcher (new):** a dropdown listing the user's `ACTIVE`
  memberships with a role badge, current one highlighted; **rendered only when
  `memberships.length > 1`** (hidden for single-workspace users — no clutter). Adjacent
  pending-invites affordance (accept/decline).
- **Role-dependent nav recompute:** after a switch, nav/permissions recompute for the new
  active role (OWNER here vs REP there see different surfaces). Agency console + the
  `enterLocation` impersonation flow are untouched.

## 5. Authorization & security

- The guard verifies an `ACTIVE` membership on **every** request, so revocation is
  immediate (`SUSPEND` → next request denied). `tokenVersion` still provides global
  logout.
- Switch is allowed only into workspaces where the caller has an `ACTIVE` membership; no
  enumeration of foreign workspaces.
- Cross-org attach requires **consent** (invite + accept) — no silent linking of an
  existing identity to another org.
- Seat limit and privilege-escalation guards run at membership granularity.
- `@Audit` covers switch, invite, accept, membership role change, and removal.
- **Entitlement/plan gating is optional** and out of the critical path: invites are
  already bounded by the workspace's existing seat limit; a plan flag can gate invites
  later without design changes.

## 6. Testing

- Migration round-trip up → down → up.
- Guard: membership present / absent / suspended; role resolved from the membership.
- Switch: valid membership re-issues with the new role; non-member denied; refresh
  preserves the active `wsp`; a suspended membership blocks the next request.
- Invite/accept: existing identity, new identity, duplicate `409`, decline, revoke.
- Seat limit enforced at membership granularity.
- FE: switcher visibility (1 vs N memberships), cache reset on switch, role-based nav
  recompute.
- **Regression:** existing single-workspace users are unaffected (exactly one membership
  is backfilled and everything behaves as before).

## Rollout / phasing (for the implementation plan)

- **Phase 1 — core:** schema + reversible migration + membership as the authz source of
  truth (guard + role resolution) + `switch-workspace` endpoint + refresh fix + FE
  switcher. Self-owned multi-brand works immediately: the backfill gives everyone ≥1
  membership, and a logged-in user creating a second workspace gets an OWNER membership
  on it.
- **Phase 2 — cross-org:** invite/accept + `marketing-users` refactor to membership
  granularity + seat limits at membership granularity + SSO membership attach.
- **Phase 3 — polish:** pending-invites UI, entitlement gating, audit surfacing, edge
  cases (e.g. last-OWNER-of-a-workspace protection when suspending memberships).

## Open edge cases to handle in the plan

- Suspending/removing the **last `ACTIVE` OWNER** of a workspace must be blocked (a
  workspace cannot become owner-less) — the membership-granular analogue of today's
  OWNER-account protection.
- A user whose **only** membership is suspended/removed while logged in: next request →
  `401`; the FE routes to login (no orphaned session).
- Switching while inside an agency impersonation session: the switcher operates on the
  *impersonated* session's identity; keep the two flows from interleaving (either hide
  the switcher during impersonation or resolve memberships against the real identity —
  to be decided in the plan; default: hide the switcher during impersonation).
