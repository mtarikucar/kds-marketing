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
