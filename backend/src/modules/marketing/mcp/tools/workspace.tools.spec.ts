import { McpToolRegistry } from '../mcp-tool-registry';
import { registerWorkspaceTools } from './workspace.tools';

const deps = () => ({
  entitlements: { getEffective: jest.fn() } as any,
  users: { findAll: jest.fn().mockResolvedValue([]) } as any,
  jobs: { list: jest.fn().mockResolvedValue([]) } as any,
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
    registerWorkspaceTools(registry, { ...deps(), entitlements: { getEffective } as any });
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

  /**
   * The queue reader. Its whole reason to exist is that `lastError` had no
   * reader — so the two things worth pinning are that it is scoped to the
   * caller's workspace (a job error can quote a customer message) and that it
   * stays deferred, because it was added to answer "why didn't this happen",
   * not to occupy a slot in the advertised surface.
   */
  describe('jeeta.list_background_jobs', () => {
    it('is a deferred READ gated on reports.read', () => {
      const registry = new McpToolRegistry();
      registerWorkspaceTools(registry, deps());
      const tool = registry.get('jeeta.list_background_jobs')!;
      expect(tool.risk).toBe('READ');
      expect(tool.requiresApproval).toBe(false);
      expect(tool.defer).toBe(true);
      expect(tool.scopes).toEqual(['reports.read']);
      expect(registry.listAdvertised(['reports.read']).map((t) => t.name)).not.toContain(
        'jeeta.list_background_jobs',
      );
    });

    it('scopes the read to the caller workspace and passes the filters through', async () => {
      const registry = new McpToolRegistry();
      const d = deps();
      registerWorkspaceTools(registry, d);
      await registry
        .get('jeeta.list_background_jobs')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {
          kind: 'conversation.ai_reply',
          status: 'FAILED',
          limit: 5,
        });
      expect(d.jobs.list).toHaveBeenCalledWith('ws1', {
        kind: 'conversation.ai_reply',
        status: 'FAILED',
        limit: 5,
      });
    });

    it('passes no filters when none were given, rather than inventing defaults', async () => {
      const registry = new McpToolRegistry();
      const d = deps();
      registerWorkspaceTools(registry, d);
      await registry
        .get('jeeta.list_background_jobs')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {});
      expect(d.jobs.list).toHaveBeenCalledWith('ws1', {
        kind: undefined,
        status: undefined,
        limit: undefined,
      });
    });
  });
});
