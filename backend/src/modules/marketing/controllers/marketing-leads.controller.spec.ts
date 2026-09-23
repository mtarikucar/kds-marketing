import { MarketingLeadsController } from './marketing-leads.controller';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

/**
 * The email-suppression endpoint's guard chain and its delegation.
 *
 * The gate is the thing worth pinning. `ComplianceController` is class-level
 * `@MarketingRoles('MANAGER')` + `@RequirePermission('settings.manage')` on the
 * consent POST, and this route writes the SAME ledger through the same service
 * — so it carries the same two. Handing a REP the write (while still letting
 * them SEE the chips) is the split this package is built on: a rep must know
 * why their send will fail, and must not be the one who erases a recorded
 * consent decision.
 */
describe('MarketingLeadsController — email suppression', () => {
  function makeController(leads: Partial<Record<string, jest.Mock>> = {}) {
    return new MarketingLeadsController(
      leads as any,
      {} as any, // tags
      {} as any, // dedupe
      {} as any, // leadBulk
      {} as any, // leadStream
    );
  }

  it('is MANAGER + settings.manage, exactly like the consent POST it writes through', () => {
    const handler = MarketingLeadsController.prototype.emailSuppression;
    expect(Reflect.getMetadata(MARKETING_ROLES_KEY, handler)).toEqual(['MANAGER']);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('settings.manage');
  });

  it('delegates to the service with the caller workspace, the lead, the action and the actor', async () => {
    const setEmailSuppression = jest
      .fn()
      .mockResolvedValue({ emailOptOut: true, suppressed: true, reason: 'OPT_OUT' });
    const ctrl = makeController({ setEmailSuppression });
    const actor = { id: 'u-7', workspaceId: 'ws-1' } as any;

    const out = await ctrl.emailSuppression('lead-1', { action: 'OPT_OUT' } as any, actor);

    expect(setEmailSuppression).toHaveBeenCalledWith('ws-1', 'lead-1', 'OPT_OUT', 'u-7');
    expect(out).toMatchObject({ emailOptOut: true, reason: 'OPT_OUT' });
  });
});
