jest.mock('../../../common/scheduling/advisory-lock', () => ({
  // Run the critical section inline (single-replica assumption is the
  // production concern, not this unit's).
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => {
    await cb();
  }),
}));

import { ScheduledJobRunnerService } from './scheduled-job-runner.service';

/**
 * Claim → dispatch → outcome routing of the delayed-work runner. The DLQ and
 * backoff arithmetic are the load-bearing parts: a transient failure must
 * back off and stay PENDING; an unknown kind or an exhausted retry budget
 * must terminate as FAILED so it never spins forever.
 */
describe('ScheduledJobRunnerService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let runner: ScheduledJobRunnerService;

  function claim(jobs: any[]) {
    prisma.$queryRaw.mockResolvedValue(jobs);
  }

  beforeEach(() => {
    prisma = {
      scheduledJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ maxAttempts: 5 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    runner = new ScheduledJobRunnerService(prisma as any);
  });

  it('registers handlers and rejects a duplicate kind', () => {
    runner.registerHandler('k', async () => {});
    expect(runner.registeredKinds()).toContain('k');
    expect(() => runner.registerHandler('k', async () => {})).toThrow(/already registered/);
  });

  it('dispatches a claimed job to its handler and marks it DONE', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    runner.registerHandler('k', handler);
    claim([{ id: 'j1', workspaceId: WS, kind: 'k', payload: { a: 1 }, attempts: 0 }]);

    await runner.tick();

    expect(handler).toHaveBeenCalledWith({
      id: 'j1',
      workspaceId: WS,
      kind: 'k',
      payload: { a: 1 },
      attempts: 0,
    });
    expect(prisma.scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { status: 'DONE', completedAt: expect.any(Date), lastError: null },
    });
  });

  it('FAILs a job whose kind has no registered handler (code regression, not transient)', async () => {
    claim([{ id: 'j2', workspaceId: WS, kind: 'ghost', payload: {}, attempts: 0 }]);

    await runner.tick();

    const call = prisma.scheduledJob.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'j2' });
    expect(call.data.status).toBe('FAILED');
    expect(call.data.lastError).toMatch(/no handler/);
  });

  it('backs off a transient failure: stays PENDING with attempts+1 and a future runAt', async () => {
    runner.registerHandler('k', async () => {
      throw new Error('boom');
    });
    claim([{ id: 'j3', workspaceId: WS, kind: 'k', payload: {}, attempts: 0 }]);

    await runner.tick();

    const call = prisma.scheduledJob.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'j3' });
    expect(call.data.status).toBe('PENDING');
    expect(call.data.attempts).toBe(1);
    expect(call.data.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(call.data.lastError).toMatch(/boom/);
  });

  it('DLQs to FAILED once the retry budget is exhausted', async () => {
    prisma.scheduledJob.findUnique.mockResolvedValue({ maxAttempts: 5 });
    runner.registerHandler('k', async () => {
      throw new Error('still broken');
    });
    // attempts already 4 → this run makes it 5 == maxAttempts → FAILED
    claim([{ id: 'j4', workspaceId: WS, kind: 'k', payload: {}, attempts: 4 }]);

    await runner.tick();

    const call = prisma.scheduledJob.update.mock.calls[0][0];
    expect(call.data.status).toBe('FAILED');
    expect(call.data.attempts).toBe(5);
  });

  it('reaps RUNNING-stuck rows back to PENDING before claiming', async () => {
    await runner.tick();
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RUNNING' }),
        data: { status: 'PENDING', lockedAt: null },
      }),
    );
  });
});
