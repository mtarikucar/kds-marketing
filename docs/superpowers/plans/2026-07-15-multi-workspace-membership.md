# Multi-Workspace Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one `MarketingUser` identity hold N per-workspace memberships (each with its own role) and switch the active workspace from a top-bar switcher, with cross-org membership gated by invite + accept.

**Architecture:** A new `WorkspaceMembership` join table becomes the authoritative source of authorization. The JWT keeps carrying exactly **one** active workspace (`wsp`) + role, so the ~941 request-time call-sites that read `user.workspaceId`/`user.role` off the payload are untouched — only the *source* of those payload fields moves from the `MarketingUser` row to the active membership. The guard validates an `ACTIVE` membership for `(user, wsp)` on every request (so revocation is immediate); a `switch-workspace` endpoint re-mints the session for a different membership.

**Tech Stack:** NestJS 11 / Express 5, Prisma + Postgres, `@nestjs/jwt` (HS256), Jest (backend). Frontend: Vite/React, zustand (`persist`), `@tanstack/react-query`, axios, Vitest.

## Global Constraints

- **Reversible migrations (CLAUDE.md):** every schema migration ships as an up (`prisma/migrations/<ts>_<name>/migration.sql`, idempotent `IF NOT EXISTS`) + a companion `down.sql` (drops exactly what the up added, safe no-op if already reverted). Verify the round-trip up → down → up.
- **No AI authorship trace (CLAUDE.md):** plain conventional-commit messages; author is the user; no `Co-Authored-By`/"Generated with" trailer.
- **Workspace scoping fitness test:** `backend/src/modules/marketing/workspace-scoping.arch.spec.ts` fails any bulk/create Prisma call on a workspace-owned delegate that lacks a literal `workspaceId`. Cross-workspace membership reads keyed by `userId` (e.g. list-my-memberships) are legitimately workspace-less and MUST be added to that spec's `ALLOWED` exemption map with a justification.
- **Token realm secrets:** access = `MARKETING_JWT_SECRET` (8h), refresh = `MARKETING_JWT_REFRESH_SECRET` (7d), both HS256, must differ from each other and from other realms.
- **Backend test gates:** `npx prisma generate` (before tsc — a stale client falsely errors) → `npx tsc --noEmit -p tsconfig.json` → `npx jest <touched specs>` → `npx jest workspace-scoping.arch`.
- **Branch:** all work on `feat/multi-workspace-membership`. Commit per task.
- **Role vocabulary:** `OWNER | MANAGER | REP | SYSTEM`. SYSTEM sentinels never authenticate and never occupy a seat. Membership `status`: `ACTIVE | INVITED | SUSPENDED`.

---

## File structure

**Backend — created**
- `prisma/migrations/20260715150000_workspace_memberships/migration.sql` + `down.sql` — table + 1:1 backfill.
- `src/modules/marketing/services/membership.service.ts` — membership reads/writes (resolve active, list mine, default-on-login, invite/accept/revoke). One clear responsibility: the membership lifecycle + authz resolution seam.
- `src/modules/marketing/services/membership.service.spec.ts`, `.invite.spec.ts` — tests.
- `src/modules/marketing/dto/switch-workspace.dto.ts`, `invite-member.dto.ts`, `accept-invite.dto.ts`.

**Backend — modified**
- `prisma/schema.prisma` — add `WorkspaceMembership` model + `MarketingUser.memberships` back-relation.
- `src/modules/marketing/guards/marketing.guard.ts` — COND 5 becomes a membership check; populate `role`/`customRoleId`/`workspaceId` from the membership.
- `src/modules/marketing/services/marketing-auth.service.ts` — `generateTokens` takes an active membership; `login` picks default membership; `refreshToken` preserves the token's `wsp`; `switchWorkspace`; register/provision create an OWNER membership.
- `src/modules/marketing/services/sso.service.ts` — `matchOrProvision` ensures/attaches a membership.
- `src/modules/marketing/services/marketing-users.service.ts` — reframed to membership granularity (Phase 2).
- `src/modules/marketing/services/agency.service.ts` — `createLocation` creates the child OWNER membership.
- `src/modules/marketing/controllers/marketing-auth.controller.ts` — `switch-workspace`, `accept-invite`, and `profile` returns memberships.
- `src/modules/marketing/controllers/marketing-users.controller.ts` — invite/list/revoke at membership granularity (Phase 2).
- `src/modules/marketing/types.ts` — no shape change to `MarketingUserPayload` (role/wsp stay singular); add a `MembershipSummary` type.

**Frontend — created**
- `src/features/marketing/components/WorkspaceSwitcher.tsx` + `.test.tsx`.
- `src/features/marketing/api/membershipApi.ts` — `switchWorkspace`, `acceptInvite`, invite CRUD calls.

**Frontend — modified**
- `src/store/marketingAuthStore.ts` — add `memberships` + `switchWorkspace` action (distinct from `enterLocation`).
- `src/features/marketing/components/MarketingHeader.tsx` — render `<WorkspaceSwitcher />`.
- `src/features/marketing/api/marketingApi.ts` — add new auth paths to `NO_REFRESH_PATHS`.
- `src/pages/marketing/MarketingLoginPage.tsx` — store memberships from the login response.

---

# PHASE 1 — Core (ships self-owned multi-brand)

Backfill gives every existing user exactly one `ACTIVE` membership; the guard/tokens read the active membership; a logged-in user who creates a second workspace gets an OWNER membership on it and can switch. No behaviour change for single-workspace users.

## Task 1: `WorkspaceMembership` schema + reversible migration (with 1:1 backfill)

**Files:**
- Modify: `backend/prisma/schema.prisma` (add model + back-relation)
- Create: `backend/prisma/migrations/20260715150000_workspace_memberships/migration.sql`
- Create: `backend/prisma/migrations/20260715150000_workspace_memberships/down.sql`

**Interfaces:**
- Produces: table `workspace_memberships` with columns `(id, userId, workspaceId, role, customRoleId, status, invitedByUserId, acceptedAt, createdAt, updatedAt)`, unique `(userId, workspaceId)`; Prisma model `WorkspaceMembership` + `MarketingUser.memberships WorkspaceMembership[]`.

- [ ] **Step 1: Add the Prisma model + back-relation**

In `backend/prisma/schema.prisma`, inside `model MarketingUser { ... }` add to the Relations block (near `notifications MarketingNotification[]`):

