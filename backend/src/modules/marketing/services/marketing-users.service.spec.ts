import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MarketingUsersService } from './marketing-users.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc(maxUsers: number) {
  const prisma = mockPrismaClient();
  // The reactivation seat-limit path runs under an advisory-locked
  // $transaction; make it execute the callback against the same mock
  // client. (create() no longer locks anything itself — see create()'s
  // docstring in marketing-users.service.ts — so this only matters for
  // update()'s SUSPENDED→ACTIVE reactivation tests below.)
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ locked: 'x' }]);
  const config = { get: () => undefined } as any;
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxUsers }) } as any;
  // Multi-workspace membership (Phase 2 Task 13) — create() now delegates the
  // actual row-creation (AND the seat cap — Fix 2) to
  // MembershipService.invite(); mocked here so these are true unit tests of
  // the thin delegate, not of invite() itself (that's covered by
  // membership.service.invite.spec.ts).
  const membership = { invite: jest.fn() } as any;
  const svc = new MarketingUsersService(prisma as any, config, entitlements, membership);
  return { prisma, svc, entitlements, membership };
}

describe('MarketingUsersService — deactivate (delete) guards', () => {
  // A MANAGER could deactivate a MANAGER — including THEMSELVES — locking
  // themselves out mid-session (only another admin can reactivate). The OWNER is
  // already protected; this closes the same footgun for self-deactivation.
  it('refuses to let an actor deactivate their own account', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-1', userId: 'mgr-1', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE',
    } as any);
    await expect((svc.delete as any)(WS, 'mgr-1', 'MANAGER', 'mgr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });

  it('allows a manager to deactivate a DIFFERENT manager', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-2', userId: 'mgr-2', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE',
    } as any);
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    await (svc.delete as any)(WS, 'mgr-2', 'MANAGER', 'mgr-1');
    expect(prisma.workspaceMembership.updateMany).toHaveBeenCalledWith({
      where: { userId: 'mgr-2', workspaceId: WS },
      data: { status: 'SUSPENDED' },
    });
  });

  // Multi-workspace membership (Task 13) — deactivate() SUSPENDS the
  // membership row, never the shared MarketingUser identity: the target may
  // hold OTHER workspaces' memberships that must stay untouched.
  it('suspends the MEMBERSHIP only — never touches the shared MarketingUser identity', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-3', userId: 'rep-1', workspaceId: WS, role: 'REP', status: 'ACTIVE',
    } as any);
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    await svc.delete(WS, 'rep-1', 'MANAGER', 'mgr-1');
    expect(prisma.workspaceMembership.updateMany).toHaveBeenCalledWith({
      where: { userId: 'rep-1', workspaceId: WS },
      data: { status: 'SUSPENDED' },
    });
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    expect(prisma.marketingUser.updateMany).not.toHaveBeenCalled();
  });

  // SYSTEM sentinels (Task 1's backfill gives them a membership row too) are
  // never a "user" this surface manages — 404, same as the old role-based check.
  it('404s on a SYSTEM sentinel membership (not a manageable "user")', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-sys', userId: 'sys-1', workspaceId: WS, role: 'SYSTEM', status: 'ACTIVE',
    } as any);
    await expect(svc.delete(WS, 'sys-1', 'OWNER', 'owner-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });

  it('404s when no membership ties this user to the workspace', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    await expect(svc.delete(WS, 'ghost-1', 'OWNER', 'owner-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  // Task 16 Fix 2 — assertCanDeactivate used to lack the "only an OWNER may
  // touch an OWNER" gate that update() already had, so a MANAGER could
  // DELETE /users/:coOwnerId and suspend a co-owner. Must be rejected before
  // ever reaching the last-owner count (no DB round trip at all).
  it('refuses to let a MANAGER deactivate an OWNER target (Fix 2 — only an owner may touch an owner)', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner', userId: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
    } as any);
    await expect(svc.delete(WS, 'owner-1', 'MANAGER', 'mgr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });
});

describe('MarketingUsersService — update() deactivation guards (parity with delete())', () => {
  // update() writes dto.status, so `status: 'INACTIVE'` deactivates a member — but it
  // must NOT bypass the same guards delete() enforces, or a user locks themselves
  // out (self-deactivation) / the OWNER membership gets suspended via a PATCH.
  it('refuses to let an actor deactivate THEIR OWN account via a status update', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-1', userId: 'mgr-1', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE',
      user: { id: 'mgr-1', email: 'm@x.co', firstName: 'M', lastName: 'X', phone: null },
    } as any);
    await expect((svc.update as any)(WS, 'mgr-1', { status: 'INACTIVE' }, 'MANAGER', 'mgr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  // This used to pass via the self-suspend check (actor === target), not the
  // last-owner guard — count() was left unmocked (=> undefined), so it never
  // actually proved assertNotLastOwner fires here. Split into two: one that
  // still proves self-suspend is blocked for an OWNER, and one (Fix 3) that
  // uses a DIFFERENT actor + an explicit count()=0 mock so the ConflictException
  // demonstrably comes from the last-owner guard, not the self-suspend gate.
  it('still blocks an OWNER from deactivating themselves via a status update (self-suspend gate)', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner', userId: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
      user: { id: 'owner-1', email: 'o@x.co', firstName: 'O', lastName: 'X', phone: null },
    } as any);
    await expect((svc.update as any)(WS, 'owner-1', { status: 'INACTIVE' }, 'OWNER', 'owner-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it('blocks deactivating the ONLY owner via a status update from a DIFFERENT actor (last-owner guard, Fix 3)', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner', userId: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
      user: { id: 'owner-1', email: 'o@x.co', firstName: 'O', lastName: 'X', phone: null },
    } as any);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(0); // no other active owners
    await expect(
      (svc.update as any)(WS, 'owner-1', { status: 'INACTIVE' }, 'OWNER', 'owner-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.workspaceMembership.count).toHaveBeenCalledWith({
      where: { workspaceId: WS, role: 'OWNER', status: 'ACTIVE', NOT: { userId: 'owner-1' } },
    });
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it('still allows deactivating a DIFFERENT user via a status update, touching only the MEMBERSHIP', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-2', userId: 'mgr-2', workspaceId: WS, role: 'MANAGER', status: 'ACTIVE',
      user: { id: 'mgr-2', email: 'm2@x.co', firstName: 'M2', lastName: 'X', phone: null },
    } as any);
    (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'MANAGER', status: 'SUSPENDED' });
    await (svc.update as any)(WS, 'mgr-2', { status: 'INACTIVE' }, 'MANAGER', 'mgr-1');
    expect(prisma.workspaceMembership.update).toHaveBeenCalledWith({
      where: { id: 'mem-2' },
      data: { status: 'SUSPENDED' },
      select: { role: true, status: true },
    });
    // A pure status change never touches the shared identity row.
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });
});

