import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAdsTools } from './ads.tools';

const deps = () => ({
  accounts: { getMetrics: jest.fn() } as any,
  budgets: { get: jest.fn(), list: jest.fn() } as any,
  ads: { setDailyBudget: jest.fn() } as any,
});

describe('ads MCP tools', () => {
  it('registers the read tools ungated', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    expect(registry.get('jeeta.get_ad_performance')!.requiresApproval).toBe(false);
    expect(registry.get('jeeta.get_budget')!.scopes).toEqual(['reports.read']);
  });

  it('gates jeeta.reallocate_budget as SPEND behind BUDGET_REALLOCATION', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    const tool = registry.get('jeeta.reallocate_budget')!;
    expect(tool.risk).toBe('SPEND');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('BUDGET_REALLOCATION');
    expect(tool.scopes).toEqual(['settings.manage']);
  });

  it('forwards the context workspace to AdAccountService.getMetrics', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    registerAdsTools(registry, d);
    await registry.get('jeeta.get_ad_performance')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'] },
      { from: '2026-07-01', to: '2026-07-28' },
    );
    expect(d.accounts.getMetrics).toHaveBeenCalledWith('ws1', '2026-07-01', '2026-07-28', undefined);
  });

  it('jeeta.get_budget lists when no budgetId is given, gets when one is', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    d.budgets.list.mockResolvedValue([{ id: 'b1' }]);
    d.budgets.get.mockResolvedValue({ id: 'b1' });
    registerAdsTools(registry, d);
    const tool = registry.get('jeeta.get_budget')!;

    await tool.handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {});
    expect(d.budgets.list).toHaveBeenCalledWith('ws1');

    await tool.handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, { budgetId: 'b1' });
    expect(d.budgets.get).toHaveBeenCalledWith('ws1', 'b1');
  });

  it('jeeta.reallocate_budget forwards (adAccountId, entityId, dailyBudgetMajor) to setDailyBudget', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    d.ads.setDailyBudget.mockResolvedValue({ id: 'ent1', dailyBudget: 75 });
    registerAdsTools(registry, d);
    const out = await registry
      .get('jeeta.reallocate_budget')!
      .handler(
        { workspaceId: 'ws1', grantedScopes: ['settings.manage'] },
        { adAccountId: 'acc1', entityId: 'ent1', dailyBudgetMajor: 75 },
      );
    expect(d.ads.setDailyBudget).toHaveBeenCalledWith('ws1', 'acc1', 'ent1', 75);
    expect(out).toEqual({ id: 'ent1', dailyBudget: 75 });
  });

  it('hides reallocate_budget from a caller without settings.manage', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    expect(registry.list(['reports.read']).map((t) => t.name)).not.toContain('jeeta.reallocate_budget');
  });
});