```prisma
  memberships   WorkspaceMembership[]
```

After the `MarketingUser` model, add:

```prisma
/// Multi-workspace membership — the authoritative source of authorization.
/// A MarketingUser identity holds N of these; the active one (JWT `wsp`) supplies
/// the request's role/customRoleId. See docs/superpowers/specs/2026-07-15-*.md.
model WorkspaceMembership {
  id              String    @id @default(uuid())
  userId          String
  user            MarketingUser @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspaceId     String
  role            String    // OWNER | MANAGER | REP (workspace-scoped)
  customRoleId    String?   // Epic F granular role (workspace-scoped); overrides `role`
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

- [ ] **Step 2: Write the up migration**

Create `backend/prisma/migrations/20260715150000_workspace_memberships/migration.sql`:

```sql
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
```

- [ ] **Step 3: Write the down migration**

Create `backend/prisma/migrations/20260715150000_workspace_memberships/down.sql`:

```sql
-- Manual rollback for 20260715150000_workspace_memberships (Prisma migrate is
-- forward-only). No data loss: MarketingUser.workspaceId/role were retained, so
-- dropping the join table reverts to the single-workspace model exactly.
DROP TABLE IF EXISTS "workspace_memberships";
```

- [ ] **Step 4: Apply + verify the round-trip**

Run (against a dev database):
```bash
cd backend
npx prisma migrate deploy
npx prisma generate
# round-trip: down → up must succeed and re-backfill
psql "$DATABASE_URL" -f prisma/migrations/20260715150000_workspace_memberships/down.sql
npx prisma migrate deploy   # re-runs the up
npx prisma generate
```
Expected: table exists after up; `SELECT count(*) FROM workspace_memberships;` equals `SELECT count(*) FROM marketing_users;`; down drops it cleanly; re-up restores it with the same count.

- [ ] **Step 5: Typecheck (Prisma client picks up the new model)**

Run: `cd backend && npx prisma generate && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260715150000_workspace_memberships
git commit -m "feat(membership): WorkspaceMembership table + reversible 1:1 backfill migration"
```

## Task 2: `MembershipService` — authz resolution reads

**Files:**
- Create: `backend/src/modules/marketing/services/membership.service.ts`
- Create: `backend/src/modules/marketing/services/membership.service.spec.ts`
- Modify: `backend/src/modules/marketing/types.ts` (add `MembershipSummary`)
- Modify: `backend/src/modules/marketing/marketing.module.ts` (provide + export `MembershipService`)
- Modify: `backend/src/modules/marketing/workspace-scoping.arch.spec.ts` (exempt the userId-keyed reads)

**Interfaces:**
- Produces:
  - `getActiveMembership(userId: string, workspaceId: string): Promise<{ id, workspaceId, role, customRoleId } | null>`
  - `listActiveMemberships(userId: string): Promise<MembershipSummary[]>` — cross-workspace, joined to workspace name.
  - `resolveDefaultWorkspaceId(userId: string, homeWorkspaceId: string): Promise<string | null>` — the home pointer if a membership exists for it, else the most-recently-created ACTIVE membership's workspaceId, else null.
- Consumes (later tasks): the guard (Task 3) and auth service (Tasks 4–7) call these.

- [ ] **Step 1: Add the `MembershipSummary` type**

In `backend/src/modules/marketing/types.ts`, after `MarketingUserPayload`:

```ts
/** A user's ACTIVE membership as surfaced to the FE switcher / profile. */
export interface MembershipSummary {
  workspaceId: string;
  workspaceName: string;
  role: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/modules/marketing/services/membership.service.spec.ts`:

```ts
import { MembershipService } from './membership.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new MembershipService(prisma as any) };
}

describe('MembershipService', () => {
  it('getActiveMembership returns the ACTIVE membership for (user, workspace)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue({
      id: 'm1', workspaceId: 'ws-1', role: 'MANAGER', customRoleId: null,
    });
    const m = await svc.getActiveMembership('u1', 'ws-1');
    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', workspaceId: 'ws-1', status: 'ACTIVE' },
      select: { id: true, workspaceId: true, role: true, customRoleId: true },
    });
    expect(m).toMatchObject({ role: 'MANAGER' });
  });

  it('getActiveMembership returns null when suspended/absent', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null);
    expect(await svc.getActiveMembership('u1', 'ws-x')).toBeNull();
  });

  it('resolveDefaultWorkspaceId prefers the home pointer when a membership exists for it', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValueOnce({ workspaceId: 'home' });
    const ws = await svc.resolveDefaultWorkspaceId('u1', 'home');
    expect(ws).toBe('home');
  });

  it('resolveDefaultWorkspaceId falls back to the most-recent ACTIVE membership when home has none', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no membership for the home pointer
      .mockResolvedValueOnce({ workspaceId: 'recent' }); // most-recent ACTIVE
    const ws = await svc.resolveDefaultWorkspaceId('u1', 'home');
    expect(ws).toBe('recent');
  });

  it('listActiveMemberships joins workspace names', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findMany as jest.Mock).mockResolvedValue([
      { workspaceId: 'ws-1', role: 'OWNER' }, { workspaceId: 'ws-2', role: 'REP' },
    ]);
    (prisma.workspace.findMany as jest.Mock).mockResolvedValue([
      { id: 'ws-1', name: 'Brand A' }, { id: 'ws-2', name: 'Brand B' },
    ]);
    const out = await svc.listActiveMemberships('u1');
    expect(out).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'Brand A', role: 'OWNER' },
      { workspaceId: 'ws-2', workspaceName: 'Brand B', role: 'REP' },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/services/membership.service.spec.ts`
Expected: FAIL — "Cannot find module './membership.service'".

- [ ] **Step 4: Implement the service**

Create `backend/src/modules/marketing/services/membership.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MembershipSummary } from '../types';

/**
 * The membership lifecycle + authorization-resolution seam. A MarketingUser
 * identity holds N WorkspaceMemberships; the active one supplies the request's
 * role. Reads keyed by `userId` are intentionally cross-workspace (a user spans
 * workspaces) and are exempt in the workspace-scoping fitness test.
 */
