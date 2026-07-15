import 'reflect-metadata';
import { MarketingUsersController } from './marketing-users.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

/**
 * F2 (multi-workspace membership follow-up) — align the invite permission.
 * POST /marketing/users (create) delegates straight to the SAME
 * MembershipService.invite() that POST /marketing/users/invite gates at
 * users.manage (OWNER-level); create() used to sit on the looser
 * settings.manage (MANAGER-able), so a MANAGER could bypass the OWNER-only
 * invite bar entirely by hitting /users instead of /users/invite. Both
 * invite routes must require the SAME permission. update()/delete() stay on
 * settings.manage — managing EXISTING members is still MANAGER-level; only
 * ADDING one is owner-level.
 *
 * Reads the @RequirePermission metadata directly off the prototype (mirrors
 * public-write-throttle.arch.spec.ts's Reflect.getMetadata pattern) — no DI,
 * no mocking, just pins the decorator.
 */
function requiredPermission(method: string): unknown {
  return Reflect.getMetadata(
    REQUIRE_PERMISSION_KEY,
    (MarketingUsersController.prototype as Record<string, unknown>)[method] as object,
  );
}

describe('MarketingUsersController — invite permission parity (F2)', () => {
  it('create() now requires users.manage, matching invite()', () => {
    expect(requiredPermission('create')).toBe('users.manage');
    expect(requiredPermission('invite')).toBe('users.manage');
  });

  it('update()/delete() stay at settings.manage — managing EXISTING members is still MANAGER-level', () => {
    expect(requiredPermission('update')).toBe('settings.manage');
    expect(requiredPermission('delete')).toBe('settings.manage');
  });
});
