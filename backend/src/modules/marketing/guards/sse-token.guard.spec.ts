import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { SseTokenGuard } from './sse-token.guard';

/**
 * Workspace-isolation contract of the SSE guard, mirroring MarketingGuard
 * (marketing.guard.spec.ts): the `wsp` claim must resolve to an ACTIVE
 * WorkspaceMembership row for that (user, workspace) pair — the membership,
 * not the user row's home workspace/role, is the source of truth. `dahili`
 * (the telephony extension) is IDENTITY-level and must always come from the
 * user row, never the membership.
 */
describe('SseTokenGuard — workspace claim + membership resolution', () => {
  const USER = {
    id: 'u-1',
    workspaceId: 'ws-home',
    email: 'rep@x.test',
    firstName: 'R',
    lastName: 'One',
    role: 'OWNER',
    status: 'ACTIVE',
    tokenVersion: 3,
    dahili: '101',
  };

  const MEMBERSHIP = {
    workspaceId: 'ws-2',
    role: 'REP',
    customRoleId: null,
    status: 'ACTIVE',
  };

  let jwt: { verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let prisma: { marketingUser: { findUnique: jest.Mock } };
  let guard: SseTokenGuard;
  let request: any;

  function ctx(): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn() };
    config = { get: jest.fn().mockReturnValue('secret') };
    prisma = { marketingUser: { findUnique: jest.fn() } };
    guard = new SseTokenGuard(jwt as any, config as any, prisma as any);
    request = { query: { access_token: 'token' }, headers: {} };
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      sub: USER.id,
      email: USER.email,
      role: USER.role,
      wsp: 'ws-2',
      ver: USER.tokenVersion,
      type: 'marketing',
      ...overrides,
    };
  }

  it('accepts a valid token with an ACTIVE membership for wsp, resolves role/workspaceId from it, and preserves dahili from the identity', async () => {
    jwt.verifyAsync.mockResolvedValue(payload());
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      memberships: [MEMBERSHIP],
    });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.marketingUser).toMatchObject({
      id: USER.id,
      workspaceId: 'ws-2',
      role: 'REP',
      dahili: '101',
    });
    expect(request.marketingUser.tokenVersion).toBeUndefined();
    expect(request.marketingUser.memberships).toBeUndefined();
  });

  it('rejects when there is no ACTIVE membership for the token wsp (workspace move / access revoked)', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ wsp: 'ws-OLD' }));
    // Simulates what the real filtered `include` would return: the Prisma
    // where-clause on the membership (workspaceId: 'ws-OLD', status: 'ACTIVE')
    // matches nothing, so `memberships` comes back empty.
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      memberships: [],
    });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx())).rejects.toThrow('Session revoked');
  });

  it('fails closed (401 Session revoked) when payload.wsp is empty/undefined, before any membership lookup', async () => {
    // Same Prisma footgun as MarketingGuard: strictUndefinedChecks is not
    // enabled, so an `undefined` where-value is silently dropped rather than
    // rejected. Without this guard, `memberships: { where: { workspaceId:
    // undefined, status: 'ACTIVE' }, take: 1 } }` would degrade to matching
    // the user's first ACTIVE membership in ANY workspace — a fail-open bug.
    jwt.verifyAsync.mockResolvedValue({ sub: 'u-1', ver: 0, type: 'marketing' }); // no `wsp`
    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx())).rejects.toThrow('Session revoked');
    expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
  });

  it('still honors tokenVersion revocation', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ ver: 2 }));
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      memberships: [MEMBERSHIP],
    });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx())).rejects.toThrow('Session revoked');
  });

  it('rejects SYSTEM sentinels outright', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ role: 'SYSTEM' }));
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      role: 'SYSTEM',
      memberships: [MEMBERSHIP],
    });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });
});