@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /** The ACTIVE membership binding a user to a workspace, or null. */
  getActiveMembership(userId: string, workspaceId: string) {
    return this.prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId, status: 'ACTIVE' },
      select: { id: true, workspaceId: true, role: true, customRoleId: true },
    });
  }

  /** Every ACTIVE membership the user holds, joined to workspace display names. */
  async listActiveMemberships(userId: string): Promise<MembershipSummary[]> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { workspaceId: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!memberships.length) return [];
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: memberships.map((m) => m.workspaceId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(workspaces.map((w) => [w.id, w.name]));
    return memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: nameById.get(m.workspaceId) ?? m.workspaceId,
      role: m.role,
    }));
  }

  /**
   * Which workspace a login lands in: the user's home pointer if they still hold
   * an ACTIVE membership for it, else their most-recently-created ACTIVE
   * membership, else null (no active membership → login should be refused).
   */
  async resolveDefaultWorkspaceId(userId: string, homeWorkspaceId: string): Promise<string | null> {
    const home = await this.prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId: homeWorkspaceId, status: 'ACTIVE' },
      select: { workspaceId: true },
    });
    if (home) return home.workspaceId;
    const fallback = await this.prisma.workspaceMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { workspaceId: true },
    });
    return fallback?.workspaceId ?? null;
  }
}
```

- [ ] **Step 5: Provide the service in the module**

In `backend/src/modules/marketing/marketing.module.ts`, add `MembershipService` to both the `providers` array and the `exports` array (so `sso.service`/guards can inject it). Add the import at the top:

```ts
import { MembershipService } from './services/membership.service';
```

- [ ] **Step 6: Exempt the userId-keyed reads in the fitness test**

In `backend/src/modules/marketing/workspace-scoping.arch.spec.ts`, find the `ALLOWED` exemption map and add (matching the file's existing entry format):

```ts
  // MembershipService — a user spans workspaces, so membership reads keyed by
  // userId are legitimately workspace-less (the authz-resolution seam).
  'services/membership.service.ts': [
    'workspaceMembership.findFirst',
    'workspaceMembership.findMany',
  ],
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd backend && npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest src/modules/marketing/services/membership.service.spec.ts workspace-scoping.arch`
Expected: PASS (5 membership tests + arch spec green).

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/marketing/services/membership.service.ts backend/src/modules/marketing/services/membership.service.spec.ts backend/src/modules/marketing/types.ts backend/src/modules/marketing/marketing.module.ts backend/src/modules/marketing/workspace-scoping.arch.spec.ts
git commit -m "feat(membership): MembershipService authz-resolution reads"
```

## Task 3: Guard reads the active membership (COND 5 → membership check)

**Files:**
- Modify: `backend/src/modules/marketing/guards/marketing.guard.ts`
- Create/Modify: `backend/src/modules/marketing/guards/marketing.guard.spec.ts`

**Interfaces:**
- Consumes: `MarketingUser.memberships` relation (Task 1), filtered include.
- Produces: `request.marketingUser` whose `workspaceId` = `payload.wsp`, and `role`/`customRoleId` come from the ACTIVE membership for `(user, wsp)`. A missing/suspended membership → `401 "Session revoked"`.

- [ ] **Step 1: Write the failing test**

Create/extend `backend/src/modules/marketing/guards/marketing.guard.spec.ts` with a describe that builds the guard with a mocked `JwtService`, `ConfigService`, `PrismaService`. Assert three cases. Key assertions:

```ts
it('populates role from the ACTIVE membership for the token wsp (not the user row)', async () => {
  // user row role = OWNER (home), but the active membership for wsp-2 is REP
  prisma.marketingUser.findUnique.mockResolvedValue({
    id: 'u1', workspaceId: 'wsp-home', email: 'a@b.co', firstName: 'A', lastName: 'B',
    role: 'OWNER', status: 'ACTIVE', customRoleId: null, tokenVersion: 0,
    memberships: [{ workspaceId: 'wsp-2', role: 'REP', customRoleId: null, status: 'ACTIVE' }],
  });
  jwt.verifyAsync.mockResolvedValue({ sub: 'u1', wsp: 'wsp-2', ver: 0, type: 'marketing' });
  const ctx = ctxWithAuthHeader('Bearer t');
  await guard.canActivate(ctx);
  const req = ctx.switchToHttp().getRequest();
  expect(req.marketingUser.workspaceId).toBe('wsp-2');
  expect(req.marketingUser.role).toBe('REP');
});

it('401s when there is no ACTIVE membership for the token wsp', async () => {
  prisma.marketingUser.findUnique.mockResolvedValue({
    id: 'u1', workspaceId: 'wsp-home', email: 'a@b.co', firstName: 'A', lastName: 'B',
    role: 'OWNER', status: 'ACTIVE', customRoleId: null, tokenVersion: 0, memberships: [],
  });
  jwt.verifyAsync.mockResolvedValue({ sub: 'u1', wsp: 'wsp-2', ver: 0, type: 'marketing' });
  await expect(guard.canActivate(ctxWithAuthHeader('Bearer t'))).rejects.toThrow('Session revoked');
});
```

(Model the harness on any existing guard spec in the repo; if none, construct `new MarketingGuard(jwt, config, prisma, reflector)` directly and stub `context.switchToHttp().getRequest()`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/marketing/guards/marketing.guard.spec.ts`
Expected: FAIL — the guard still binds `payload.wsp === marketingUser.workspaceId` and reads role off the row.

- [ ] **Step 3: Implement — include the membership + resolve from it**

In `backend/src/modules/marketing/guards/marketing.guard.ts`, change the `findUnique` select to also pull the ACTIVE membership for `payload.wsp` in the same round-trip, and replace COND 5:

```ts
      const marketingUser = await this.prisma.marketingUser.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          workspaceId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          customRoleId: true,
          tokenVersion: true,
          // The ACTIVE membership for the token's active workspace — the source
          // of truth for this request's role/customRoleId under multi-workspace.
          memberships: {
            where: { workspaceId: payload.wsp, status: 'ACTIVE' },
            select: { workspaceId: true, role: true, customRoleId: true },
            take: 1,
          },
        },
      });

      if (!marketingUser || marketingUser.status !== 'ACTIVE') {
        throw new UnauthorizedException('User not found or inactive');
      }
      if (marketingUser.role === 'SYSTEM') {
        throw new UnauthorizedException('System accounts cannot authenticate');
      }

      // COND 5 (multi-workspace): the session is valid only if the user still
      // holds an ACTIVE membership for the token's active workspace. Revocation
      // (SUSPEND / remove) denies the very next request.
      const membership = marketingUser.memberships[0];
      if (!membership) {
        throw new UnauthorizedException('Session revoked');
      }

      if (typeof payload.ver === 'number' && payload.ver !== marketingUser.tokenVersion) {
        throw new UnauthorizedException('Session revoked');
      }

      const { tokenVersion: _v, memberships: _m, workspaceId: _home, role: _homeRole, customRoleId: _homeCr, ...rest } = marketingUser;
      request.marketingUser = {
        ...rest,
        // The active workspace + the role/customRoleId resolved FROM the membership.
        workspaceId: membership.workspaceId,
        role: membership.role,
        customRoleId: membership.customRoleId,
      };
      return true;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/modules/marketing/guards/marketing.guard.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/marketing/guards/marketing.guard.ts backend/src/modules/marketing/guards/marketing.guard.spec.ts
