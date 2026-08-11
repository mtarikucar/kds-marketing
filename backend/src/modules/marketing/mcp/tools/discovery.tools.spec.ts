import { z } from 'zod';
import { McpTool, McpToolRegistry } from '../mcp-tool-registry';
import { registerDiscoveryTools } from './discovery.tools';

function tool(overrides: Partial<McpTool>): McpTool {
  return {
    name: 'jeeta.x',
    description: 'a tool',
    domain: 'leads',
    scopes: [],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async () => null,
    ...overrides,
  };
}

function deps() {
  const registry = new McpToolRegistry();
  // Stands in for McpBrokerService.invoke. Captured so the call_tool tests can
  // prove WHAT was dispatched — the target's name and args, unchanged.
  const dispatch = jest.fn(async () => ({ status: 'OK' as const, result: { ok: true } }));
  registry.register(
    tool({
      name: 'jeeta.click_to_dial',
      domain: 'voice',
      defer: true,
      scopes: ['leads.write'],
      requiresApproval: true,
      description: 'Place an outbound phone call to a lead.',
      inputSchema: z.object({ leadId: z.string().min(1).describe('Lead to call.') }),
    }),
  );
  registry.register(
    tool({ name: 'jeeta.search_leads', description: 'Search leads.', scopes: ['leads.read'] }),
  );
  registry.register(
    tool({ name: 'jeeta.secret_ads', domain: 'ads', description: 'Ad spend.', scopes: ['settings.manage'] }),
  );
  registerDiscoveryTools(registry, { registry, dispatch });
  return { registry, dispatch };
}

const call = (registry: McpToolRegistry, scopes: string[], args: Record<string, unknown> = {}) =>
  registry.get('jeeta.find_tools')!.handler({ workspaceId: 'ws1', grantedScopes: scopes }, args) as Promise<{
    total: number;
    returned: number;
    tools: Array<{ name: string; listed: boolean; inputSchema?: unknown; requiresApproval: boolean }>;
  }>;

describe('jeeta.find_tools', () => {
  it('finds a DEFERRED tool and hands back a schema the model can call it with', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.write', 'leads.read'], { query: 'phone call' });
    const found = out.tools.find((t) => t.name === 'jeeta.click_to_dial')!;
    expect(found).toBeDefined();
    expect(found.listed).toBe(false);
    expect(found.requiresApproval).toBe(true);
    expect(found.inputSchema).toMatchObject({
      type: 'object',
      properties: { leadId: { type: 'string' } },
    });
  });

  it('matches on domain, not just wording', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.write'], { query: 'voice' });
    expect(out.tools.map((t) => t.name)).toEqual(['jeeta.click_to_dial']);
  });

  it('filters to one domain when asked', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.write', 'leads.read'], { domain: 'leads' });
    expect(out.tools.map((t) => t.name)).toEqual(['jeeta.search_leads']);
  });

  /**
   * Discovery must never become a privilege-escalation oracle: it can only
   * reveal tools the caller already holds every scope for, exactly as
   * `tools/list` does.
   */
  it('never reveals a tool the caller lacks the scope for', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.read'], { query: 'ad spend phone' });
    expect(out.tools.map((t) => t.name)).not.toContain('jeeta.secret_ads');
    expect(out.tools.map((t) => t.name)).not.toContain('jeeta.click_to_dial');
  });

  it('lists everything the caller can reach when no query is given', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.read', 'leads.write']);
    expect(out.tools.map((t) => t.name).sort()).toEqual(
      ['jeeta.call_tool', 'jeeta.click_to_dial', 'jeeta.find_tools', 'jeeta.search_leads'].sort(),
    );
  });

  it('caps results and reports the true total so a model knows to narrow down', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.read', 'leads.write'], { limit: 1 });
    expect(out.returned).toBe(1);
    expect(out.total).toBe(4);
    expect(out.tools).toHaveLength(1);
  });

  it('requires no scopes and is never deferred — it is the way back to everything else', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.find_tools')!;
    expect(tool.scopes).toEqual([]);
    expect(tool.defer).toBeUndefined();
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
  });
});

/**
 * `jeeta.call_tool` — the half of progressive disclosure that makes the other
 * half true. `find_tools` promises a deferred tool "is never unavailable to
 * you", but an MCP client can only call names it saw in `tools/list`, so the
 * deferred surface was unreachable in practice until this existed.
 */
describe('jeeta.call_tool', () => {
  const ctx = { workspaceId: 'ws1', grantedScopes: ['leads.write'] } as never;
  const invoke = (registry: McpToolRegistry, args: Record<string, unknown>) =>
    registry.get('jeeta.call_tool')!.handler(ctx, args);

  it('is advertised — a dispatcher nobody can see is no dispatcher at all', () => {
    const { registry } = deps();
    expect(registry.listAdvertised(['leads.write']).map((t) => t.name)).toContain('jeeta.call_tool');
  });

  it('forwards the target name and args verbatim to the broker', async () => {
    const { registry, dispatch } = deps();
    await invoke(registry, { name: 'jeeta.call_lead', input: { leadId: 'l1' } });

    expect(dispatch).toHaveBeenCalledWith(ctx, 'jeeta.call_lead', { leadId: 'l1' });
  });

  it('dispatches with the SAME context, so scopes and audit are the callerimeter own', async () => {
    const { registry, dispatch } = deps();
    await invoke(registry, { name: 'jeeta.search_leads' });

    // The broker resolves every gate from the target tool against THIS ctx —
    // passing a synthesized or widened context here would be the bypass this
    // tool must never become.
    expect(dispatch.mock.calls[0][0]).toBe(ctx);
    expect(dispatch.mock.calls[0][2]).toEqual({});
  });

  it('reports a pending approval as NOT applied, instead of a bare success', async () => {
    const { registry, dispatch } = deps();
    dispatch.mockResolvedValue({ status: 'PENDING_APPROVAL' as const, approvalId: 'ap1' } as never);

    const res = (await invoke(registry, { name: 'jeeta.call_lead', input: { leadId: 'l1' } })) as {
      applied: boolean;
      status: string;
      approvalId: string;
      message: string;
    };

    // The inner PENDING_APPROVAL is a VALUE here, not the transport status the
    // server factory inspects; returned bare it would read as "done".
    expect(res.applied).toBe(false);
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(res.approvalId).toBe('ap1');
    expect(res.message).toMatch(/NOT been applied/i);
  });

  it('refuses to invoke itself', async () => {
    const { registry, dispatch } = deps();
    await expect(invoke(registry, { name: 'jeeta.call_tool' })).rejects.toThrow(/cannot invoke itself/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('needs no scopes of its own — the target is what gets gated', () => {
    const { registry } = deps();
    expect(registry.get('jeeta.call_tool')!.scopes).toEqual([]);
    // A caller holding nothing still sees the door; the broker refuses the room.
    expect(registry.listAdvertised([]).map((t) => t.name)).toContain('jeeta.call_tool');
  });
});
