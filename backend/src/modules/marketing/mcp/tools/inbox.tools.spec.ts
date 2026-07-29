import { McpToolRegistry } from '../mcp-tool-registry';
import { registerInboxTools } from './inbox.tools';

const deps = () => ({ conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi: jest.fn() } as any });

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
    registerInboxTools(registry, { conversations: { list, thread: jest.fn(), replyAsAi: jest.fn() } as any });
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
    registerInboxTools(registry, { conversations: { list: jest.fn(), thread, replyAsAi: jest.fn() } as any });
    const out = await registry
      .get('jeeta.read_conversation')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['contacts.read'] }, { conversationId: 'c1' });
    expect(thread).toHaveBeenCalledWith('ws1', 'c1');
    expect(out).toEqual({ conversation: { id: 'c1' }, messages: [] });
  });

  it('jeeta.send_message sends via replyAsAi, never a synthetic human identity', async () => {
    const registry = new McpToolRegistry();
    const replyAsAi = jest.fn().mockResolvedValue({ id: 'm1' });
    registerInboxTools(registry, { conversations: { list: jest.fn(), thread: jest.fn(), replyAsAi } as any });
    const out = await registry
      .get('jeeta.send_message')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['contacts.write'] }, { conversationId: 'c1', body: 'hi there' });
    expect(replyAsAi).toHaveBeenCalledWith('ws1', 'c1', 'hi there');
    expect(out).toEqual({ id: 'm1' });
  });
});