git commit -m "feat(membership): guard resolves role from the active membership"
```

## Task 4: `generateTokens`/`issueSession` stamp the active membership

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-auth.service.ts`
- Modify: `backend/src/modules/marketing/services/marketing-auth.workspace.spec.ts` (existing) or add `marketing-auth.membership.spec.ts`

**Interfaces:**
- Produces: `generateTokens(user, active: { workspaceId: string; role: string })` — stamps `wsp = active.workspaceId`, `role = active.role`. `issueSession` gains the same second parameter.
- Consumes: `MembershipService` (Task 2) for callers to resolve `active`.

- [ ] **Step 1: Write the failing test**

Add to the auth service spec:

```ts
it('generateTokens stamps wsp+role from the active membership, not the user row', async () => {
  // user.role/home = OWNER of wsp-home; active membership = REP of wsp-2
  const tokens = (svc as any).generateTokens(
    { id: 'u1', workspaceId: 'wsp-home', email: 'a@b.co', firstName: 'A', lastName: 'B', phone: null, avatar: null, role: 'OWNER', tokenVersion: 0 },
    { workspaceId: 'wsp-2', role: 'REP' },
  );
  const decoded: any = jwtService.decode(tokens.accessToken);
  expect(decoded.wsp).toBe('wsp-2');
  expect(decoded.role).toBe('REP');
  expect(tokens.user.workspaceId).toBe('wsp-2');
  expect(tokens.user.role).toBe('REP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest marketing-auth.membership.spec.ts`
Expected: FAIL — `generateTokens` takes one arg and stamps `user.workspaceId`.

- [ ] **Step 3: Implement — thread the active membership**

In `marketing-auth.service.ts`, change `generateTokens` and `issueSession`:

```ts
  issueSession(
    user: { id: string; workspaceId: string; email: string; firstName: string; lastName: string; phone: string | null; avatar: string | null; role: string; tokenVersion: number },
    active: { workspaceId: string; role: string },
  ) {
    return this.generateTokens(user, active);
  }

  private generateTokens(
    user: { id: string; workspaceId: string; email: string; firstName: string; lastName: string; phone: string | null; avatar: string | null; role: string; tokenVersion: number },
    active: { workspaceId: string; role: string },
  ) {
    const basePayload = {
      sub: user.id,
      email: user.email,
      role: active.role,     // ← active membership's role
      wsp: active.workspaceId, // ← active membership's workspace
      ver: user.tokenVersion,
      type: 'marketing' as const,
    };
    const accessToken = this.jwtService.sign(basePayload, { secret: this.accessSecret(), expiresIn: '8h', algorithm: 'HS256' });
    const refreshToken = this.jwtService.sign({ ...basePayload, tokenType: 'refresh' }, { secret: this.refreshSecret(), expiresIn: '7d', algorithm: 'HS256' });
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        workspaceId: active.workspaceId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: active.role,
        phone: user.phone,
        avatar: user.avatar,
      },
    };
  }
```

- [ ] **Step 4: Fix every `generateTokens`/`issueSession` caller to pass `active`**

The compiler will flag each. For each caller pass the resolved active membership:
- `registerWorkspace`/`provisionWorkspace` (owner just created): `{ workspaceId: owner.workspaceId, role: 'OWNER' }`.
- `verify2fa` and the non-2FA `login` return: resolved in Task 5 (they compute `active` from `MembershipService`). For now pass `{ workspaceId: user.workspaceId, role: user.role }` so it compiles; Task 5 replaces it.
- `sso.service` `issueSession(user)` call: Task 12 replaces it with the membership; for now `{ workspaceId: user.workspaceId, role: user.role }`.

- [ ] **Step 5: Run test + typecheck**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json && npx jest marketing-auth`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/marketing/services/marketing-auth.service.ts backend/src/modules/marketing/services/marketing-auth.membership.spec.ts
git commit -m "feat(membership): tokens carry the active membership's workspace+role"
```

## Task 5: `login` picks the default membership; inject `MembershipService`

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-auth.service.ts` (constructor + `login` + `verify2fa`)
- Modify: the auth service spec

**Interfaces:**
- Consumes: `MembershipService.resolveDefaultWorkspaceId` + `getActiveMembership`.
- Produces: login refuses a user with zero ACTIVE memberships (`401 "No active workspace"`) and otherwise mints tokens for the default membership.

- [ ] **Step 1: Write the failing test**

```ts
it('login lands on the default membership resolved by MembershipService', async () => {
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', role: 'OWNER', status: 'ACTIVE', password: hash, tokenVersion: 0, /* ... */ });
  membership.resolveDefaultWorkspaceId.mockResolvedValue('home');
  membership.getActiveMembership.mockResolvedValue({ workspaceId: 'home', role: 'OWNER', customRoleId: null });
  const out: any = await svc.login({ email: 'a@b.co', password: 'pw' } as any);
  expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'home', role: 'OWNER' });
});

