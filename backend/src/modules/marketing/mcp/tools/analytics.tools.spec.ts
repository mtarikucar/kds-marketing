import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAnalyticsTools } from './analytics.tools';

describe('analytics MCP tools', () => {
  it('registers jeeta.get_funnel as a READ tool needing reports.read', () => {
    const registry = new McpToolRegistry();
    registerAnalyticsTools(registry, { analytics: { funnel: jest.fn() } as any });
    const tool = registry.get('jeeta.get_funnel');
    expect(tool).toBeDefined();
    expect(tool!.risk).toBe('READ');
    expect(tool!.requiresApproval).toBe(false);
    expect(tool!.scopes).toEqual(['reports.read']);
  });

  it('calls the analytics service with the context workspace', async () => {
    const registry = new McpToolRegistry();
    const funnel = jest.fn().mockResolvedValue({ stages: [] });
    registerAnalyticsTools(registry, { analytics: { funnel } as any });
    const tool = registry.get('jeeta.get_funnel')!;
    const out = await tool.handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, { from: '2026-07-01', to: '2026-07-28' });
    expect(funnel).toHaveBeenCalledWith('ws1', { from: '2026-07-01', to: '2026-07-28' });
    expect(out).toEqual({ stages: [] });
  });

  it('is hidden from a caller lacking reports.read', () => {
    const registry = new McpToolRegistry();
    registerAnalyticsTools(registry, { analytics: { funnel: jest.fn() } as any });
    expect(registry.list(['leads.read']).map((t) => t.name)).not.toContain('jeeta.get_funnel');
  });
});
