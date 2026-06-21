import { NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

const WS = 'ws-1';

function makePrisma() {
  return {
    conversation: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    conversationNote: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
    },
    marketingUser: { findFirst: jest.fn() },
  };
}

describe('ConversationsService — notes + bulk', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let stream: { push: jest.Mock };
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = makePrisma();
    stream = { push: jest.fn() };
    svc = new ConversationsService(prisma as any, {} as any, stream as any);
  });

  describe('addNote', () => {
    it('404s a conversation in another workspace (no note written)', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);
      await expect(svc.addNote(WS, 'c1', 'me', 'hi')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversationNote.create).not.toHaveBeenCalled();
    });

    it('writes to conversation_notes (NOT messages) and streams it', async () => {
      prisma.conversation.findFirst.mockResolvedValue({ id: 'c1' });
      await svc.addNote(WS, 'c1', 'me', 'internal only');
      const arg = prisma.conversationNote.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({ workspaceId: WS, conversationId: 'c1', authorId: 'me', body: 'internal only' });
      expect(stream.push).toHaveBeenCalledWith(WS, expect.objectContaining({ kind: 'note', conversationId: 'c1' }));
    });
  });

  describe('bulk', () => {
    it('close updates scoped rows with CLOSED + closedAt', async () => {
      prisma.conversation.updateMany.mockResolvedValue({ count: 3 });
      const res = await svc.bulk(WS, ['a', 'b', 'c'], 'close');
      expect(res).toEqual({ updated: 3 });
      const arg = prisma.conversation.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: { in: ['a', 'b', 'c'] }, workspaceId: WS });
      expect(arg.data.status).toBe('CLOSED');
      expect(arg.data.closedAt).toBeInstanceOf(Date);
    });

    it('assign validates the assignee belongs to the workspace', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue(null);
      await expect(svc.bulk(WS, ['a'], 'assign', { assignedToId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it('assign with a valid user sets assignedToId', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue({ id: 'u2' });
      prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
      await svc.bulk(WS, ['a'], 'assign', { assignedToId: 'u2' });
      expect(prisma.conversation.updateMany.mock.calls[0][0].data).toEqual({ assignedToId: 'u2' });
    });

    it('empty id set is a no-op', async () => {
      const res = await svc.bulk(WS, [], 'close');
      expect(res).toEqual({ updated: 0 });
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });
  });
});