it('login 401s a user with no ACTIVE membership', async () => {
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', status: 'ACTIVE', password: hash, /* ... */ });
  membership.resolveDefaultWorkspaceId.mockResolvedValue(null);
  await expect(svc.login({ email: 'a@b.co', password: 'pw' } as any)).rejects.toThrow('No active workspace');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest marketing-auth.membership.spec.ts` → FAIL.

- [ ] **Step 3: Implement**

Inject `MembershipService` into the constructor. Replace the two `return this.generateTokens(user)` sites in `login`/`verify2fa` with a shared private helper:

```ts
  private async issueForDefaultWorkspace(user: { id: string; workspaceId: string; /* full row */ role: string; tokenVersion: number; email: string; firstName: string; lastName: string; phone: string | null; avatar: string | null }) {
    const activeWorkspaceId = await this.membership.resolveDefaultWorkspaceId(user.id, user.workspaceId);
    if (!activeWorkspaceId) throw new UnauthorizedException('No active workspace');
    const m = await this.membership.getActiveMembership(user.id, activeWorkspaceId);
    if (!m) throw new UnauthorizedException('No active workspace');
    await this.assertWorkspaceActive(activeWorkspaceId);
    // keep the home pointer in sync so next login lands here
    if (user.workspaceId !== activeWorkspaceId) {
      await this.prisma.marketingUser.update({ where: { id: user.id }, data: { workspaceId: activeWorkspaceId } });
    }
    return this.generateTokens(user, { workspaceId: activeWorkspaceId, role: m.role });
  }
```

Replace `return this.generateTokens(user);` in the non-2FA `login` path and in `verify2fa` with `return this.issueForDefaultWorkspace(user);`. Remove the now-redundant `assertWorkspaceActive(user.workspaceId)` at login line 99 (the helper asserts the resolved active workspace).

- [ ] **Step 4: Run + typecheck**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json && npx jest marketing-auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/marketing/services/marketing-auth.service.ts backend/src/modules/marketing/services/marketing-auth.membership.spec.ts
git commit -m "feat(membership): login lands on the default membership"
```

## Task 6: `refreshToken` preserves the token's active workspace

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-auth.service.ts` (`refreshToken`)
- Modify: the auth service spec

**Interfaces:**
- Produces: refresh re-issues for the `wsp` embedded in the **refresh token**, re-verifying that membership is still ACTIVE; a revoked membership → `401 "Session revoked"`.

- [ ] **Step 1: Write the failing test**

```ts
it('refresh keeps the token active workspace (does not reset to home)', async () => {
  const refresh = sign({ sub: 'u1', wsp: 'wsp-2', role: 'REP', ver: 0, type: 'marketing', tokenType: 'refresh' });
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, /* ... */ });
  membership.getActiveMembership.mockResolvedValue({ workspaceId: 'wsp-2', role: 'REP', customRoleId: null });
  const out: any = await svc.refreshToken(refresh);
  expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'wsp-2', role: 'REP' });
});

it('refresh 401s when the token workspace membership was revoked', async () => {
  const refresh = sign({ sub: 'u1', wsp: 'wsp-2', ver: 0, type: 'marketing', tokenType: 'refresh' });
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', status: 'ACTIVE', tokenVersion: 0, /* ... */ });
  membership.getActiveMembership.mockResolvedValue(null);
  await expect(svc.refreshToken(refresh)).rejects.toThrow('Session revoked');
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (refresh currently derives workspace from `user.workspaceId`).

- [ ] **Step 3: Implement**

In `refreshToken`, after the tokenVersion check, replace `await this.assertWorkspaceActive(user.workspaceId); return this.generateTokens(user);` with:

```ts
    const activeWorkspaceId = typeof payload.wsp === 'string' ? payload.wsp : user.workspaceId;
    const m = await this.membership.getActiveMembership(user.id, activeWorkspaceId);
    if (!m) throw new UnauthorizedException('Session revoked');
    await this.assertWorkspaceActive(activeWorkspaceId);
    return this.generateTokens(user, { workspaceId: activeWorkspaceId, role: m.role });
```

- [ ] **Step 4: Run + typecheck** → PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(membership): refresh preserves the active workspace + re-verifies membership"
```

## Task 7: `POST /marketing/auth/switch-workspace`

**Files:**
- Create: `backend/src/modules/marketing/dto/switch-workspace.dto.ts`
- Modify: `backend/src/modules/marketing/services/marketing-auth.service.ts` (add `switchWorkspace`)
- Modify: `backend/src/modules/marketing/controllers/marketing-auth.controller.ts`
- Modify: the auth service spec

**Interfaces:**
- Produces: `switchWorkspace(userId: string, targetWorkspaceId: string): Promise<{ accessToken, refreshToken, user }>` — verifies an ACTIVE membership, updates the home pointer, re-mints; non-member → `403`. Route `POST /marketing/auth/switch-workspace` (guarded, `@Audit`).

- [ ] **Step 1: DTO**

Create `switch-workspace.dto.ts`:

```ts
import { IsString, IsNotEmpty } from 'class-validator';
export class SwitchWorkspaceDto {
  @IsString() @IsNotEmpty()
  workspaceId!: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
it('switchWorkspace re-mints for a workspace the user is an ACTIVE member of', async () => {
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, /* ... */ });
  membership.getActiveMembership.mockResolvedValue({ workspaceId: 'wsp-2', role: 'MANAGER', customRoleId: null });
  const out: any = await svc.switchWorkspace('u1', 'wsp-2');
  expect(jwtService.decode(out.accessToken)).toMatchObject({ wsp: 'wsp-2', role: 'MANAGER' });
  expect(prisma.marketingUser.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' }, data: { workspaceId: 'wsp-2' } }));
});

it('switchWorkspace 403s a non-member target (no enumeration)', async () => {
  prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u1', workspaceId: 'home', status: 'ACTIVE', tokenVersion: 0, /* ... */ });
  membership.getActiveMembership.mockResolvedValue(null);
  await expect(svc.switchWorkspace('u1', 'foreign')).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [ ] **Step 3: Run to verify it fails** → FAIL.

- [ ] **Step 4: Implement the service method**

```ts
  async switchWorkspace(userId: string, targetWorkspaceId: string) {
    const user = await this.prisma.marketingUser.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('User not found or inactive');
    const m = await this.membership.getActiveMembership(userId, targetWorkspaceId);
    if (!m) throw new ForbiddenException('You are not a member of that workspace');
    await this.assertWorkspaceActive(targetWorkspaceId);
    await this.prisma.marketingUser.update({ where: { id: userId }, data: { workspaceId: targetWorkspaceId } });
    return this.generateTokens(user, { workspaceId: targetWorkspaceId, role: m.role });
  }
```

- [ ] **Step 5: Add the route (guarded, audited)**

In `marketing-auth.controller.ts`, after `logout`:

```ts
  @Post('switch-workspace')
  @Audit({ action: 'auth.switch-workspace', resourceType: 'workspace' })
  switchWorkspace(@CurrentMarketingUser() user: MarketingUserPayload, @Body() dto: SwitchWorkspaceDto) {
    return this.authService.switchWorkspace(user.id, dto.workspaceId);
  }
```

Add imports for `SwitchWorkspaceDto` and `Audit`. Do NOT add `@MarketingPublic()`.

- [ ] **Step 6: Run + typecheck** → PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/marketing/dto/switch-workspace.dto.ts backend/src/modules/marketing/services/marketing-auth.service.ts backend/src/modules/marketing/controllers/marketing-auth.controller.ts backend/src/modules/marketing/services/marketing-auth.membership.spec.ts
git commit -m "feat(membership): switch-workspace endpoint"
```

## Task 8: New workspaces create an OWNER membership; profile returns memberships

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-auth.service.ts` (`registerWorkspace`/`provisionWorkspace`)
- Modify: `backend/src/modules/marketing/services/agency.service.ts` (`createLocation`)
- Modify: `backend/src/modules/marketing/controllers/marketing-auth.controller.ts` (`profile`) + `marketing-auth.service.ts` profile builder
- Modify: specs

**Interfaces:**
- Produces: every workspace-creation path also inserts an `ACTIVE OWNER` `WorkspaceMembership` for the owner (inside the same transaction). `GET /marketing/auth/profile` response gains `memberships: MembershipSummary[]`.

- [ ] **Step 1: Write the failing test** — assert `registerWorkspace` creates a membership and profile returns memberships:

```ts
it('registerWorkspace creates an ACTIVE OWNER membership for the owner', async () => {
  /* arrange the tx mock */
  await svc.registerWorkspace(dto);
  expect(prisma.workspaceMembership.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ role: 'OWNER', status: 'ACTIVE' }),
  }));
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement**

In `registerWorkspace`/`provisionWorkspace`, inside the existing `$transaction` that creates the workspace + owner, add after the owner `create`:

```ts
      await tx.workspaceMembership.create({
        data: { userId: owner.id, workspaceId: workspace.id, role: 'OWNER', status: 'ACTIVE', acceptedAt: new Date() },
      });
```

Do the same in `agency.service.ts createLocation` for the child OWNER (inside its tx). For the `provisionWorkspace` login-landing, mint tokens with `{ workspaceId: workspace.id, role: 'OWNER' }`.

Add a `profile` builder returning memberships (inject `MembershipService` into the auth service or resolve in the controller):

```ts
  async profile(userId: string, workspaceId: string) {
    const [user, workspace, memberships] = await Promise.all([
      this.prisma.marketingUser.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatar: true } }),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, kind: true } }),
      this.membership.listActiveMemberships(userId),
    ]);
    return { user, workspace, memberships };
  }
