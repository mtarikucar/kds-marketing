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
  registerDiscoveryTools(registry, { registry });
  return { registry };
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
      ['jeeta.click_to_dial', 'jeeta.find_tools', 'jeeta.search_leads'].sort(),
    );
  });

  it('caps results and reports the true total so a model knows to narrow down', async () => {
    const { registry } = deps();
    const out = await call(registry, ['leads.read', 'leads.write'], { limit: 1 });
    expect(out.returned).toBe(1);
    expect(out.total).toBe(3);
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
