import { Reflector } from '@nestjs/core';
import { MarketingAiController } from './marketing-ai.controller';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

/**
 * Both spend views must stay MANAGER-only.
 *
 * They answer "what does this cost us", which is the operator's number, not a
 * rep's. The guards are decorators, so losing one is a deletion that compiles,
 * passes every other test, and quietly widens who can read the bill — the same
 * shape as every other failure found on this codebase this week, except the
 * blast radius here is a permission rather than a number.
 *
 * `usage` (the credit quota) is deliberately NOT in this list: it is the
 * allowance a rep is working against, and gating it would break the panel.
 */
describe('marketing AI controller — spend endpoints stay manager-only', () => {
  const reflector = new Reflector();

  for (const handler of ['usageBreakdown', 'vendorSpendReport'] as const) {
    it(`${handler} requires MANAGER and reports.read`, () => {
      const fn = MarketingAiController.prototype[handler];

      expect(reflector.get<string[]>(MARKETING_ROLES_KEY, fn)).toEqual(['MANAGER']);
      expect(reflector.get<string>(REQUIRE_PERMISSION_KEY, fn)).toBe('reports.read');
    });
  }

  it('leaves the credit-quota read open to everyone who can see the panel', () => {
    const fn = MarketingAiController.prototype.usage;
    expect(reflector.get<string[]>(MARKETING_ROLES_KEY, fn)).toBeUndefined();
  });
});
