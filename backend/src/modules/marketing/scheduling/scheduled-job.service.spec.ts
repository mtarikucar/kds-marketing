import { Prisma } from '@prisma/client';
import { ScheduledJobService } from './scheduled-job.service';

/**
 * Enqueue/cancel side of the delayed-work primitive. The dedup contract is
 * the load-bearing part: scheduling the same (kind, dedupKey) while one is
 * still PENDING must collapse onto the existing row (reschedule, not pile up)
 * — the partial-unique index is the DB backstop, this is the app-side path.
 */
describe('ScheduledJobService', () => {
  const WS = 'ws-1';
  const RUN_AT = new Date('2026-07-01T00:00:00.000Z');
  let prisma: any;
  let svc: ScheduledJobService;

  beforeEach(() => {
    prisma = {
      scheduledJob: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'job-new' }),
        update: jest.fn().mockResolvedValue({ id: 'job-existing' }),
        updateMany: jest.fn(),
      },
    };
    svc = new ScheduledJobService(prisma as any);
  });

  it('creates a fresh job when there is no dedupKey', async () => {
    const id = await svc.schedule({
      workspaceId: WS,
      kind: 'workflow.resume',
      runAt: RUN_AT,
      payload: { runId: 'r1' },
    });
    expect(id).toBe('job-new');
    expect(prisma.scheduledJob.create).toHaveBeenCalledTimes(1);
    const data = prisma.scheduledJob.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe(WS);
    expect(data.dedupKey).toBeNull();
    expect(prisma.scheduledJob.findFirst).not.toHaveBeenCalled();
  });

  it('creates when a dedupKey has no live PENDING row', async () => {
    prisma.scheduledJob.findFirst.mockResolvedValue(null);
    const id = await svc.schedule({
      workspaceId: WS,
      kind: 'conversation.followup',
      runAt: RUN_AT,
      payload: {},
      dedupKey: 'conv-1',
    });
    expect(id).toBe('job-new');
    expect(prisma.scheduledJob.findFirst).toHaveBeenCalledWith({
      where: { kind: 'conversation.followup', dedupKey: 'conv-1', status: 'PENDING' },
      select: { id: true },
    });
    expect(prisma.scheduledJob.create).toHaveBeenCalledTimes(1);
  });

  it('reschedules in place (no second row) when a PENDING dedup row exists', async () => {
    prisma.scheduledJob.findFirst.mockResolvedValue({ id: 'job-existing' });
    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 1 }); // conditional claim wins
    const id = await svc.schedule({
      workspaceId: WS,
      kind: 'conversation.followup',
      runAt: RUN_AT,
      payload: { n: 2 },
      dedupKey: 'conv-1',
    });
    expect(id).toBe('job-existing');
    expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    // The reschedule is an ATOMIC conditional claim — the where carries the
    // status guard so a row the runner just claimed can never be rewritten.
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.scheduledJob.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'job-existing', status: 'PENDING' },
      data: { runAt: RUN_AT, payload: { n: 2 }, workspaceId: WS },
    });
  });

  it('falls through to CREATE when the runner claims the row mid-reschedule (lost conditional claim)', async () => {
    // findFirst saw a PENDING row, but the runner flipped it to RUNNING before
    // our write — the unguarded update used to rewrite the RUNNING row (silently
    // losing the reschedule). Now the conditional claim misses and a fresh
    // PENDING row is created for the new time instead.
    prisma.scheduledJob.findFirst.mockResolvedValue({ id: 'job-existing' });
    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 0 }); // claim lost
    const id = await svc.schedule({
      workspaceId: WS,
      kind: 'conversation.followup',
      runAt: RUN_AT,
      payload: { n: 2 },
      dedupKey: 'conv-1',
    });
    expect(id).toBe('job-new');
    expect(prisma.scheduledJob.create).toHaveBeenCalledTimes(1);
  });

  it('collapses a P2002 create race onto the winner PENDING row (clean, not a 500)', async () => {
    // Lost the findFirst→create race: no PENDING seen, create rejected by the
    // partial-unique index. Collapse onto the concurrent winner instead of throwing.
    prisma.scheduledJob.findFirst
      .mockResolvedValueOnce(null) // initial dedup check: nothing PENDING yet
      .mockResolvedValueOnce({ id: 'job-winner' }); // post-conflict re-read
    prisma.scheduledJob.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const id = await svc.schedule({
      workspaceId: WS,
      kind: 'lead.enroll_batch',
      runAt: RUN_AT,
      payload: {},
      dedupKey: 'enroll:wf1',
    });
    expect(id).toBe('job-winner');
  });

  it('rethrows a non-P2002 create error', async () => {
    prisma.scheduledJob.findFirst.mockResolvedValue(null);
    prisma.scheduledJob.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      svc.schedule({ workspaceId: WS, kind: 'k', runAt: RUN_AT, payload: {}, dedupKey: 'd' }),
    ).rejects.toThrow('db down');
  });

  it('cancel flips the PENDING (kind, dedupKey) row and reports whether it hit', async () => {
    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 1 });
    await expect(svc.cancel('conversation.followup', 'conv-1')).resolves.toBe(true);
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({
      where: { kind: 'conversation.followup', dedupKey: 'conv-1', status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: expect.any(Date) },
    });

    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.cancel('conversation.followup', 'gone')).resolves.toBe(false);
  });

  it('cancelById only cancels a still-PENDING row', async () => {
    prisma.scheduledJob.updateMany.mockResolvedValue({ count: 1 });
    await expect(svc.cancelById('job-x')).resolves.toBe(true);
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-x', status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: expect.any(Date) },
    });
  });
});
