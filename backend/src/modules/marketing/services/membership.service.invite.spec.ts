import { BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MembershipService } from './membership.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Phase 2 Task 11 — MembershipService.invite(): existing-identity (new
 * INVITED membership, no new user), new-identity (pending user + INVITED
 * membership + accept token), and the duplicate-membership 409.
 *
 * A real JwtService is used (not a jest.fn() stub) so `.decode()` can inspect
 * the accept token's claims, mirroring marketing-auth.membership.spec.ts.
 */
function makeSvc(maxUsers: number = -1) {
  const prisma = mockPrismaClient();
  // invite() runs in one $transaction; execute the callback against the same
  // mocked client (mirrors marketing-users.service.spec.ts's makeSvc()).
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ locked: 'x' }]);
  const jwt = new JwtService();
  const config = {
    get: jest.fn((key: string) => (key === 'MARKETING_JWT_SECRET' ? 'invite-secret' : undefined)),
  };
  // Defaults to unlimited so the existing (non-seat-cap) tests below are
  // unaffected; the seat-cap describe block overrides this per-test.
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxUsers }) };
  const svc = new MembershipService(prisma as any, jwt, config as any, entitlements as any);
  return { prisma, svc, jwt, entitlements };
}

const WS = 'ws-1';
const ACTOR = 'actor-1';

describe('MembershipService.invite', () => {
  it('existing identity → creates an INVITED membership, no new MarketingUser', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue({
      id: 'u-existing',
      email: 'exist@x.co',
    });
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null); // no dup
    (prisma.workspaceMembership.create as jest.Mock).mockResolvedValue({ id: 'mem-1' });

    const out = await svc.invite(WS, ACTOR, { email: 'exist@x.co', role: 'REP' });

    expect(out).toEqual({ membershipId: 'mem-1', status: 'INVITED' });
    expect(prisma.marketingUser.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.create).toHaveBeenCalledWith({
      data: {
        userId: 'u-existing',
        workspaceId: WS,
        role: 'REP',
        customRoleId: null,
        status: 'INVITED',
        invitedByUserId: ACTOR,
      },
      select: { id: true },
    });
  });

  it('new email → provisions a pending identity + INVITED membership + returns an inviteToken', async () => {
    const { prisma, svc, jwt } = makeSvc();
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue(null); // no existing identity
    (prisma.marketingUser.create as jest.Mock).mockResolvedValue({ id: 'u-new' });
    (prisma.workspaceMembership.create as jest.Mock).mockResolvedValue({ id: 'mem-2' });

    const out = await svc.invite(WS, ACTOR, { email: 'new@x.co', role: 'MANAGER' });

    // Pending identity: active status, workspace = the inviting workspace, an
    // unusable (random, not empty/predictable) password.
    const createCall = (prisma.marketingUser.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      workspaceId: WS,
      email: 'new@x.co',
      role: 'MANAGER',
      status: 'ACTIVE',
    });
    expect(typeof createCall.data.password).toBe('string');
    expect(createCall.data.password.length).toBeGreaterThan(20);

    expect(prisma.workspaceMembership.create).toHaveBeenCalledWith({
      data: {
        userId: 'u-new',
        workspaceId: WS,
        role: 'MANAGER',
        customRoleId: null,
        status: 'INVITED',
        invitedByUserId: ACTOR,
      },
      select: { id: true },
    });

    expect(out.membershipId).toBe('mem-2');
    expect(out.status).toBe('INVITED');
    expect(typeof out.inviteToken).toBe('string');

    // The token must never verify as a marketing SESSION: it carries `typ`
    // (not `type`), so MarketingGuard's `payload.type !== 'marketing'` check
    // always rejects it.
    const decoded: any = jwt.decode(out.inviteToken!);
    expect(decoded.typ).toBe('marketing-invite');
    expect(decoded.type).toBeUndefined();
    expect(decoded.membershipId).toBe('mem-2');
  });

  it('duplicate ACTIVE/INVITED membership for (user, workspace) → 409', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue({
      id: 'u-existing',
      email: 'exist@x.co',
    });
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue({ id: 'mem-existing' });

    await expect(
      svc.invite(WS, ACTOR, { email: 'exist@x.co', role: 'REP' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
  });

  it('customRoleId that does not belong to this workspace → 400, no create at all', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.customRole.findFirst as jest.Mock).mockResolvedValue(null); // not found in this workspace

    await expect(
      svc.invite(WS, ACTOR, { email: 'exist@x.co', role: 'REP', customRoleId: 'role-other-ws' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.customRole.findFirst).toHaveBeenCalledWith({
      where: { id: 'role-other-ws', workspaceId: WS },
      select: { id: true },
    });
    expect(prisma.marketingUser.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
  });

  // Phase 2 Task 12 — the token invite() mints must be the SAME shape
  // verifyInviteToken() (accept's entry point) accepts, round-tripped through
  // a real JwtService rather than asserting on decoded claims alone.
  it('the inviteToken invite() mints round-trips through verifyInviteToken()', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.marketingUser.create as jest.Mock).mockResolvedValue({ id: 'u-new' });
    (prisma.workspaceMembership.create as jest.Mock).mockResolvedValue({ id: 'mem-roundtrip' });

    const { inviteToken } = await svc.invite(WS, ACTOR, { email: 'rt@x.co', role: 'REP' });

    await expect(svc.verifyInviteToken(inviteToken!)).resolves.toBe('mem-roundtrip');
  });
});

