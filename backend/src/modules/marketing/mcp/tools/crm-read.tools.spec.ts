import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCrmReadTools } from './crm-read.tools';

function setup() {
  const registry = new McpToolRegistry();
  const segments = { list: jest.fn().mockResolvedValue([]) };
  const tags = { list: jest.fn().mockResolvedValue([]) };
  registerCrmReadTools(registry, { segments, tags } as never);
  return { registry, segments, tags };
}

const KEY_CTX = { workspaceId: 'ws-a', grantedScopes: [] };

describe('CRM read-helper MCP tools', () => {
  it.each([
    ['jeeta.list_segments', ['contacts.read']],
    ['jeeta.list_tags', ['contacts.read']],
  ])('registers %s as READ with scopes %p and no approval gate', (name, scopes) => {
    const { registry } = setup();
    const tool = registry.get(name)!;
    expect(tool).toBeDefined();
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(scopes);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.inputSchema).toBeDefined();
  });

  it('lists only the caller workspace segments', async () => {
    const { registry, segments } = setup();
    await registry.get('jeeta.list_segments')!.handler(KEY_CTX, {});
    expect(segments.list).toHaveBeenCalledWith('ws-a');
    expect(segments.list).toHaveBeenCalledTimes(1);
  });

  it('lists only the caller workspace tags', async () => {
    const { registry, tags } = setup();
    await registry.get('jeeta.list_tags')!.handler(KEY_CTX, {});
    expect(tags.list).toHaveBeenCalledWith('ws-a');
  });

  it('takes no arguments — a stray argument is rejected, not silently dropped', () => {
    const { registry } = setup();
    for (const name of ['jeeta.list_segments', 'jeeta.list_tags']) {
      expect(() =>
        (registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown }).parse({ workspaceId: 'ws-b' }),
      ).toThrow();
    }
  });
});
