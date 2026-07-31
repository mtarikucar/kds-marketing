import { McpToolRegistry } from '../mcp-tool-registry';
import { registerInboxTools } from './inbox.tools';

const deps = () => ({
  conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi: jest.fn() } as any,
  entitlements: { getEffective: jest.fn(async () => ({ features: { conversationAi: true } })) } as any,
});

describe('inbox MCP tools', () => {
  it('registers the read tools without an approval gate', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    expect(registry.get('jeeta.list_conversations')!.requiresApproval).toBe(false);
    expect(registry.get('jeeta.list_conversations')!.scopes).toEqual(['contacts.read']);
    expect(registry.get('jeeta.read_conversation')!.requiresApproval).toBe(false);
    expect(registry.get('jeeta.read_conversation')!.scopes).toEqual(['contacts.read']);
  });

  it('every registered tool declares an inputSchema', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    for (const name of ['jeeta.list_conversations', 'jeeta.read_conversation', 'jeeta.send_message']) {
      expect(registry.get(name)!.inputSchema).toBeDefined();
    }
  });

  it('gates jeeta.send_message behind SEND approval', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    const tool = registry.get('jeeta.send_message')!;
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.risk).toBe('WRITE');
    expect(tool.scopes).toEqual(['contacts.write']);
  });

  it('hides send_message from a read-only caller', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    expect(registry.list(['contacts.read']).map((t) => t.name)).not.toContain('jeeta.send_message');
  });

  it('jeeta.list_conversations forwards filters to ConversationsService.list', async () => {
    const registry = new McpToolRegistry();
    const list = jest.fn().mockResolvedValue([{ id: 'c1' }]);
    registerInboxTools(registry, { ...deps(), conversations: { list, thread: jest.fn(), replyAsAi: jest.fn() } as any });
    const out = await registry
      .get('jeeta.list_conversations')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['contacts.read'] }, { status: 'OPEN', limit: 10 });
    expect(list).toHaveBeenCalledWith('ws1', {
      status: 'OPEN',
      channelId: undefined,
      assignedToId: undefined,
      limit: 10,
    });
    expect(out).toEqual([{ id: 'c1' }]);
  });

  it('jeeta.read_conversation calls ConversationsService.thread', async () => {
    const registry = new McpToolRegistry();
    const thread = jest.fn().mockResolvedValue({ conversation: { id: 'c1' }, messages: [] });
    registerInboxTools(registry, { ...deps(), conversations: { list: jest.fn(), thread, replyAsAi: jest.fn() } as any });
    const out = await registry
      .get('jeeta.read_conversation')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['contacts.read'] }, { conversationId: 'c1' });
    expect(thread).toHaveBeenCalledWith('ws1', 'c1');
    expect(out).toEqual({ conversation: { id: 'c1' }, messages: [] });
  });

  it('jeeta.send_message sends via replyAsAi, never a synthetic human identity', async () => {
    const registry = new McpToolRegistry();
    const replyAsAi = jest.fn().mockResolvedValue({ id: 'm1' });
    registerInboxTools(registry, { ...deps(), conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi } as any });
    const out = await registry
      .get('jeeta.send_message')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['contacts.write'] }, { conversationId: 'c1', body: 'hi there' });
    expect(replyAsAi).toHaveBeenCalledWith('ws1', 'c1', 'hi there');
    expect(out).toEqual({ id: 'm1' });
  });
});

/**
 * The gap D3 flagged and D5 closes.
 *
 * `MarketingConversationsController` puts `@RequiresFeature('conversationAi')`
 * on EVERY route — list, thread, reply, assign, close, notes. D3's
 * `conversations-write.tools.ts` (assign/close/note) makes that check; these
 * three, which shipped in Faz 1-2 before `assertFeature` existed, did not. The
 * result was a real bypass: a workspace whose package excludes the shared inbox
 * could still list conversations, read a customer's full message history and
 * SEND that customer a reply over MCP — the widest of the three, since it is
 * also the only one that reaches a human being.
 */
describe('inbox feature gate', () => {
  const unentitled = () => {
    const d = deps();
    d.entitlements.getEffective = jest.fn(async () => ({ features: {} }));
    const registry = new McpToolRegistry();
    registerInboxTools(registry, d);
    return { registry, d };
  };

  it.each([
    ['jeeta.list_conversations', {}],
    ['jeeta.read_conversation', { conversationId: 'c1' }],
    ['jeeta.send_message', { conversationId: 'c1', body: 'hi' }],
  ])('%s refuses cleanly without the conversationAi feature', async (name, args) => {
    const { registry, d } = unentitled();
    await expect(
      registry.get(name)!.handler({ workspaceId: 'ws1', grantedScopes: [] }, args),
    ).rejects.toMatchObject({
      response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'conversationAi' },
    });
    expect(d.conversations.list).not.toHaveBeenCalled();
    expect(d.conversations.thread).not.toHaveBeenCalled();
    expect(d.conversations.replyAsAi).not.toHaveBeenCalled();
  });

  it('checks the entitlement of the CALLER workspace, never one from the arguments', async () => {
    const { registry, d } = unentitled();
    await expect(
      registry
        .get('jeeta.read_conversation')!
        .handler({ workspaceId: 'ws1', grantedScopes: [] }, { conversationId: 'ws-other' }),
    ).rejects.toBeDefined();
    expect(d.entitlements.getEffective).toHaveBeenCalledWith('ws1');
  });
});