```

Wire the existing `GET profile` route to return this (it already returns `{ workspace }` — extend it, keeping `workspace` so `useWorkspaceProfile` keeps working).

- [ ] **Step 4: Run + typecheck** → PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(membership): workspace creation mints an OWNER membership; profile returns memberships"
```

## Task 9: FE store — memberships + `switchWorkspace` action

**Files:**
- Modify: `frontend/src/store/marketingAuthStore.ts`
- Create: `frontend/src/features/marketing/api/membershipApi.ts`
- Modify: `frontend/src/features/marketing/api/marketingApi.ts` (`NO_REFRESH_PATHS`)
- Modify: `frontend/src/pages/marketing/MarketingLoginPage.tsx` (store memberships)
- Create: `frontend/src/store/marketingAuthStore.test.ts`

**Interfaces:**
- Produces: store state `memberships: MembershipSummary[]`; action `switchWorkspace(workspaceId)` that calls the API, swaps tokens via `setTokens`, patches `user`, refreshes memberships, and clears the react-query cache — WITHOUT touching `agencyReturn`.

- [ ] **Step 1: Write the failing test** (Vitest) asserting `switchWorkspace` swaps tokens + updates role and does NOT set `agencyReturn`.

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement the API module**

`membershipApi.ts`:

```ts
import { marketingApi } from './marketingApi';
export interface MembershipSummary { workspaceId: string; workspaceName: string; role: string; }
export function switchWorkspaceApi(workspaceId: string) {
  return marketingApi.post('/auth/switch-workspace', { workspaceId }).then((r) => r.data as { user: any; accessToken: string; refreshToken: string });
}
```

- [ ] **Step 4: Implement the store**

Add `memberships: MembershipSummary[]` to state (default `[]`), persist it in `partialize`, set it in `login`, and add:

```ts
      switchWorkspace: async (workspaceId: string) => {
        const { switchWorkspaceApi } = await import('../features/marketing/api/membershipApi');
        const data = await switchWorkspaceApi(workspaceId);
        set((state) => ({
          user: state.user ? { ...state.user, workspaceId: data.user.workspaceId, role: data.user.role } : data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          // NOTE: agencyReturn is intentionally untouched — a switch is not impersonation.
        }));
      },
```

Add `/auth/switch-workspace` and `/auth/accept-invite` to `NO_REFRESH_PATHS` in `marketingApi.ts`. In `MarketingLoginPage.tsx`, after `login(...)`, also store `data.memberships` (extend the `login` action signature to accept memberships, or call a `setMemberships`).

- [ ] **Step 5: Run + build**

