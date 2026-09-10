import { AiReplyLeaseService, AI_REPLY_CLAIMED, AI_REPLY_LEASE_MS } from './ai-reply-lease.service';
import { AI_REPLY_KIND } from './ai-execution';

/**
 * The drainer half of `aiExecution`.
 *
 * Without it, MCP_ONLY would mean "no customer is ever answered" — a queue with
 * no consumer. The mode and its drainer ship together, always, which is why
 * these tests are about the claim being ATOMIC and the lease being RECOVERABLE
 * rather than about the happy path.
 */
describe('AiReplyLeaseService', () => {
  const WS = 'ws-1';

  function build(rows: any[] = [], updateCounts: number[] = []) {
    let call = 0;
    const prisma: any = {
      scheduledJob: {
        findFirst: jest.fn(async () => rows[Math.min(call, rows.length - 1)] ?? null),
        updateMany: jest.fn(async () => ({ count: updateCounts[call++] ?? 1 })),
        count: jest.fn(async () => 0),
      },
      // complete() lifts the pause its own send left behind, guarded on the
      // last outbound being AI-authored. Default: the AI spoke last.
      message: { findFirst: jest.fn(async () => ({ authorType: 'AI' })) },
      conversation: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    // The follow-up half: completing a handled reply lines up the next nudge
    // the same way the platform's own reply() does. Doubled, because what these
    // tests assert is that the lane CALLS it — the policy itself is
    // ConversationFollowupService's own spec.
    const followups = {
      scheduleNext: jest.fn(async () => true),
      countFollowup: jest.fn(async () => undefined),
      cancelFor: jest.fn(async () => undefined),
      policyFor: jest.fn(() => null),
    };
    return { prisma, followups, svc: new AiReplyLeaseService(prisma, followups as any) };
  }

  const job = (over: any = {}) => ({
    id: 'job-1',
    payload: { conversationId: 'convo-1' },
    createdAt: new Date('2026-09-08T12:00:00Z'),
    ...over,
  });

  describe('claim', () => {
    it('leases the oldest queued reply', async () => {
      const { svc, prisma } = build([job()]);
      // findFirst is called twice: once by releaseExpired's sibling count path
      // is not used here, so the first is the queue read.
      prisma.scheduledJob.findFirst.mockResolvedValueOnce(job());
      const claimed = await svc.claim(WS);
      expect(claimed).toMatchObject({ jobId: 'job-1', conversationId: 'convo-1' });
    });

    it('takes them in queue order, not creation order', async () => {
      // A reply that has already waited must not lose its place to a newer one.
      const { svc, prisma } = build([job()]);
      await svc.claim(WS);
      const read = prisma.scheduledJob.findFirst.mock.calls.find(
        (c: any[]) => c[0]?.orderBy,
      );
      expect(read[0].orderBy).toEqual({ runAt: 'asc' });
    });

    it('claims ATOMICALLY, so two connectors polling at once cannot both win', async () => {
      // The filter is the whole mechanism: updateMany on id AND status PENDING
      // touches one row or zero.
      const { svc, prisma } = build([job()]);
      await svc.claim(WS);
      const claim = prisma.scheduledJob.updateMany.mock.calls.find(
        (c: any[]) => c[0]?.data?.status === AI_REPLY_CLAIMED,
      );
      expect(claim[0].where).toMatchObject({ id: 'job-1', workspaceId: WS, status: 'PENDING' });
    });

    it('tries the NEXT row when it loses the race, rather than reporting an empty queue', async () => {
      // Losing a race is normal. Saying "nothing queued" when there plainly is
      // would send a drainer away with work outstanding.
      const { prisma, svc } = build();
      prisma.scheduledJob.updateMany
        .mockResolvedValueOnce({ count: 0 }) // releaseExpired
        .mockResolvedValueOnce({ count: 0 }) // lost the first row
        .mockResolvedValueOnce({ count: 1 }); // won the second
      prisma.scheduledJob.findFirst
        .mockResolvedValueOnce(job({ id: 'job-a' }))
        .mockResolvedValueOnce(job({ id: 'job-b' }));
      const claimed = await svc.claim(WS);
      expect(claimed?.jobId).toBe('job-b');
    });

    it('excludes rows it has already tried, so a lost race cannot loop forever', async () => {
      // The mock HONOURS notIn, because a mock that ignored it would let this
      // pass on a service that looped over the same row forever — which is the
      // exact bug the exclusion exists to prevent.
      const { prisma, svc } = build();
      const queue = [job({ id: 'job-a' }), job({ id: 'job-b' })];
      prisma.scheduledJob.findFirst.mockImplementation(async (args: any) => {
        const skip: string[] = args?.where?.id?.notIn ?? [];
        return queue.find((r) => !skip.includes(r.id)) ?? null;
      });
      // Every claim attempt loses the race, so it must walk the queue and stop.
      prisma.scheduledJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.claim(WS)).resolves.toBeNull();
      const seen = prisma.scheduledJob.findFirst.mock.calls
        .map((c: any[]) => c[0]?.where?.id?.notIn ?? [])
        .pop();
      expect(seen).toEqual(['job-a', 'job-b']);
    });

    it('fails a row that carries no conversation instead of parking it CLAIMED forever', async () => {
      // A job nobody can act on must not sit pretending to be work in progress.
      const { prisma, svc } = build();
      prisma.scheduledJob.updateMany.mockResolvedValue({ count: 1 });
      prisma.scheduledJob.findFirst
        .mockResolvedValueOnce(job({ payload: {} }))
        .mockResolvedValue(null);
      const claimed = await svc.claim(WS);
      expect(claimed).toBeNull();
      const failed = prisma.scheduledJob.updateMany.mock.calls.find(
        (c: any[]) => c[0]?.data?.status === 'FAILED',
      );
      expect(failed[0].data.lastError).toMatch(/conversationId/);
    });

    it('returns null on an empty queue', async () => {
      const { prisma, svc } = build();
      prisma.scheduledJob.findFirst.mockResolvedValue(null);
      await expect(svc.claim(WS)).resolves.toBeNull();
    });
  });

  describe('releaseExpired', () => {
    it('only reclaims leases older than the window, and only this workspace', async () => {
      const { prisma, svc } = build();
      await svc.releaseExpired(WS);
      const where = prisma.scheduledJob.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, kind: AI_REPLY_KIND, status: AI_REPLY_CLAIMED });
      expect(Date.now() - where.lockedAt.lt.getTime()).toBeGreaterThanOrEqual(AI_REPLY_LEASE_MS - 50);
    });

    it('leaves runAt alone, so a reply that already waited keeps its place', async () => {
      const { prisma, svc } = build();
      await svc.releaseExpired(WS);
      const data = prisma.scheduledJob.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ status: 'PENDING', lockedAt: null });
      expect(data).not.toHaveProperty('runAt');
    });

    it('holds the lease SHORT, because what is waiting is a customer', async () => {
      expect(AI_REPLY_LEASE_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    });
  });

  describe('complete', () => {
    it('closes a reply the connector handled', async () => {
      const { prisma, svc } = build();
      await svc.complete(WS, 'job-1', true);
      const call = prisma.scheduledJob.updateMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ id: 'job-1', workspaceId: WS, status: AI_REPLY_CLAIMED });
      expect(call.data.status).toBe('DONE');
    });

    it('returns it to the queue when the connector declined to answer', async () => {
      // Better than holding the lease until it expires: the honest answer, and
      // the customer waits minutes less.
      const { prisma, svc } = build();
      await svc.complete(WS, 'job-1', false);
      expect(prisma.scheduledJob.updateMany.mock.calls[0][0].data).toEqual({
        status: 'PENDING',
        lockedAt: null,
      });
    });

    it('reports failure rather than pretending, when the job was not ours to close', async () => {
      const { prisma, svc } = build();
      prisma.scheduledJob.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.complete(WS, 'someone-elses', true)).resolves.toBe(false);
    });
  });

  describe('pending', () => {
    it('counts only what is still waiting, in this workspace', async () => {
      const { prisma, svc } = build();
      prisma.scheduledJob.count.mockResolvedValue(3);
      prisma.scheduledJob.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-08T02:00:00Z') });
      const out = await svc.pending(WS);
      expect(out).toEqual({ waiting: 3, oldestQueuedAt: new Date('2026-09-08T02:00:00Z') });
      expect(prisma.scheduledJob.count.mock.calls[0][0].where).toMatchObject({
        workspaceId: WS,
        kind: AI_REPLY_KIND,
        status: 'PENDING',
      });
    });

    it('reports an empty queue as empty, not as null', async () => {
      const { prisma, svc } = build();
      prisma.scheduledJob.count.mockResolvedValue(0);
      prisma.scheduledJob.findFirst.mockResolvedValue(null);
      await expect(svc.pending(WS)).resolves.toEqual({ waiting: 0, oldestQueuedAt: null });
    });
  });

  describe('complete — lifting the pause the lane itself caused', () => {
    it('un-pauses the conversation after the lane answers it', async () => {
      // Without this the lane answers each thread exactly ONCE and then goes
      // silent on it forever: ConversationsService.reply() — the path
      // jeeta.send_message takes — sets aiPaused on the way out, which is right
      // for a person typing in the panel and wrong for the connector, because
      // the connector IS the AI answering.
      const { prisma, svc } = build();
      prisma.scheduledJob.findFirst.mockResolvedValue({
        payload: { conversationId: 'convo-1' },
      });
      await svc.complete(WS, 'job-1', true);
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { id: 'convo-1', workspaceId: WS, aiPaused: true },
        data: { aiPaused: false },
      });
    });

    it('leaves the pause alone when a HUMAN spoke last', async () => {
      // Someone stepped in while the lease was held. That pause is theirs.
      const { prisma, svc } = build();
      prisma.scheduledJob.findFirst.mockResolvedValue({
        payload: { conversationId: 'convo-1' },
      });
      prisma.message.findFirst.mockResolvedValue({ authorType: 'AGENT' });
      await svc.complete(WS, 'job-1', true);
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });

    it('does not un-pause when the reply was handed BACK', async () => {
      const { prisma, svc } = build();
      prisma.scheduledJob.findFirst.mockResolvedValue({
        payload: { conversationId: 'convo-1' },
      });
      await svc.complete(WS, 'job-1', false);
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    });
  });
});