// Phase 3 Task 16 — a workspace must never drop to zero ACTIVE owners.
// assertNotLastOwner() is count-based (not a blanket "OWNER is untouchable"
// block), so it must (a) still block the ONLY owner, exactly like the old
// blanket guard did, and (b)/(d) newly ALLOW managing a non-last owner once
// a workspace legitimately has more than one — proving the guard is
// membership-granular, not role-blanket.
describe('MarketingUsersService — last-owner protection (Task 16)', () => {
  // Actor must be an OWNER here (not a MANAGER) — since Task 16 Fix 2, a
  // MANAGER is rejected by the "only an owner may touch an owner" gate
  // before ever reaching the last-owner count (see the dedicated Fix 2 test
  // in the "deactivate (delete) guards" describe block above); this test's
  // job is to prove the last-owner guard itself, so it uses a DIFFERENT
  // OWNER actor to get past that gate.
  it('blocks suspending the ONLY active owner via delete() with ConflictException', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner', userId: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
    } as any);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(0); // no other active owners
    await expect(svc.delete(WS, 'owner-1', 'OWNER', 'owner-2')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.workspaceMembership.count).toHaveBeenCalledWith({
      where: { workspaceId: WS, role: 'OWNER', status: 'ACTIVE', NOT: { userId: 'owner-1' } },
    });
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });

  it('allows suspending ONE of TWO active owners (not the last one)', async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner-2', userId: 'owner-2', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
    } as any);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(1); // one other active owner remains
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    await svc.delete(WS, 'owner-2', 'OWNER', 'owner-1');
    expect(prisma.workspaceMembership.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner-2', workspaceId: WS },
      data: { status: 'SUSPENDED' },
    });
  });

  it("blocks demoting the ONLY owner's role via update() with ConflictException", async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner', userId: 'owner-1', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
      user: { id: 'owner-1', email: 'o@x.co', firstName: 'O', lastName: 'X', phone: null },
    } as any);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(0); // no other active owners
    await expect(
      svc.update(WS, 'owner-1', { role: 'MANAGER' } as any, 'OWNER', 'owner-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it("allows demoting ONE of TWO owners' role via update() (not the last one)", async () => {
    const { prisma, svc } = makeSvc(-1);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'mem-owner-2', userId: 'owner-2', workspaceId: WS, role: 'OWNER', status: 'ACTIVE',
      user: { id: 'owner-2', email: 'o2@x.co', firstName: 'O2', lastName: 'X', phone: null },
    } as any);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(1); // one other active owner remains
    (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'MANAGER', status: 'ACTIVE' });
    await expect(
      svc.update(WS, 'owner-2', { role: 'MANAGER' } as any, 'OWNER', 'owner-1'),
    ).resolves.toMatchObject({ id: 'owner-2', role: 'MANAGER' });
  });
});

