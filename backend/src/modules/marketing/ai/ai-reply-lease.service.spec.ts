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
    };
    return { prisma, svc: new AiReplyLeaseService(prisma) };
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
});