Run: `cd frontend && npx vitest run src/store/marketingAuthStore.test.ts && npx tsc -b`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/marketingAuthStore.ts frontend/src/store/marketingAuthStore.test.ts frontend/src/features/marketing/api/membershipApi.ts frontend/src/features/marketing/api/marketingApi.ts frontend/src/pages/marketing/MarketingLoginPage.tsx
git commit -m "feat(membership): FE auth store memberships + switchWorkspace action"
```

## Task 10: FE top-bar `WorkspaceSwitcher`

**Files:**
- Create: `frontend/src/features/marketing/components/WorkspaceSwitcher.tsx` + `.test.tsx`
- Modify: `frontend/src/features/marketing/components/MarketingHeader.tsx`

**Interfaces:**
- Consumes: store `memberships`, `user.workspaceId`, `switchWorkspace`; `useQueryClient()`.
- Produces: a dropdown rendered ONLY when `memberships.length > 1`; selecting a workspace calls `switchWorkspace` then `queryClient.clear()` then navigates to `/dashboard`.

- [ ] **Step 1: Write the failing test** — renders nothing for 1 membership; renders N items for >1; clicking an item calls `switchWorkspace(id)` then `queryClient.clear()`.

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

export function WorkspaceSwitcher() {
  const memberships = useMarketingAuthStore((s) => s.memberships);
  const activeWorkspaceId = useMarketingAuthStore((s) => s.user?.workspaceId);
  const switchWorkspace = useMarketingAuthStore((s) => s.switchWorkspace);
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (!memberships || memberships.length <= 1) return null;
  const onSelect = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) return;
    await switchWorkspace(workspaceId);
    qc.clear();               // every cached list belonged to the previous workspace
    navigate('/dashboard');
  };
  // render a DropdownMenu (reuse the header's DropdownMenu primitives) listing
  // memberships with a role badge; highlight activeWorkspaceId.
  return (/* dropdown JSX */);
}
```

Render `<WorkspaceSwitcher />` in `MarketingHeader.tsx`'s left cluster (next to `<Breadcrumbs />`).

- [ ] **Step 4: Run + build** → PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/marketing/components/WorkspaceSwitcher.tsx frontend/src/features/marketing/components/WorkspaceSwitcher.test.tsx frontend/src/features/marketing/components/MarketingHeader.tsx
git commit -m "feat(membership): top-bar workspace switcher (shown only for N>1 memberships)"
```

**Phase 1 done:** existing users unaffected (one backfilled membership); a logged-in user creating a second workspace gets an OWNER membership and can switch.

---

# PHASE 2 — Cross-org invitations + membership-granular users

## Task 11: Invite endpoint + service

**Files:**
- Create: `backend/src/modules/marketing/dto/invite-member.dto.ts`
- Modify: `backend/src/modules/marketing/services/membership.service.ts` (add `invite`)
- Create: `backend/src/modules/marketing/services/membership.service.invite.spec.ts`
- Modify: `backend/src/modules/marketing/controllers/marketing-users.controller.ts`

**Interfaces:**
- Produces: `invite(workspaceId, actorUserId, dto: { email, role, customRoleId? }): Promise<{ membershipId, status }>` —
  - existing identity → `INVITED` membership for `(thatUser, workspace, role)`;
  - new email → pending identity (unusable password) + `INVITED` membership + accept token;
  - existing ACTIVE/INVITED membership for the pair → `409`.
  Route `POST /marketing/users/invite` requires `users.manage`.

- [ ] **Step 1: DTO** — `email` (IsEmail), `role` (IsIn MANAGER/REP), `customRoleId?`.
- [ ] **Step 2: Write the failing test** — existing identity path, new-identity path, duplicate 409.
- [ ] **Step 3: Run to verify it fails** → FAIL.
- [ ] **Step 4: Implement** `invite` (wrap identity-create + membership-create in a `$transaction`; map P2002 on `(userId, workspaceId)` → `409`; generate a signed accept token for the new-identity path via the auth service's JWT with a short TTL + `type: 'invite'`).
- [ ] **Step 5: Add the route** with `@RequirePermission('users.manage')` + `@Audit`.
- [ ] **Step 6: Run + typecheck** → PASS.
- [ ] **Step 7: Commit** `feat(membership): invite endpoint (existing + new identity, dup 409)`.

## Task 12: Accept endpoint + service

**Files:**
- Create: `backend/src/modules/marketing/dto/accept-invite.dto.ts`
- Modify: `membership.service.ts` (add `accept`), `marketing-auth.controller.ts`
- Modify: the invite spec

**Interfaces:**
- Produces: `accept(token OR (userId, membershipId))` → set membership `ACTIVE` + `acceptedAt`; new-identity path sets the password here. Route `POST /marketing/auth/accept-invite` (public, throttled) and `POST /marketing/memberships/:id/accept` (guarded, logged-in accept).

- [ ] **Step 1: DTO** — `token` + optional `password` (new-identity path).
- [ ] **Step 2: Write the failing test** — accept flips INVITED→ACTIVE + sets acceptedAt; new-identity path sets password; expired/invalid token → 401.
- [ ] **Step 3: Run to verify it fails** → FAIL.
- [ ] **Step 4: Implement** `accept` (verify the invite token, load the membership, atomic `updateMany` claim `status: 'INVITED' → 'ACTIVE'` so a double-accept is a no-op; set password when present).
- [ ] **Step 5: Add both routes.**
- [ ] **Step 6: Run + typecheck** → PASS.
- [ ] **Step 7: Commit** `feat(membership): accept-invite (token + logged-in paths)`.

## Task 13: `marketing-users.service` reframed to membership granularity

**Files:**
- Modify: `backend/src/modules/marketing/services/marketing-users.service.ts`
- Modify: `backend/src/modules/marketing/controllers/marketing-users.controller.ts`
- Modify: `backend/src/modules/marketing/services/marketing-users.service.spec.ts` (+ any existing)

**Interfaces:**
- Produces:
  - `findAll(workspaceId)` → this workspace's memberships joined to identities (was: user rows by `workspaceId`).
  - "deactivate" → `SUSPEND` the membership (not the global identity).
  - seat limit counts `ACTIVE` memberships in the workspace (was: user rows); advisory lock key stays `'users:' + workspaceId`.
  - OWNER-protection / no-promote-to-OWNER / privilege-floor guards operate on the target membership's role.

- [ ] **Step 1: Write the failing tests** — list returns memberships; deactivate suspends the membership and leaves the identity + its other memberships intact; seat count counts ACTIVE memberships; last-OWNER-of-workspace deactivate is blocked (see Task 17 for the dedicated guard, referenced here).
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — swap `marketingUser.count/findMany` for `workspaceMembership` equivalents; `assertSeatAvailable` counts `workspaceMembership.count({ workspaceId, role: { not: 'SYSTEM' }, status: 'ACTIVE' })`; deactivate does `workspaceMembership.updateMany({ where: { userId, workspaceId }, data: { status: 'SUSPENDED' } })`.
- [ ] **Step 4: Update the controller** — `create` → delegate to `invite` (Task 11) or keep as a thin alias; `findAll`/`delete` call the reframed methods.
- [ ] **Step 5: Run + typecheck + arch spec** → PASS (add any new membership-count exemptions to the fitness spec if the count is workspace-scoped — it is, so no exemption needed).
- [ ] **Step 6: Commit** `feat(membership): users service at membership granularity (list/suspend/seat-limit)`.

## Task 14: SSO attaches a membership

**Files:**
- Modify: `backend/src/modules/marketing/services/sso.service.ts` (`matchOrProvision`, `handleCallback`)
- Modify: `backend/src/modules/marketing/services/sso.service.spec.ts`

**Interfaces:**
- Produces: SSO login ensures an `ACTIVE` membership for `(user, connection.workspaceId)` — creating the identity + membership on JIT, or attaching a membership to an existing identity that lacks one in this workspace. `handleCallback` mints the session for that membership via `issueSession(user, { workspaceId, role })`.

- [ ] **Step 1: Write the failing test** — JIT provisions identity + membership; existing identity without a membership here gets one attached; `issueSession` receives the membership's workspace+role.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — `matchOrProvision` returns `{ user, membership }`; on JIT, create the user then the `ACTIVE REP` membership in a tx; on existing user, `upsert` the membership. Update `handleCallback` to `issueSession(user, { workspaceId, role: membership.role })`.
- [ ] **Step 4: Run + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(membership): SSO ensures/attaches a workspace membership`.

