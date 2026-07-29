import { McpToolRegistry } from '../mcp-tool-registry';
import { registerLeadsTools, MCP_NON_REP_PRINCIPAL } from './leads.tools';

describe('leads MCP tools', () => {
  it('registers jeeta.search_leads as READ/leads.read', () => {
    const registry = new McpToolRegistry();
    registerLeadsTools(registry, { leads: { findAll: jest.fn() } as any });
    const tool = registry.get('jeeta.search_leads')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['leads.read']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('uses the declared non-REP placeholder principal when the context carries no user', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry
      .get('jeeta.search_leads')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'] }, { search: 'ali' });
    expect(findAll).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ search: 'ali' }),
      MCP_NON_REP_PRINCIPAL.userId,
      MCP_NON_REP_PRINCIPAL.role,
    );
  });

  it('prefers a real user id from the context when present', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry
      .get('jeeta.search_leads')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'], userId: 'u9' }, {});
    expect(findAll).toHaveBeenCalledWith('ws1', expect.anything(), 'u9', MCP_NON_REP_PRINCIPAL.role);
  });

  /**
   * Faz 3 Task 8 — the carried-forward debt. An OAuth session IS user-bound,
   * so row-level visibility must be the caller's own, not a placeholder that
   * behaves like a manager. A REP connecting Claude to their workspace must
   * see exactly the leads they see in the UI: their own.
   */
  it('applies the REAL caller and their role on an OAuth session (REP sees only their own leads)', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry.get('jeeta.search_leads')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['leads.read'], userId: 'u9', userRole: 'REP' },
      {},
    );
    expect(findAll).toHaveBeenCalledWith('ws1', expect.anything(), 'u9', 'REP');
    // The placeholder must be nowhere near a user-bound call.
    expect(findAll).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MCP_NON_REP_PRINCIPAL.userId,
      expect.anything(),
    );
  });

  it('keeps the explicit service principal on an API-key session (regression)', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    // Exactly what McpInvokerService builds for an `mk_live_…` key: a
    // workspace credential with no user and therefore no role.
    await registry
      .get('jeeta.search_leads')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'] }, {});
    expect(findAll).toHaveBeenCalledWith(
      'ws1',
      expect.anything(),
      MCP_NON_REP_PRINCIPAL.userId,
      MCP_NON_REP_PRINCIPAL.role,
    );
  });
});
