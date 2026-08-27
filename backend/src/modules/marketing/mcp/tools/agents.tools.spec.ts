import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAgentTools } from './agents.tools';

/**
 * The agent surface was absent from the catalogue entirely, which only became
 * a correctness problem once the strategy auto-provisioned agents and channels
 * could attach them: a live agent answering from a superseded brief could not
 * be corrected from the same surface that created it.
 */
function deps(features: Record<string, boolean> = { conversationAi: true }) {
  const registry = new McpToolRegistry();
  const agents = {
    list: jest.fn().mockResolvedValue([
      {
        id: 'a1', name: 'Figurunica Asistanı', status: 'ACTIVE', tone: 'samimi',
        goals: 'randevu', language: 'tr', persona: 'x'.repeat(900), channels: ['c1'],
      },
    ]),
    update: jest.fn().mockResolvedValue({ id: 'a1', name: 'Yeni' }),
  };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features }) };
  registerAgentTools(registry, { agents, entitlements } as never);
  return { registry, agents, entitlements };
}

const ctx = { workspaceId: 'ws1', grantedScopes: ['reports.read', 'settings.manage'] } as never;

describe('jeeta.list_agents', () => {
  it('returns the roster and truncates the persona so it cannot dominate the reply', async () => {
    const { registry, agents } = deps();
    const res = (await registry.get('jeeta.list_agents')!.handler(ctx, {})) as Array<Record<string, unknown>>;

    expect(agents.list).toHaveBeenCalledWith('ws1');
    expect(res[0]).toMatchObject({ id: 'a1', name: 'Figurunica Asistanı', status: 'ACTIVE', channels: ['c1'] });
    expect((res[0].personaPreview as string).length).toBe(400);
  });

  it('is deferred (occasional work) but present in the catalogue', () => {
    const { registry } = deps();
    expect(registry.get('jeeta.list_agents')!.defer).toBe(true);
  });

  it('refuses when the package excludes conversationAi', async () => {
    const { registry } = deps({ conversationAi: false });
    await expect(registry.get('jeeta.list_agents')!.handler(ctx, {})).rejects.toThrow();
  });
});

describe('jeeta.update_agent', () => {
  it('forwards ONLY the supplied fields — never blanks what was not passed', async () => {
    const { registry, agents } = deps();

    await registry.get('jeeta.update_agent')!.handler(ctx, {
      agentId: 'a1',
      persona: 'Doğru ürün: DIY boya kiti',
      tone: undefined,
      goals: undefined,
    });

    expect(agents.update).toHaveBeenCalledWith('ws1', 'a1', { persona: 'Doğru ürün: DIY boya kiti' });
  });

  it('never forwards agentId as a data field', async () => {
    const { registry, agents } = deps();
    await registry.get('jeeta.update_agent')!.handler(ctx, { agentId: 'a1', name: 'Yeni' });
    expect(agents.update).toHaveBeenCalledWith('ws1', 'a1', { name: 'Yeni' });
  });

  it('is a WRITE that needs no approval — configuration, nothing sent', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.update_agent')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toContain('settings.manage');
  });
});

/**
 * The fields that decide whether the AI ever answers.
 *
 * handoffRules.keywords is checked in reply() BEFORE the model runs: any match
 * escalates to a human and returns. One over-broad word — "fiyat" on a brand
 * whose agent is told to quote prices — silently turns every relevant
 * conversation into an escalation.
 *
 * That field was WRITE-ONLY. update_agent and the DTO could set it; the single
 * place that read it was the reply engine. Not the panel, not the catalogue,
 * nowhere a human could look. Same for guardrails, capture fields, the
 * follow-up policy, the daily cap and the attached knowledge docs.
 */
describe('jeeta.get_agent', () => {
  const deps = () => ({
    agents: { list: jest.fn(), get: jest.fn().mockResolvedValue({ id: 'a1' }) } as never,
    entitlements: { getEffective: jest.fn().mockResolvedValue({ features: { conversationAi: true } }) } as never,
  });

  it('is a deferred READ gated on reports.read', () => {
    const registry = new McpToolRegistry();
    registerAgentTools(registry, deps());
    const tool = registry.get('jeeta.get_agent')!;

    expect(tool.risk).toBe('READ');
    expect(tool.defer).toBe(true);
    expect(tool.scopes).toEqual(['reports.read']);
    expect(registry.listAdvertised(['reports.read']).map((t) => t.name)).not.toContain(
      'jeeta.get_agent',
    );
  });

  it('reads the one agent asked for, scoped to the caller workspace', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    registerAgentTools(registry, d);

    await registry
      .get('jeeta.get_agent')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, { agentId: 'a1' });

    expect((d as unknown as { agents: { get: jest.Mock } }).agents.get).toHaveBeenCalledWith(
      'ws1',
      'a1',
    );
  });

  it('does not trim the profile the way list_agents does', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    (d as unknown as { agents: { get: jest.Mock } }).agents.get.mockResolvedValue({
      id: 'a1',
      handoffRules: { keywords: ['insan'] },
      guardrails: 'never invent a price',
      maxRepliesPerConvoDaily: 30,
    });
    registerAgentTools(registry, d);

    const out = (await registry
      .get('jeeta.get_agent')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, {
        agentId: 'a1',
      })) as Record<string, unknown>;

    // The whole point: these are the fields list_agents drops.
    expect(out.handoffRules).toEqual({ keywords: ['insan'] });
    expect(out.guardrails).toBe('never invent a price');
    expect(out.maxRepliesPerConvoDaily).toBe(30);
  });
});