## Task 15: FE — pending invites + invite management UI

**Files:**
- Modify: `frontend/src/features/marketing/api/membershipApi.ts` (invite/accept/list-pending calls)
- Create/Modify: the users-management page + a pending-invites affordance near the switcher
- Create: `.test.tsx`

- [ ] **Step 1: Write the failing test** — invite form posts; pending-invite badge shows count; accept/decline call the API + refresh.
- [ ] **Step 2–4: Implement + run + typecheck.**
- [ ] **Step 5: Commit** `feat(membership): FE invite management + pending-invites affordance`.

---

# PHASE 3 — Polish + edge cases

## Task 16: Block suspending/removing the last ACTIVE OWNER of a workspace

**Files:**
- Modify: `backend/src/modules/marketing/services/membership.service.ts` (or users service) — add `assertNotLastOwner`
- Modify: the relevant spec

**Interfaces:**
- Produces: any transition that would drop a workspace's ACTIVE-OWNER count to zero (suspend/remove/role-change of the last OWNER) throws `409 "A workspace must keep at least one owner"`.

- [ ] **Step 1: Write the failing test** — suspending the only OWNER throws; suspending one of two OWNERs succeeds.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — before the suspend/role-change, `count({ workspaceId, role: 'OWNER', status: 'ACTIVE', NOT: { id: targetMembershipId } })`; if `0` and the target is an OWNER losing OWNER/ACTIVE, throw.
- [ ] **Step 4: Run + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(membership): protect the last owner of a workspace`.

## Task 17: FE — orphaned-session handling

**Files:**
- Modify: `frontend/src/features/marketing/components/MarketingProtectedRoute.tsx` and/or the axios 401 path (already logs out on refresh failure).

**Interfaces:**
- Produces: a user whose only membership is suspended mid-session gets `401` on the next request → the existing interceptor `logout()` + route to `/login` (verify it holds; add a test).

- [ ] **Step 1: Write the failing test** (Vitest) — a 401 with no recoverable refresh routes to login and clears the store.
- [ ] **Step 2–4: Verify/patch + run.**
- [ ] **Step 5: Commit** `feat(membership): orphaned session routes to login`.

## Task 18: Hide the switcher during agency impersonation

**Files:**
- Modify: `frontend/src/features/marketing/components/WorkspaceSwitcher.tsx`

**Interfaces:**
- Produces: `WorkspaceSwitcher` returns `null` when `agencyReturn` is set (impersonation active) — the two session-swap flows never interleave (the plan's chosen default from the spec's open edge case).

- [ ] **Step 1: Write the failing test** — with `agencyReturn` set, the switcher renders nothing even for N>1 memberships.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** — add `const impersonating = useMarketingAuthStore((s) => !!s.agencyReturn); if (impersonating) return null;`.
- [ ] **Step 4: Run + build** → PASS.
- [ ] **Step 5: Commit** `feat(membership): hide switcher during agency impersonation`.

## Task 19: Audit coverage + regression sweep

**Files:**
- Verify `@Audit` on switch (Task 7), invite (Task 11), accept, membership role-change, and removal (Task 13/16). Add any missing.
- Run the full backend + frontend suites.

- [ ] **Step 1: Add missing `@Audit` decorators** on invite/accept/role-change/removal routes.
- [ ] **Step 2: Backend full gate** — `cd backend && npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest src/modules/marketing && npx jest workspace-scoping.arch`. Expected: green.
- [ ] **Step 3: Frontend full gate** — `cd frontend && npx tsc -b && npx vitest run`. Expected: green.
- [ ] **Step 4: Migration round-trip re-verify** (Task 1 Step 4) on a fresh dev DB.
- [ ] **Step 5: Commit** `test(membership): audit coverage + full-suite regression pass`.

---

## Open decisions locked by this plan (from the spec's open edge cases)

- **Guard = 1 DB hit:** achieved via the `MarketingUser.memberships` relation + a filtered `include` (Task 1 adds the FK/relation; Task 3 uses it).
- **Last-owner protection:** Task 16 (membership-granular analogue of today's OWNER-account protection).
- **Orphaned session:** Task 17 — next request 401 → existing interceptor logout + route to login.
- **Impersonation interplay:** Task 18 — default = hide the switcher while `agencyReturn` is set (keeps the two flows off the same store field).
- **`generateTokens` callers:** Task 4 lists all five (`registerWorkspace`, `provisionWorkspace`, `verify2fa`, `login`, `sso`); each is updated to pass the active membership.

## Self-review notes (coverage vs spec)

- §1 data model + migration → Task 1. §2 auth/session/switch → Tasks 3–8. §3 invitations + users refactor → Tasks 11–14. §4 frontend → Tasks 9, 10, 15, 18. §5 security (immediate revocation, no enumeration, consent, seat limits, audit) → Tasks 3, 7, 11, 13, 19. §6 testing → each task's TDD steps + Task 19. Rollout phases 1/2/3 → the three plan sections. Open edge cases → Tasks 16, 17, 18. No spec section is left without a task.
