import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { RolesService } from './roles.service';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Epic F — the PermissionsGuard is the live enforcement point for granular
 * permissions. These tests pin its two non-negotiable behaviours:
 *  1. legacy OWNER/MANAGER keep working via the legacy-role fallback (no
 *     customRoleId → LEGACY_ROLE_PERMISSIONS[role]); and
 *  2. a custom role that omits the required permission is rejected with 403.
 * It also confirms the guard is a no-op on handlers without @RequirePermission.
 */
function ctxFor(marketingUser: any): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ marketingUser }) }),
  } as unknown as ExecutionContext;
}

function guardWith(requiredPermission: string | undefined) {
  const prisma = mockPrismaClient();
  const roles = new RolesService(prisma as any);
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredPermission),
  } as unknown as Reflector;
  return { guard: new PermissionsGuard(reflector, roles), prisma, reflector };
}

describe('PermissionsGuard — live granular permission enforcement', () => {
  it('passes through handlers without @RequirePermission (purely additive)', async () => {
    const { guard, reflector } = guardWith(undefined);
    await expect(guard.canActivate(ctxFor({ role: 'REP' }))).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      REQUIRE_PERMISSION_KEY,
      expect.any(Array),
    );
  });

  it('allows a legacy MANAGER through the legacy-role fallback (no customRoleId)', async () => {
    const { guard } = guardWith('settings.manage');
    // MANAGER holds settings.manage in LEGACY_ROLE_PERMISSIONS — must pass so
    // existing role-management users/tests keep working.
    await expect(
      guard.canActivate(ctxFor({ role: 'MANAGER', customRoleId: null })),
    ).resolves.toBe(true);
  });

  it('allows a legacy OWNER (superset of all permissions)', async () => {
    const { guard } = guardWith('settings.manage');
    await expect(
      guard.canActivate(ctxFor({ role: 'OWNER', customRoleId: null })),
    ).resolves.toBe(true);
  });

  it('rejects a custom role that lacks the required permission with 403', async () => {
    const { guard, prisma } = guardWith('settings.manage');
    // A custom role whose permission set omits settings.manage — even though
    // the user's legacy role is MANAGER, the custom role OVERRIDES it.
    prisma.customRole.findUnique.mockResolvedValue({
      id: 'role-1',
      permissions: ['leads.read', 'reports.read'],
    } as any);
    await expect(
      guard.canActivate(ctxFor({ role: 'MANAGER', customRoleId: 'role-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a custom role that explicitly grants the required permission', async () => {
    const { guard, prisma } = guardWith('settings.manage');
    prisma.customRole.findUnique.mockResolvedValue({
      id: 'role-2',
      permissions: ['settings.manage', 'leads.read'],
    } as any);
    await expect(
      guard.canActivate(ctxFor({ role: 'REP', customRoleId: 'role-2' })),
    ).resolves.toBe(true);
  });

  it('rejects an unauthenticated request (no marketingUser)', async () => {
    const { guard } = guardWith('settings.manage');
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
