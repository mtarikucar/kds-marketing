import 'reflect-metadata';
import { MarketingApprovalsController } from './marketing-approvals.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

/**
 * Task 3 (mcp-write-surface-activation) — POST /marketing/approvals/:id/apply.
 * Mirrors MarketingBudgetController.applyReallocation: the workspace comes
 * ONLY from the authenticated caller (never the body/query), and the route
 * is refused without settings.manage — asserted the same way
 * marketing-users.controller.spec.ts pins REQUIRE_PERMISSION_KEY directly
 * off the prototype (no DI, no HTTP harness).
 */
function makeController(overrides: { mcpExecutor?: any } = {}) {
  const approvals = {} as any;
  const runs = {} as any;
  const mcpExecutor = overrides.mcpExecutor ?? { apply: jest.fn() };
  return new MarketingApprovalsController(approvals, runs, mcpExecutor);
}

describe('MarketingApprovalsController.apply', () => {
  it('forwards the caller workspace + user id (never a body/query value) to the executor', async () => {
    const mcpExecutor = { apply: jest.fn().mockResolvedValue({ status: 'APPLIED', result: { ok: true } }) };
    const ctrl = makeController({ mcpExecutor });
    const user = { id: 'user-9', workspaceId: 'ws-1' } as any;

    const out = await ctrl.apply(user, 'appr-1');

    expect(mcpExecutor.apply).toHaveBeenCalledWith('ws-1', 'appr-1', 'user-9');
    expect(out).toEqual({ status: 'APPLIED', result: { ok: true } });
  });

  it('is guarded on settings.manage, matching approve()/reject()/applyReallocation()', () => {
    const handler = MarketingApprovalsController.prototype.apply;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('settings.manage');
  });
});
