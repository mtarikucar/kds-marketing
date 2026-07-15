import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * thread() must return the most RECENT window of a long conversation, in
 * chronological order. A thread with more than the 500-row cap previously
 * fetched the OLDEST 500 (orderBy createdAt asc + take 500), which hid the
 * latest customer message — an agent would then reply having never seen it.
 * The fix fetches desc (newest first) and reverses back to oldest→newest.
 */
describe('ConversationsService.thread — recent window, chronological order', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new ConversationsService(prisma as any, {} as any, { push: jest.fn() } as any);
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'c1',
      workspaceId: WS,
      leadId: 'l1',
      channelId: 'ch1',
    } as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'l1' } as any);
    prisma.channel.findFirst.mockResolvedValue({ id: 'ch1' } as any);
  });

  it('queries the most-recent 500 (desc) and returns them oldest→newest', async () => {
    // Prisma returns them newest-first (the desc order we ask for).
    prisma.message.findMany.mockResolvedValue([
      { id: 'm3', createdAt: new Date('2026-01-03') },
      { id: 'm2', createdAt: new Date('2026-01-02') },
      { id: 'm1', createdAt: new Date('2026-01-01') },
    ] as any);

    const res = await svc.thread(WS, 'c1');

    // We must ask for the newest rows, capped at 500 — not the oldest.
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, conversationId: 'c1' },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    );
    // …and the thread renders oldest→newest, so the latest message is last.
    expect(res.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});
