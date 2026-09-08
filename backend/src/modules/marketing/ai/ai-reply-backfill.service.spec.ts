import { AiReplyBackfillService } from './ai-reply-backfill.service';
import { AI_REPLY_KIND } from './ai-execution';
import { AI_REPLY_CLAIMED } from './ai-reply-lease.service';

/**
 * The gap that let a customer write twice and never be answered.
 *
 * `onInbound` queues a reply when a message ARRIVES. A conversation the
 * customer had already ended — before an agent was attached, or before the
 * workspace moved to a connector mode — waits for a message that will never
 * come, and is invisible to the lane forever. The product already reported it
 * ("N conversations awaiting a reply") and nothing acted on it.
 *
 * Every test below is about a BOUND, because the failure mode of a backfill is
 * not missing someone: it is answering someone it should have left alone.
 */
describe('AiReplyBackfillService', () => {
  function build(over: { convos?: any[]; channels?: any[]; inFlight?: any[] } = {}) {
    const prisma: any = {
      scheduledJob: { findMany: jest.fn().mockResolvedValue(over.inFlight ?? []) },
      channel: { findMany: jest.fn().mockResolvedValue(over.channels ?? [{ id: 'ch-1' }]) },
      conversation: {
        findMany: jest.fn().mockResolvedValue(over.convos ?? []),
        fields: { lastInboundAt: Symbol('lastInboundAt') },
      },
    };
    const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
    return { prisma, scheduledJobs, svc: new AiReplyBackfillService(prisma, scheduledJobs as any) };
  }

  const convo = (over: any = {}) => ({ id: 'convo-1', workspaceId: 'ws-1', ...over });

  it('enqueues a conversation that has been waiting', async () => {
    const { svc, scheduledJobs } = build({ convos: [convo()] });
    await expect(svc.sweep()).resolves.toEqual({ enqueued: 1 });
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        kind: AI_REPLY_KIND,
        dedupKey: 'convo-1',
      }),
    );
  });

  it('only takes threads where the CUSTOMER spoke last', async () => {
    // A thread we already replied to has lastMessageAt ahead of lastInboundAt
    // and is not waiting on us. Compared column-to-column rather than in
    // application code, so the database does the filtering.
    const { svc, prisma } = build({ convos: [convo()] });
    await svc.sweep();
    const where = prisma.conversation.findMany.mock.calls[0][0].where;
    expect(where.lastMessageAt).toEqual({ equals: prisma.conversation.fields.lastInboundAt });
    expect(where.status).toBe('OPEN');
  });

  it('leaves a conversation a human took over', async () => {
    // aiPaused means somebody is handling it. Taking it back is not a
    // backfill's decision to make.
    const { svc, prisma } = build({ convos: [convo()] });
    await svc.sweep();
    expect(prisma.conversation.findMany.mock.calls[0][0].where.aiPaused).toBe(false);
  });

  it('bounds how far back it will reach', async () => {
    // Without this, the first tick would enqueue every conversation that ever
    // ended with the customer speaking — answers that are now apologies.
    const { svc, prisma } = build({ convos: [convo()] });
    await svc.sweep();
    const since = prisma.conversation.findMany.mock.calls[0][0].where.lastInboundAt.gte;
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it('does nothing at all when no channel has an answering agent', async () => {
    // No agent is a deliberate choice that the channel stays manual. A
    // backfill must not quietly overrule it — and must not even ask.
    const { svc, prisma, scheduledJobs } = build({ channels: [], convos: [convo()] });
    await expect(svc.sweep()).resolves.toEqual({ enqueued: 0 });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('restricts to channels that actually answer', async () => {
    const { svc, prisma } = build({ channels: [{ id: 'ch-a' }, { id: 'ch-b' }], convos: [convo()] });
    await svc.sweep();
    expect(prisma.channel.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'ACTIVE',
      agentProfileId: { not: null },
    });
    expect(prisma.conversation.findMany.mock.calls[0][0].where.channelId).toEqual({
      in: ['ch-a', 'ch-b'],
    });
  });

  it('skips a conversation a connector is already holding', async () => {
    // `schedule` dedupes only against PENDING, so a CLAIMED job would not block
    // a second row — and the same person would be answered twice.
    const { svc, scheduledJobs } = build({
      convos: [convo()],
      inFlight: [{ payload: { conversationId: 'convo-1' } }],
    });
    await expect(svc.sweep()).resolves.toEqual({ enqueued: 0 });
    expect(scheduledJobs.schedule).not.toHaveBeenCalled();
  });

  it('looks at every non-terminal state, not just PENDING', async () => {
    const { svc, prisma } = build({ convos: [convo()] });
    await svc.sweep();
    expect(prisma.scheduledJob.findMany.mock.calls[0][0].where.status.in).toEqual(
      expect.arrayContaining(['PENDING', AI_REPLY_CLAIMED, 'RUNNING']),
    );
  });

  it('caps a workspace per tick, so a backlog drains instead of arriving at once', async () => {
    const many = Array.from({ length: 45 }, (_, i) => convo({ id: `c-${i}` }));
    const { svc } = build({ convos: many });
    await expect(svc.sweep()).resolves.toEqual({ enqueued: 20 });
  });

  it('caps PER WORKSPACE, so one busy tenant cannot starve another', async () => {
    const mine = Array.from({ length: 30 }, (_, i) => convo({ id: `a-${i}`, workspaceId: 'ws-a' }));
    const theirs = [convo({ id: 'b-1', workspaceId: 'ws-b' })];
    const { svc, scheduledJobs } = build({ convos: [...mine, ...theirs] });
    await svc.sweep();
    const workspaces = scheduledJobs.schedule.mock.calls.map((c: any[]) => c[0].workspaceId);
    expect(workspaces.filter((w: string) => w === 'ws-a')).toHaveLength(20);
    expect(workspaces.filter((w: string) => w === 'ws-b')).toHaveLength(1);
  });

  it('carries on when one enqueue is refused as a duplicate', async () => {
    // A duplicate is the dedup working. One noisy row must not abandon the rest
    // of the sweep.
    const { svc, scheduledJobs } = build({
      convos: [convo({ id: 'c-1' }), convo({ id: 'c-2' })],
    });
    scheduledJobs.schedule.mockRejectedValueOnce(new Error('duplicate'));
    await expect(svc.sweep()).resolves.toEqual({ enqueued: 1 });
  });

  it('takes the longest-waiting first', async () => {
    const { svc, prisma } = build({ convos: [convo()] });
    await svc.sweep();
    expect(prisma.conversation.findMany.mock.calls[0][0].orderBy).toEqual({ lastInboundAt: 'asc' });
  });
});