// Task 13 review fix (Fix 2) — the seat cap used to be enforced ONLY by
// MarketingUsersService.create()'s own wrapper, leaving this route (the
// controller's POST /marketing/users/invite calls this method directly)
// completely unbounded. invite() must now enforce it itself, under the same
// per-workspace advisory lock create() used to take.
describe('MembershipService.invite — seat cap (Fix 2)', () => {
  it('rejects an invite when the workspace is already at its seat cap', async () => {
    const { prisma, svc } = makeSvc(5);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(5); // at cap
    await expect(
      svc.invite(WS, ACTOR, { email: 'over-cap@x.co', role: 'REP' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
  });

  it('counts INVITED memberships toward the cap, not just ACTIVE', async () => {
    const { prisma, svc } = makeSvc(2);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(2); // e.g. 1 ACTIVE + 1 INVITED
    await expect(
      svc.invite(WS, ACTOR, { email: 'over-cap@x.co', role: 'REP' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspaceMembership.count).toHaveBeenCalledWith({
      where: { workspaceId: WS, role: { not: 'SYSTEM' }, status: { in: ['ACTIVE', 'INVITED'] } },
    });
  });

  it('allows the invite when a seat is free, under the per-workspace advisory lock', async () => {
    const { prisma, svc } = makeSvc(5);
    (prisma.workspaceMembership.count as jest.Mock).mockResolvedValue(4); // room for one more
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue({ id: 'u-existing' });
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null); // no dup
    (prisma.workspaceMembership.create as jest.Mock).mockResolvedValue({ id: 'mem-ok' });

    const out = await svc.invite(WS, ACTOR, { email: 'room@x.co', role: 'REP' });

    expect(out).toEqual({ membershipId: 'mem-ok', status: 'INVITED' });
    const lockSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(lockSql).toContain('users:ws-1');
  });

  it('skips the count/lock entirely on an unlimited (-1) plan', async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.marketingUser.findUnique as jest.Mock).mockResolvedValue({ id: 'u-existing' });
    (prisma.workspaceMembership.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workspaceMembership.create as jest.Mock).mockResolvedValue({ id: 'mem-unlimited' });

    await svc.invite(WS, ACTOR, { email: 'unlimited@x.co', role: 'REP' });

    expect(prisma.workspaceMembership.count).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
