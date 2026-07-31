import { BadRequestException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerConversationWriteTools } from './conversations-write.tools';

const ctx = { workspaceId: 'ws1', grantedScopes: ['contacts.write'] };

function deps() {
  const conversations = {
    assign: jest.fn().mockResolvedValue({ id: 'cv1' }),
    close: jest.fn().mockResolvedValue({ id: 'cv1', status: 'CLOSED' }),
    reopen: jest.fn().mockResolvedValue({ id: 'cv1', status: 'OPEN' }),
    addNote: jest.fn().mockResolvedValue({ id: 'note1' }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { conversationAi: true } }) };
  const registry = new McpToolRegistry();
  registerConversationWriteTools(registry, {
    conversations: conversations as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, conversations, principals };
}

describe('jeeta.assign_conversation', () => {
  it('validates the assignee is an active member before assigning', async () => {
    const { registry, conversations, principals } = deps();
    await registry.get('jeeta.assign_conversation')!.handler(ctx, { conversationId: 'cv1', assignedToId: 'u2' });
    expect(principals.assertActiveMember).toHaveBeenCalledWith('ws1', 'u2');
    expect(conversations.assign).toHaveBeenCalledWith('ws1', 'cv1', 'u2');
  });

  /**
   * `ConversationsService.assign` only checks workspace membership — it would
   * happily park a thread on the automation principal, which can never log in,
   * so nobody would ever see it. `assertActiveMember` is the same guard
   * `jeeta.assign_lead` uses.
   */
  it('refuses an assignee the principal guard rejects, without touching the service', async () => {
    const { registry, conversations, principals } = deps();
    principals.assertActiveMember.mockRejectedValue(new BadRequestException('automation principal'));
    await expect(
      registry.get('jeeta.assign_conversation')!.handler(ctx, { conversationId: 'cv1', assignedToId: 'sys-1' }),
    ).rejects.toThrow(/automation principal/);
    expect(conversations.assign).not.toHaveBeenCalled();
  });

  it('unassigns with null when no user id is given (and skips the member check)', async () => {
    const { registry, conversations, principals } = deps();
    await registry.get('jeeta.assign_conversation')!.handler(ctx, { conversationId: 'cv1' });
    expect(principals.assertActiveMember).not.toHaveBeenCalled();
    expect(conversations.assign).toHaveBeenCalledWith('ws1', 'cv1', null);
  });
});

describe('jeeta.close_conversation', () => {
  it('closes by default', async () => {
    const { registry, conversations } = deps();
    await registry.get('jeeta.close_conversation')!.handler(ctx, { conversationId: 'cv1' });
    expect(conversations.close).toHaveBeenCalledWith('ws1', 'cv1');
    expect(conversations.reopen).not.toHaveBeenCalled();
  });

  it('reopens when asked', async () => {
    const { registry, conversations } = deps();
    await registry.get('jeeta.close_conversation')!.handler(ctx, { conversationId: 'cv1', reopen: true });
    expect(conversations.reopen).toHaveBeenCalledWith('ws1', 'cv1');
    expect(conversations.close).not.toHaveBeenCalled();
  });
});

describe('jeeta.add_conversation_note', () => {
  it('attributes the note to a resolved principal, never a fabricated id', async () => {
    const { registry, conversations, principals } = deps();
    await registry.get('jeeta.add_conversation_note')!.handler(ctx, { conversationId: 'cv1', body: 'chased by phone' });
    expect(principals.resolve).toHaveBeenCalled();
    expect(conversations.addNote).toHaveBeenCalledWith('ws1', 'cv1', 'sys-1', 'chased by phone');
  });
});

describe('inbox management risk classification', () => {
  /**
   * None of these reaches a customer, so none of them queues an approval —
   * otherwise triage would flood the queue that exists to make real sends
   * visible. The customer-facing verb in this domain is `jeeta.send_message`,
   * and that one IS gated.
   */
  it('leaves internal triage unattended', () => {
    const { registry } = deps();
    for (const name of ['jeeta.assign_conversation', 'jeeta.close_conversation', 'jeeta.add_conversation_note']) {
      const tool = registry.get(name)!;
      expect(tool.risk).toBe('WRITE');
      expect(tool.requiresApproval).toBe(false);
      expect(tool.domain).toBe('inbox');
    }
  });

  /**
   * The `Conversation` model has no tags column and the service has no tagging
   * method, so a `jeeta.tag_conversation` could only have invented a store no
   * panel reads or quietly retagged the underlying LEAD. Notes are the real
   * mechanism; this pins the substitution as deliberate.
   */
  it('registers no tag_conversation, because conversations have no tags', () => {
    const { registry } = deps();
    expect(registry.has('jeeta.tag_conversation')).toBe(false);
    expect(registry.has('jeeta.add_conversation_note')).toBe(true);
  });
});
