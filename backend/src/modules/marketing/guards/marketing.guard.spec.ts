import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { MarketingGuard } from './marketing.guard';

/**
 * Workspace-isolation contract of the auth guard: the `wsp` claim must resolve
 * to an ACTIVE WorkspaceMembership row for that (user, workspace) pair — the
 * membership, not the user row's home workspace/role, is the source of truth.
 * SYSTEM sentinels can never authenticate, and tokenVersion still revokes
 * sessions.
 */
describe('MarketingGuard — workspace claim + sentinel checks', () => {
  const USER = {
    id: 'u-1',
    workspaceId: 'ws-1',
    email: 'rep@x.test',
    firstName: 'R',
    lastName: 'One',
    role: 'REP',
    status: 'ACTIVE',
    customRoleId: null,
    tokenVersion: 3,
  };

  const MEMBERSHIP = {
    workspaceId: 'ws-1',
    role: 'REP',
    customRoleId: null,
    status: 'ACTIVE',
  };

  let reflector: { getAllAndOverride: jest.Mock };
  let jwt: { verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let prisma: { marketingUser: { findUnique: jest.Mock } };
  let guard: MarketingGuard;
  let request: any;

  function ctx(): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    jwt = { verifyAsync: jest.fn() };
    config = { get: jest.fn().mockReturnValue('secret') };
    prisma = { marketingUser: { findUnique: jest.fn() } };
    guard = new MarketingGuard(
      reflector as any,
      jwt as any,
      config as any,
      prisma as any,
    );
    request = { headers: { authorization: 'Bearer token' } };
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      sub: USER.id,
      email: USER.email,
      role: USER.role,
      wsp: USER.workspaceId,
      ver: USER.tokenVersion,
      type: 'marketing',
      ...overrides,
    };
  }

  it('accepts a valid token with an ACTIVE membership for wsp and attaches workspaceId', async () => {
    jwt.verifyAsync.mockResolvedValue(payload());
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      memberships: [MEMBERSHIP],
    });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.marketingUser).toMatchObject({
      id: USER.id,
      workspaceId: 'ws-1',
      role: 'REP',
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

  it('rejects SYSTEM sentinels outright', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ role: 'SYSTEM' }));
    prisma.marketingUser.findUnique.mockResolvedValue({
      ...USER,
      role: 'SYSTEM',
      memberships: [],
    });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
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
});

/**
 * Multi-workspace membership resolution (Phase 1 Task 3): the guard must
 * resolve role/customRoleId from the ACTIVE WorkspaceMembership for the
 * token's active workspace (`payload.wsp`), never from the user row's home
 * workspace/role — and must deny the request when no such membership exists.
 */
describe('MarketingGuard — active-membership role resolution', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let jwt: { verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let prisma: { marketingUser: { findUnique: jest.Mock } };
  let guard: MarketingGuard;

  function ctxWithAuthHeader(header: string): ExecutionContext {
    const req: any = { headers: { authorization: header } };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    jwt = { verifyAsync: jest.fn() };
    config = { get: jest.fn().mockReturnValue('secret') };
    prisma = { marketingUser: { findUnique: jest.fn() } };
    guard = new MarketingGuard(
      reflector as any,
      jwt as any,
      config as any,
      prisma as any,
    );
  });

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

  it('populates customRoleId from the ACTIVE membership, never from the user row', async () => {
    // user row customRoleId = 'row-cr' (home workspace's assignment), but the
    // active membership for wsp-2 carries a DIFFERENT custom role. A guard
    // that reads `marketingUser.customRoleId` instead of `membership.customRoleId`
    // would silently leak the row's permission grant into this workspace.
    prisma.marketingUser.findUnique.mockResolvedValue({
      id: 'u1', workspaceId: 'wsp-home', email: 'a@b.co', firstName: 'A', lastName: 'B',
      role: 'OWNER', status: 'ACTIVE', customRoleId: 'row-cr', tokenVersion: 0,
      memberships: [{ workspaceId: 'wsp-2', role: 'REP', customRoleId: 'mem-cr', status: 'ACTIVE' }],
    });
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', wsp: 'wsp-2', ver: 0, type: 'marketing' });
    const ctx = ctxWithAuthHeader('Bearer t');
    await guard.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    expect(req.marketingUser.customRoleId).toBe('mem-cr');
  });

  it('fails closed (401 Session revoked) when payload.wsp is empty/undefined, before any membership lookup', async () => {
    // Guards against a Prisma footgun: this schema does not enable
    // strictUndefinedChecks, so an `undefined` value in a `where` filter is
    // silently DROPPED rather than rejected. If `payload.wsp` were undefined
    // and this check did not run first, `memberships: { where: { workspaceId:
    // undefined, status: 'ACTIVE' }, take: 1 } }` would degrade to matching
    // the user's first ACTIVE membership in ANY workspace — a fail-open bug.
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', ver: 0, type: 'marketing' }); // no `wsp`
    await expect(guard.canActivate(ctxWithAuthHeader('Bearer t'))).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctxWithAuthHeader('Bearer t'))).rejects.toThrow('Session revoked');
    expect(prisma.marketingUser.findUnique).not.toHaveBeenCalled();
  });
});
