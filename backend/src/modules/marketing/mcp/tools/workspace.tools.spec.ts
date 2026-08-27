import { McpToolRegistry } from '../mcp-tool-registry';
import { registerWorkspaceTools } from './workspace.tools';

const deps = () => ({
  entitlements: { getEffective: jest.fn() } as any,
  users: { findAll: jest.fn().mockResolvedValue([]) } as any,
  jobs: { list: jest.fn().mockResolvedValue([]), listCronHeartbeats: jest.fn().mockResolvedValue({ registered: [], recorded: [] }) } as any,
  email: { verifyTransport: jest.fn().mockResolvedValue({ ok: true, configured: true }) } as any,
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

  /**
   * The last layer nothing could see.
   *
   * Everything recurring in this product passes through one advisory-lock
   * helper, and none of it recorded that it had run — so a cron that silently
   * stopped firing looked exactly like a cron with nothing to do. Platform-level
   * by nature: a schedule belongs to the deployment, not to a workspace.
   */
  describe('jeeta.list_scheduled_runs', () => {
    it('is a deferred READ gated on reports.read', () => {
      const registry = new McpToolRegistry();
      registerWorkspaceTools(registry, deps());
      const tool = registry.get('jeeta.list_scheduled_runs')!;
      expect(tool.risk).toBe('READ');
      expect(tool.defer).toBe(true);
      expect(tool.scopes).toEqual(['reports.read']);
      expect(registry.listAdvertised(['reports.read']).map((t) => t.name)).not.toContain(
        'jeeta.list_scheduled_runs',
      );
    });

    it('strips the failure text, which is platform-wide and may name another tenant', async () => {
      const registry = new McpToolRegistry();
      const d = deps();
      d.jobs.listCronHeartbeats = jest.fn().mockResolvedValue({
        registered: [],
        recorded: [
          {
            jobName: 'daily-digest',
            lastRunAt: new Date('2026-08-27T07:00:00Z'),
            lastOkAt: new Date('2026-08-26T07:00:00Z'),
            lastError: 'undelivered: ws-other → owner@other-tenant.com: 535',
            runs: 24,
            failures: 2,
          },
        ],
      });
      registerWorkspaceTools(registry, d);

      const out = (await registry
        .get('jeeta.list_scheduled_runs')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {})) as {
        recorded: Array<Record<string, unknown>>;
      };

      const row = out.recorded[0];
      // A single tenant must not read another tenant's data out of a
      // deployment-level row through a READ tool that needs no approval.
      expect(JSON.stringify(out)).not.toContain('other-tenant.com');
      expect(row.lastError).toBeUndefined();
      // What the tool exists to answer still answers.
      expect(row.failing).toBe(true);
      expect(row.jobName).toBe('daily-digest');
      expect(row.failures).toBe(2);
    });

    it('reads the platform schedules, which take no workspace', async () => {
      const registry = new McpToolRegistry();
      const d = deps();
      registerWorkspaceTools(registry, d);

      await registry
        .get('jeeta.list_scheduled_runs')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {});

      expect(d.jobs.listCronHeartbeats).toHaveBeenCalledWith();
    });
  });

  /**
   * "Can we send email at all?"
   *
   * The transporter is verified once at boot and the answer goes to the logger,
   * so it exists for a moment and is then unreachable. That left one way to
   * find out: wait for something to try to send. Live, that meant waiting for
   * the 07:00 brief — which failed, and which by its nature could not announce
   * its own failure by email.
   */
  describe('jeeta.verify_email_transport', () => {
    it('is a deferred READ that sends nothing', () => {
      const registry = new McpToolRegistry();
      registerWorkspaceTools(registry, deps());
      const tool = registry.get('jeeta.verify_email_transport')!;

      expect(tool.risk).toBe('READ');
      expect(tool.defer).toBe(true);
      expect(tool.requiresApproval).toBe(false);
    });

    it('reports the provider error rather than a bare false', async () => {
      const registry = new McpToolRegistry();
      const d = deps();
      (d.email as unknown as { verifyTransport: jest.Mock }).verifyTransport.mockResolvedValue({
        ok: false,
        configured: true,
        error: '535 5.7.8 Authentication credentials invalid',
      });
      registerWorkspaceTools(registry, d);

      const out = (await registry
        .get('jeeta.verify_email_transport')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {})) as Record<
        string,
        unknown
      >;

      // "configured: true, ok: false" is the distinction that matters — a setup
      // problem and a send problem need opposite fixes.
      expect(out).toEqual({
        ok: false,
        configured: true,
        error: '535 5.7.8 Authentication credentials invalid',
      });
    });
  });
});
