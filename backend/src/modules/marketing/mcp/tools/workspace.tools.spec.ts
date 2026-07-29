import { McpToolRegistry } from '../mcp-tool-registry';
import { registerWorkspaceTools } from './workspace.tools';

const deps = () => ({
  entitlements: { getEffective: jest.fn() } as any,
});

describe('workspace MCP tools', () => {
  it('registers jeeta.get_workspace_info as an ungated READ needing reports.read', () => {
    const registry = new McpToolRegistry();
    registerWorkspaceTools(registry, deps());
    const tool = registry.get('jeeta.get_workspace_info')!;
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['reports.read']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('forwards the context workspace to EntitlementsService.getEffective', async () => {
    const registry = new McpToolRegistry();
    const getEffective = jest.fn().mockResolvedValue({ workspaceId: 'ws1', packageCode: 'SCALE' });
    registerWorkspaceTools(registry, { entitlements: { getEffective } as any });
    const out = await registry
      .get('jeeta.get_workspace_info')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {});
    expect(getEffective).toHaveBeenCalledWith('ws1');
    expect(out).toEqual({ workspaceId: 'ws1', packageCode: 'SCALE' });
  });

  it('is hidden from a caller lacking reports.read', () => {
    const registry = new McpToolRegistry();
    registerWorkspaceTools(registry, deps());
    expect(registry.list(['leads.read']).map((t) => t.name)).not.toContain('jeeta.get_workspace_info');
  });
});
