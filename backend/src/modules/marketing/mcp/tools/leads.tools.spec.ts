import { McpToolRegistry } from '../mcp-tool-registry';
import { registerLeadsTools, MCP_SERVICE_PRINCIPAL } from './leads.tools';

describe('leads MCP tools', () => {
  it('registers jeeta.search_leads as READ/leads.read', () => {
    const registry = new McpToolRegistry();
    registerLeadsTools(registry, { leads: { findAll: jest.fn() } as any });
    const tool = registry.get('jeeta.search_leads')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['leads.read']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('uses the declared service principal when the context carries no user', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry
      .get('jeeta.search_leads')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'] }, { search: 'ali' });
    expect(findAll).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ search: 'ali' }),
      MCP_SERVICE_PRINCIPAL.userId,
      MCP_SERVICE_PRINCIPAL.role,
    );
  });

  it('prefers a real user id from the context when present', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry
      .get('jeeta.search_leads')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'], userId: 'u9' }, {});
    expect(findAll).toHaveBeenCalledWith('ws1', expect.anything(), 'u9', MCP_SERVICE_PRINCIPAL.role);
  });
});
