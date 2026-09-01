import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { SocialPlannerController } from './social-planner.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';

/**
 * The route-layer half of the exclusive-pull contract: POST
 * /social-planner/insights/pull answers 409 when a pull is already in flight.
 *
 * That fact was asserted at both ends and nowhere in the middle. The service
 * spec proves pullNow throws ConflictException when the advisory lock is held;
 * AccountStatsPanel's spec proves the refresh button treats a 409 as "already
 * happening" and shows an info toast rather than the red failure state. Between
 * them sits this handler, and it is the piece a refactor touches: one
 * well-meant try/catch here — "the refresh should never blow up in the user's
 * face" — turns the 409 into a cheerful 200 reporting zero accounts, both
 * existing specs stay green, and the button starts telling managers we looked
 * and found nothing every time the hourly sweep happens to hold the lock. That
 * is a different and false fact, which is the whole reason pullNow throws
 * instead of returning zeros.
 *
 * Instantiated directly with doubles, the way marketing-approvals /
 * marketing-users pin their routes: no DI container, no HTTP harness, and the
 * decorators read straight off the prototype.
 */
function makeController(insights: { pullNow: jest.Mock }) {
  return new SocialPlannerController({} as any, insights as any);
}

describe('SocialPlannerController — POST insights/pull', () => {
  const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

  it('pulls the CALLER’s workspace and returns the service counts unchanged', async () => {
    const pullNow = jest.fn().mockResolvedValue({ posts: 3, accounts: 1, errors: 0, processed: 1 });

    const out = await makeController({ pullNow }).pullInsights(user);

    // The workspace comes only from the authenticated payload — there is no
    // body or query on this route to take it from, and there must not be one.
    expect(pullNow).toHaveBeenCalledWith('ws-1');
    expect(out).toEqual({ posts: 3, accounts: 1, errors: 0, processed: 1 });
  });

  it('lets a ConflictException through as a 409 instead of swallowing or remapping it', async () => {
    const pullNow = jest
      .fn()
      .mockRejectedValue(new ConflictException('A statistics refresh is already running for this workspace'));
    const ctrl = makeController({ pullNow });

    const err = await ctrl.pullInsights(user).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
  });

  it('spends provider quota, so it is MANAGER + settings.manage — not the reports.read the summary uses', () => {
    const pull = SocialPlannerController.prototype.pullInsights;
    // settings.manage rather than reports.read: this route burns the
    // workspace's rate limit against every connected network, which is a
    // different act from reading what a previous sweep already stored.
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, pull)).toBe('settings.manage');
    // Re-stated on the handler even though the class already carries it, so
    // narrowing the class-level role later cannot silently widen this one.
    expect(Reflect.getMetadata(MARKETING_ROLES_KEY, pull)).toEqual(['MANAGER']);
  });
});