/**
 * The half of a sale that happens when nobody writes back.
 *
 * The connector lane answered customers and then went silent on them forever:
 * `scheduleFollowup` was reachable only from the END of the platform's own
 * reply(), which made chasing a quiet customer silently conditional on the
 * platform having been the one to answer. A workspace whose Claude answers
 * through the connector scheduled a nudge never, for any conversation.
 */
describe('AiReplyLeaseService — chasing a customer who went quiet', () => {
  const WS = 'ws-1';

  function build(payload: any) {
    const prisma: any = {
      scheduledJob: {
        findFirst: jest.fn(async () => ({ id: 'job-1', payload, createdAt: new Date() })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        count: jest.fn(async () => 0),
      },
      message: { findFirst: jest.fn(async () => ({ authorType: 'AI' })) },
      conversation: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const followups = {
      scheduleNext: jest.fn(async () => true),
      countFollowup: jest.fn(async () => undefined),
      cancelFor: jest.fn(async () => undefined),
      policyFor: jest.fn(() => null),
    };
    return { prisma, followups, svc: new AiReplyLeaseService(prisma, followups as any) };
  }

  it('lines up the next nudge when the connector answers a customer', async () => {
    const { svc, followups } = build({ conversationId: 'convo-1' });
    await svc.complete(WS, 'job-1', true);
    expect(followups.scheduleNext).toHaveBeenCalledWith(WS, 'convo-1');
  });

  it('COUNTS a nudge it sent, so the cap it is measured against actually moves', async () => {
    // The platform bumps followupCount after its own send. A nudge sent through
    // the connector that never counted would let the same customer be chased
    // forever, whatever their agent's maxFollowups says.
    const { svc, followups } = build({ conversationId: 'convo-1', reason: 'followup' });
    await svc.complete(WS, 'job-1', true);
    expect(followups.countFollowup).toHaveBeenCalledWith(WS, 'convo-1');
    expect(followups.countFollowup.mock.invocationCallOrder[0]).toBeLessThan(
      followups.scheduleNext.mock.invocationCallOrder[0],
    );
  });

  it('does not count an ordinary reply as a nudge', async () => {
    const { svc, followups } = build({ conversationId: 'convo-1', reason: 'inbound' });
    await svc.complete(WS, 'job-1', true);
    expect(followups.countFollowup).not.toHaveBeenCalled();
  });

  it('chases nobody when the connector handed the job BACK', async () => {
    // handled: false means "I did not write to this customer". Scheduling a
    // follow-up to a message that was never sent would chase a conversation
    // nothing has happened in.
    const { svc, followups } = build({ conversationId: 'convo-1' });
    await svc.complete(WS, 'job-1', false);
    expect(followups.scheduleNext).not.toHaveBeenCalled();
  });

  it('does not fail the completion when the bookkeeping throws', async () => {
    // The customer already has the message. Throwing here would return a
    // completed job to the queue and send it a second time.
    const { svc, followups } = build({ conversationId: 'convo-1' });
    followups.scheduleNext.mockRejectedValue(new Error('db down'));
    await expect(svc.complete(WS, 'job-1', true)).resolves.toBe(true);
  });

  it('tells the connector WHY the job is queued', async () => {
    // "inbound" and "followup" need opposite messages: one answers a waiting
    // customer, the other nudges a silent one. A connector that cannot tell
    // them apart writes a reply to a question nobody asked.
    const nudge = build({ conversationId: 'convo-1', reason: 'followup' });
    expect((await nudge.svc.claim(WS))?.reason).toBe('followup');
    const answer = build({ conversationId: 'convo-1' });
    expect((await answer.svc.claim(WS))?.reason).toBe('inbound');
  });
});