describe('MarketingUsersService — seat limit', () => {
  describe('update() reactivation', () => {
    it('rejects reactivating a SUSPENDED membership when the workspace is at its seat cap', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'SUSPENDED',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      // Already 5 ACTIVE+INVITED seats — reactivating u1 would make 6.
      (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(5);

      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
    });

    it('allows reactivation when a seat is free', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'SUSPENDED',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(4); // room for one more
      (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'REP', status: 'ACTIVE' });

      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).resolves.toMatchObject({ id: 'u1', status: 'ACTIVE' });
      expect(prisma.workspaceMembership.update).toHaveBeenCalled();
    });

    it('does NOT seat-check a no-op (already ACTIVE) or a non-status edit', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'ACTIVE',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'REP', status: 'ACTIVE' });
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({
        id: 'u1', email: 'u1@b.com', firstName: 'New', lastName: '1', phone: null,
      });

      // status ACTIVE on an already-ACTIVE membership, and a plain name edit — neither
      // consumes a new seat, so neither must hit the (cap-exceeded) limit.
      (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(5);
      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE', firstName: 'New' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
      await expect(
        svc.update(WS, 'u1', { firstName: 'Other' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
    });

    it('skips the limit entirely on an unlimited (-1) package', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'SUSPENDED',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(9999);
      (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'REP', status: 'ACTIVE' });
      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
    });

    // Fix 3 (Task 13 review) — an INVITED membership flipped straight to
    // ACTIVE through this admin path bypasses MembershipService.accept(),
    // which is the ONLY place a pending invite's real password gets set.
    // That would produce an ACTIVE member stuck with the unusable
    // invite-time sentinel password (can never log in) while still
    // consuming a real seat. Only SUSPENDED→ACTIVE may proceed here.
    it('rejects reactivating an INVITED membership straight to ACTIVE (must go through accept())', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'INVITED',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      await expect(
        svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
      // No seat-cap machinery should even run for a rejected transition.
      expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
    });

    it('SUSPENDED→ACTIVE reactivation still works after the INVITED guard (parity check)', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u2', userId: 'u2', workspaceId: WS, role: 'REP', status: 'SUSPENDED',
        user: { id: 'u2', email: 'u2@b.com', firstName: 'U', lastName: '2', phone: null },
      } as any);
      (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'REP', status: 'ACTIVE' });
      await expect(
        svc.update(WS, 'u2', { status: 'ACTIVE' } as any, 'MANAGER'),
      ).resolves.toMatchObject({ id: 'u2', status: 'ACTIVE' });
    });
  });

  // Fix 2 (Task 13 review) — create() is now an UNCONDITIONAL thin delegate:
  // the seat cap lives ENTIRELY in MembershipService.invite() (see
  // membership.service.invite.spec.ts's "seat cap (Fix 2)" block), so this
  // service no longer counts seats or takes its own lock before calling
  // invite() — doing so, on TOP of invite()'s own identical lock, would
  // self-deadlock two separate connections contending for the same
  // pg_advisory_xact_lock key (see create()'s docstring).
  describe('create() (unconditional thin delegate to MembershipService.invite)', () => {
    it('delegates straight to MembershipService.invite with the actor id — no local seat check or lock', async () => {
      const { prisma, svc, membership, entitlements } = makeSvc(5);
      (membership.invite as jest.Mock).mockResolvedValue({ membershipId: 'mem-new', status: 'INVITED' });
      const dto = { email: 'a@b.com', password: 'Abcd1234', firstName: 'A', lastName: 'B', role: 'REP' };
      const out = await svc.create(WS, dto as any, 'actor-1');
      expect(membership.invite).toHaveBeenCalledWith(WS, 'actor-1', dto);
      expect(out).toEqual({ membershipId: 'mem-new', status: 'INVITED' });
      expect(entitlements.getEffective).not.toHaveBeenCalled();
      expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('propagates the BadRequestException MembershipService.invite throws at its own seat cap', async () => {
      const { svc, membership } = makeSvc(5);
      (membership.invite as jest.Mock).mockRejectedValue(
        new BadRequestException('Seat limit reached (5) — upgrade your package to add users'),
      );
      await expect(
        svc.create(WS, { email: 'over-cap@b.com', password: 'Abcd1234', role: 'REP' } as any, 'actor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // A bare seat-count-then-write lets two concurrent seat-consuming
  // reactivations at (cap-1) BOTH pass and exceed maxUsers. update()'s
  // reactivation path is serialized under a per-workspace advisory xact-lock
  // (the research / knowledge pattern) — the create() side of this is now
  // MembershipService.invite()'s own concern (see its spec).
  describe('seat-limit — advisory-lock race safety (update() reactivation)', () => {
    it('reactivation locks the seat-check + the ACTIVE flip', async () => {
      const { prisma, svc } = makeSvc(5);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'SUSPENDED',
        user: { id: 'u1', email: 'u1@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(4);
      (prisma.workspaceMembership.update as jest.Mock).mockResolvedValue({ role: 'REP', status: 'ACTIVE' });
      await svc.update(WS, 'u1', { status: 'ACTIVE' } as any, 'MANAGER');
      expect(prisma.$transaction).toHaveBeenCalled();
      const lockSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
      expect(lockSql).toContain('users:ws-1');
      expect(prisma.workspaceMembership.update).toHaveBeenCalled();
    });
  });

  describe('update() email change', () => {
    it('rejects changing the email to one already used by another user (clean 409, not a 500)', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'ACTIVE',
        user: { id: 'u1', email: 'old@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      // Another user already owns the target email.
      prisma.marketingUser.findUnique.mockResolvedValue({ id: 'u2' } as any);

      await expect(
        svc.update(WS, 'u1', { email: 'taken@b.com' } as any, 'MANAGER'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.marketingUser.update).not.toHaveBeenCalled();
    });

    it('allows changing the email to an unused address', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'ACTIVE',
        user: { id: 'u1', email: 'old@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      prisma.marketingUser.findUnique.mockResolvedValue(null); // free
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({
        id: 'u1', email: 'new@b.com', firstName: 'U', lastName: '1', phone: null,
      });

      await expect(
        svc.update(WS, 'u1', { email: 'new@b.com' } as any, 'MANAGER'),
      ).resolves.toMatchObject({ id: 'u1', email: 'new@b.com' });
    });

    it('does not treat re-saving the SAME email as a conflict', async () => {
      const { prisma, svc } = makeSvc(-1);
      prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'mem-u1', userId: 'u1', workspaceId: WS, role: 'REP', status: 'ACTIVE',
        user: { id: 'u1', email: 'same@b.com', firstName: 'U', lastName: '1', phone: null },
      } as any);
      (prisma.marketingUser.update as jest.Mock).mockResolvedValue({
        id: 'u1', email: 'same@b.com', firstName: 'X', lastName: '1', phone: null,
      });

      await expect(
        svc.update(WS, 'u1', { email: 'same@b.com', firstName: 'X' } as any, 'MANAGER'),
      ).resolves.toBeDefined();
      // No uniqueness lookup needed when the email is unchanged.
      expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
    });
  });
});

describe('MarketingUsersService — findAll()', () => {
  it("returns this workspace's non-SYSTEM memberships joined to their identity, including INVITED + SUSPENDED", async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.workspaceMembership.findMany as jest.Mock).mockResolvedValue([
      {
        userId: 'u1', role: 'MANAGER', status: 'ACTIVE', createdAt: new Date('2024-01-01'),
        user: { email: 'a@b.com', firstName: 'A', lastName: 'B', phone: '+905551112233' },
      },
      {
        userId: 'u2', role: 'REP', status: 'INVITED', createdAt: new Date('2024-01-02'),
        user: { email: 'c@d.com', firstName: 'C', lastName: 'D', phone: null },
      },
      {
        userId: 'u3', role: 'REP', status: 'SUSPENDED', createdAt: new Date('2024-01-03'),
        user: { email: 'e@f.com', firstName: 'E', lastName: 'F', phone: null },
      },
    ]);

    const out = await svc.findAll(WS);

    expect(prisma.workspaceMembership.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, role: { not: 'SYSTEM' } },
      include: { user: { select: { email: true, firstName: true, lastName: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
    expect(out).toEqual([
      { id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B', phone: '+905551112233', role: 'MANAGER', status: 'ACTIVE', createdAt: new Date('2024-01-01') },
      { id: 'u2', email: 'c@d.com', firstName: 'C', lastName: 'D', phone: null, role: 'REP', status: 'INVITED', createdAt: new Date('2024-01-02') },
      { id: 'u3', email: 'e@f.com', firstName: 'E', lastName: 'F', phone: null, role: 'REP', status: 'SUSPENDED', createdAt: new Date('2024-01-03') },
    ]);
  });

  it('returns an empty list when the workspace has no non-SYSTEM memberships', async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.workspaceMembership.findMany as jest.Mock).mockResolvedValue([]);
    await expect(svc.findAll(WS)).resolves.toEqual([]);
  });
});

// Fix 1b (Task 13 review) — findOne() used to read role/status off the
// (frozen-at-creation, now-stale) MarketingUser row; it must join the
// membership the same way findAll() does.
describe('MarketingUsersService — findOne()', () => {
  it("returns the MEMBERSHIP's role/status (not the stale MarketingUser columns), joined to the identity", async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue({
      role: 'MANAGER',
      status: 'ACTIVE',
      user: {
        id: 'u1',
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        phone: '+905551112233',
        avatar: null,
        lastLogin: new Date('2024-02-01'),
        createdAt: new Date('2024-01-01'),
        _count: { leads: 3, activities: 5, commissions: 1, tasks: 2 },
      },
    });

    const out = await svc.findOne(WS, 'u1');

    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', workspaceId: WS, role: { not: 'SYSTEM' } },
      select: {
        role: true,
        status: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            avatar: true,
            lastLogin: true,
            createdAt: true,
            _count: {
              select: { leads: true, activities: true, commissions: true, tasks: true },
            },
          },
        },
      },
    });
    expect(out).toEqual({
      id: 'u1',
      email: 'a@b.com',
      firstName: 'A',
      lastName: 'B',
      phone: '+905551112233',
      avatar: null,
      lastLogin: new Date('2024-02-01'),
      createdAt: new Date('2024-01-01'),
      _count: { leads: 3, activities: 5, commissions: 1, tasks: 2 },
      role: 'MANAGER',
      status: 'ACTIVE',
    });
  });

  it('404s when no membership ties this user to the workspace', async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.findOne(WS, 'ghost-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s on a SYSTEM sentinel membership (not a manageable "user")', async () => {
    // The `role: { not: 'SYSTEM' }` filter means the mocked findFirst simply
    // returns null for a SYSTEM row, same as a real Prisma query would.
    const { prisma, svc } = makeSvc(-1);
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.findOne(WS, 'sys-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
