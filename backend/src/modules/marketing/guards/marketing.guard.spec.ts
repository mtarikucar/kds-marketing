import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { MarketingGuard } from './marketing.guard';

/**
 * Workspace-isolation contract of the auth guard: the `wsp` claim must match
 * the user row's CURRENT workspace, SYSTEM sentinels can never authenticate,
 * and tokenVersion still revokes sessions.
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
    tokenVersion: 3,
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

  it('accepts a valid token whose wsp matches the user row and attaches workspaceId', async () => {
    jwt.verifyAsync.mockResolvedValue(payload());
    prisma.marketingUser.findUnique.mockResolvedValue({ ...USER });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.marketingUser).toMatchObject({
      id: USER.id,
      workspaceId: 'ws-1',
      role: 'REP',
    });
    expect(request.marketingUser.tokenVersion).toBeUndefined();
  });

  it('rejects when the wsp claim does not match the user row (workspace move)', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ wsp: 'ws-OLD' }));
    prisma.marketingUser.findUnique.mockResolvedValue({ ...USER });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects SYSTEM sentinels outright', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ role: 'SYSTEM' }));
    prisma.marketingUser.findUnique.mockResolvedValue({ ...USER, role: 'SYSTEM' });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });

  it('still honors tokenVersion revocation', async () => {
    jwt.verifyAsync.mockResolvedValue(payload({ ver: 2 }));
    prisma.marketingUser.findUnique.mockResolvedValue({ ...USER });

    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });
});
