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
    svc = new ScheduledJobService(prisma as any, { getCronJobs: () => new Map() } as any);
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

/**
 * "Did the scheduled work run at all?"
 *
 * The heartbeats alone are a surface that lies by omission. They are written
 * from withAdvisoryLock, so a cron that does not use the lock — or returns
 * early before reaching it, as the call-analysis sweep does when STT is
 * unconfigured — never appears at all. Reading 9 rows against 37 registered
 * crons, you cannot tell "not instrumented" from "not firing", and those are
 * opposite problems with opposite fixes.
 */
describe('ScheduledJobService.listCronHeartbeats', () => {
  const make = (jobs: Map<string, unknown>, rows: unknown[] = []) => {
    const prisma: any = { cronHeartbeat: { findMany: jest.fn().mockResolvedValue(rows) } };
    return new ScheduledJobService(prisma, { getCronJobs: () => jobs } as any);
  };

  it('returns what IS registered next to what has been recorded', async () => {
    const jobs = new Map<string, unknown>([
      ['daily-digest', { lastDate: () => new Date('2026-08-26T11:00:00Z'), nextDate: () => new Date('2026-08-26T12:00:00Z') }],
      ['call-analysis-sweep', { lastDate: () => null, nextDate: () => null }],
    ]);

    const out = await make(jobs, [{ jobName: 'voice:call-analysis' }]).listCronHeartbeats();

    expect(out.registered.map((r) => r.name)).toEqual(['call-analysis-sweep', 'daily-digest']);
    expect(out.recorded).toHaveLength(1);
  });

  it('does not try to pair the two lists by name', async () => {
    // A cron's @Cron name and its lock name are different strings by convention
    // here — call-cdr-sync locks as telephony:cdr-sync — so a fuzzy match would
    // confidently pair the wrong two rows. Two honest lists instead.
    const jobs = new Map<string, unknown>([['call-cdr-sync', { lastDate: () => null, nextDate: () => null }]]);

    const out = await make(jobs, [{ jobName: 'telephony:cdr-sync' }]).listCronHeartbeats();

    expect(out.registered[0]).not.toHaveProperty('recorded');
    expect(out.registered[0].name).toBe('call-cdr-sync');
  });

  it('survives a cron whose date accessors throw', async () => {
    const jobs = new Map<string, unknown>([
      ['angry', { lastDate: () => { throw new Error('nope'); }, nextDate: () => { throw new Error('nope'); } }],
    ]);

    const out = await make(jobs).listCronHeartbeats();

    // A diagnostic that crashes while diagnosing is worse than no diagnostic.
    expect(out.registered).toEqual([{ name: 'angry', lastFiredAt: null, nextAt: null }]);
  });

  it('accepts a Luxon-style nextDate as readily as a Date', async () => {
    const when = new Date('2026-08-26T12:00:00Z');
    const jobs = new Map<string, unknown>([
      ['luxon', { lastDate: () => null, nextDate: () => ({ toJSDate: () => when }) }],
    ]);

    const out = await make(jobs).listCronHeartbeats();

    expect(out.registered[0].nextAt).toEqual(when);
  });

  it('returns the recorded rows even when the registry is unavailable', async () => {
    const prisma: any = { cronHeartbeat: { findMany: jest.fn().mockResolvedValue([{ jobName: 'x' }]) } };
    const svc = new ScheduledJobService(prisma, {
      getCronJobs: () => {
        throw new Error('no scheduler here');
      },
    } as any);

    const out = await svc.listCronHeartbeats();

    expect(out.registered).toEqual([]);
    expect(out.recorded).toHaveLength(1);
  });
});
