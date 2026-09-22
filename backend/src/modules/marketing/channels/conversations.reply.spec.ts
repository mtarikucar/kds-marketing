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

    // A reply from outside the engine is a takeover AND a resolution: the
    // decline that said "the AI did not respond" is answered by the fact that
    // somebody just did. Leaving it standing is how that banner outlives the
    // problem it reported, and the rep stops believing any of them.
    const TAKEOVER = {
      aiPaused: true,
      unreadCount: 0,
      aiLastDeclineReason: null,
      aiLastDeclineAt: null,
    };

    it('replyAsAi still performs the takeover update (aiPaused + unreadCount reset)', async () => {
      await svc.replyAsAi(WS, 'c1', 'hi');
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: TAKEOVER,
      });
    });

    it('reply still performs the takeover update (aiPaused + unreadCount reset)', async () => {
      await svc.reply(WS, 'c1', 'hi', 'agent-42');
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: TAKEOVER,
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

describe('ConversationsService — the "AI did not respond" banner clears with its cause', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c1', leadId: 'lead-1' } as any);
    prisma.conversation.update.mockResolvedValue({ id: 'c1' } as any);
    svc = new ConversationsService(prisma as any, { send: jest.fn() } as any, { push: jest.fn() } as any);
  });

  const written = () => prisma.conversation.update.mock.calls[0][0].data as any;

  it('clears it when a human explicitly resumes the AI', async () => {
    // Resuming is "try again". Whatever it declined for last time is no
    // longer what the banner should be saying.
    await svc.setAiPaused(WS, 'c1', false);
    expect(written()).toMatchObject({
      aiPaused: false,
      aiLastDeclineReason: null,
      aiLastDeclineAt: null,
    });
  });

  it('leaves it standing when a human PAUSES the AI', async () => {
    // That reason is still why the AI stopped, and the rep may be reading it.
    await svc.setAiPaused(WS, 'c1', true);
    expect(written()).toEqual({ aiPaused: true });
  });
});
