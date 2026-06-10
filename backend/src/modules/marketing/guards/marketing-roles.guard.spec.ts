import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MarketingRolesGuard } from './marketing-roles.guard';

function ctxWithUser(role?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ marketingUser: role ? { role } : undefined }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('MarketingRolesGuard — hierarchical workspace roles', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: MarketingRolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new MarketingRolesGuard(reflector as unknown as Reflector);
  });

  it('passes when no roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctxWithUser('REP'))).toBe(true);
  });

  it("admits OWNER wherever MANAGER is required (hierarchy, not membership)", () => {
    reflector.getAllAndOverride.mockReturnValue(['MANAGER']);
    expect(guard.canActivate(ctxWithUser('OWNER'))).toBe(true);
    expect(guard.canActivate(ctxWithUser('MANAGER'))).toBe(true);
  });

  it('rejects REP from MANAGER-gated routes', () => {
    reflector.getAllAndOverride.mockReturnValue(['MANAGER']);
    expect(() => guard.canActivate(ctxWithUser('REP'))).toThrow(ForbiddenException);
  });

  it('admits everyone above REP on REP-gated routes', () => {
    reflector.getAllAndOverride.mockReturnValue(['REP']);
    for (const role of ['REP', 'MANAGER', 'OWNER']) {
      expect(guard.canActivate(ctxWithUser(role))).toBe(true);
    }
  });

  it('SYSTEM never passes any role gate — not even REP', () => {
    reflector.getAllAndOverride.mockReturnValue(['REP']);
    expect(() => guard.canActivate(ctxWithUser('SYSTEM'))).toThrow(ForbiddenException);
  });

  it('unknown roles rank as zero and are rejected', () => {
    reflector.getAllAndOverride.mockReturnValue(['REP']);
    expect(() => guard.canActivate(ctxWithUser('INTERN'))).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached', () => {
    reflector.getAllAndOverride.mockReturnValue(['MANAGER']);
    expect(() => guard.canActivate(ctxWithUser(undefined))).toThrow(ForbiddenException);
  });
});
