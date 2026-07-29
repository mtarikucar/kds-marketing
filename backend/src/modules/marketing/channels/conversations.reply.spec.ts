import { NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * `reply()` (human agent) and `replyAsAi()` (Claude via MCP) share an
 * extracted `sendTakeoverReply` helper. This guards the two things that
 * extraction could silently break:
 *   1. Author attribution — `replyAsAi` must NEVER be misattributed as an
 *      'AGENT' with a fabricated id, and `reply` must keep sending the real
 *      caller's `agentUserId` (the pre-existing human-UI path — a
 *      no-regression guarantee).
 *   2. The takeover side-effect — both paths must still pause the AI
 *      (`aiPaused: true`) and clear `unreadCount` on the conversation.
 *   3. Workspace scoping — both paths resolve the conversation scoped to the
 *      caller's workspaceId and refuse (NotFoundException, no send) a
 *      conversation belonging to another workspace.
 */
describe('ConversationsService — reply / replyAsAi author attribution', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let sender: { send: jest.Mock };
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    sender = { send: jest.fn().mockResolvedValue({ id: 'm1' }) };
    svc = new ConversationsService(prisma as any, sender as any, { push: jest.fn() } as any);
  });

  describe('found conversation (happy path)', () => {
    beforeEach(() => {
      prisma.conversation.findFirst.mockResolvedValue({ id: 'c1' } as any);
      prisma.conversation.update.mockResolvedValue({ id: 'c1' } as any);
    });

    it('replyAsAi sends authorType AI with a null authorId — never a fabricated human id', async () => {
      await svc.replyAsAi(WS, 'c1', 'hello from claude');
      expect(sender.send).toHaveBeenCalledWith({
        workspaceId: WS,
        conversationId: 'c1',
        text: 'hello from claude',
        authorType: 'AI',
        authorId: null,
      });
    });

    it('reply sends authorType AGENT with the caller-supplied agentUserId (no regression)', async () => {
      await svc.reply(WS, 'c1', 'hello from a human', 'agent-42');
      expect(sender.send).toHaveBeenCalledWith({
        workspaceId: WS,
        conversationId: 'c1',
        text: 'hello from a human',
        authorType: 'AGENT',
        authorId: 'agent-42',
      });
    });

    it('replyAsAi still performs the takeover update (aiPaused + unreadCount reset)', async () => {
      await svc.replyAsAi(WS, 'c1', 'hi');
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { aiPaused: true, unreadCount: 0 },
      });
    });

    it('reply still performs the takeover update (aiPaused + unreadCount reset)', async () => {
      await svc.reply(WS, 'c1', 'hi', 'agent-42');
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { aiPaused: true, unreadCount: 0 },
      });
    });

    it('both paths scope the lookup to the caller workspaceId', async () => {
      await svc.replyAsAi(WS, 'c1', 'hi');
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', workspaceId: WS },
        select: { id: true },
      });

      prisma.conversation.findFirst.mockClear();
      await svc.reply(WS, 'c1', 'hi', 'agent-42');
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', workspaceId: WS },
        select: { id: true },
      });
    });
  });

  describe('conversation not in this workspace', () => {
    beforeEach(() => {
      // Scoped findFirst (id + workspaceId) finds nothing — the conversation
      // either doesn't exist or belongs to a different workspace.
      prisma.conversation.findFirst.mockResolvedValue(null as any);
    });

    it('replyAsAi throws NotFoundException and never sends or updates', async () => {
      await expect(svc.replyAsAi(WS, 'c1', 'hi')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('reply throws NotFoundException and never sends or updates', async () => {
      await expect(svc.reply(WS, 'c1', 'hi', 'agent-42')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
