/**
 * advisory-lock — unit tests for withAdvisoryXactLock.
 */

import { withAdvisoryLock, withAdvisoryXactLock } from './advisory-lock';

function makePrisma(lockedResult: boolean) {
  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: lockedResult }]),
  };
  return {
    $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txMock) => Promise<void>, _opts?: unknown) => {
      return cb(txMock);
    }),
    _tx: txMock,
  };
}

describe('withAdvisoryXactLock', () => {
  it('calls run() when lock is acquired (locked=true)', async () => {
    const prisma = makePrisma(true);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryXactLock(prisma as any, 'test-job', run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT call run() when lock is held elsewhere (locked=false)', async () => {
    const prisma = makePrisma(false);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryXactLock(prisma as any, 'test-job', run);

    expect(run).not.toHaveBeenCalled();
  });

  it('passes timeoutMs to $transaction options', async () => {
    const prisma = makePrisma(true);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryXactLock(prisma as any, 'test-job', run, { timeoutMs: 5000 });

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 5000 },
    );
  });

  it('defaults to 45000ms timeout (above the 30s FIRE_TIMEOUT_MS + recordTrigger write)', async () => {
    const prisma = makePrisma(true);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryXactLock(prisma as any, 'test-job', run);

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 45_000 },
    );
  });
});

/**
 * The heartbeat.
 *
 * Every recurring thing this product does — the morning brief, the job runner,
 * ad pulls, review sync, calendar sync, every NetGSM poller, the sweeps: 20+
 * crons — passes through withAdvisoryLock, and not one of them wrote down that
 * it had run. A cron that silently stopped firing was indistinguishable from a
 * cron with nothing to do.
 */
describe('withAdvisoryLock — heartbeat', () => {
  const makeLockPrisma = (locked: boolean) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked }]) };
    return {
      $transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
      cronHeartbeat: { upsert: jest.fn().mockResolvedValue({}) },
    };
  };

  it('records a run when this replica did the work', async () => {
    const prisma = makeLockPrisma(true);

    await withAdvisoryLock(prisma as any, 'daily-digest', async () => undefined);

    const arg = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ jobName: 'daily-digest' });
    expect(arg.update.lastError).toBeNull();
    expect(arg.update.lastOkAt).toBeInstanceOf(Date);
  });

  it('records NOTHING when another replica holds the lock', async () => {
    const prisma = makeLockPrisma(false);

    await withAdvisoryLock(prisma as any, 'daily-digest', async () => undefined);

    // Three replicas ticking would otherwise report three runs for one
    // execution, and a job that only ever loses the race would look busy.
    expect(prisma.cronHeartbeat.upsert).not.toHaveBeenCalled();
  });

  it('records the failure AND still rethrows it', async () => {
    const prisma = makeLockPrisma(true);
    const boom = new Error('digest exploded');

    await expect(
      withAdvisoryLock(prisma as any, 'daily-digest', async () => {
        throw boom;
      }),
    ).rejects.toThrow('digest exploded');

    const arg = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(arg.update.lastError).toBe('digest exploded');
    expect(arg.update.failures).toEqual({ increment: 1 });
    // lastOkAt is NOT touched on failure: a lastRunAt far ahead of it is what
    // distinguishes "firing and failing" from "not firing at all".
    expect(arg.update.lastOkAt).toBeUndefined();
  });

  it('does not let a heartbeat write failure break a job that succeeded', async () => {
    const prisma = makeLockPrisma(true);
    prisma.cronHeartbeat.upsert.mockRejectedValue(new Error('table missing'));
    const run = jest.fn().mockResolvedValue(undefined);

    // A heartbeat is a note about the work, not the work.
    await expect(withAdvisoryLock(prisma as any, 'daily-digest', run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not let a heartbeat write failure replace the real error', async () => {
    const prisma = makeLockPrisma(true);
    prisma.cronHeartbeat.upsert.mockRejectedValue(new Error('table missing'));

    await expect(
      withAdvisoryLock(prisma as any, 'daily-digest', async () => {
        throw new Error('the actual problem');
      }),
    ).rejects.toThrow('the actual problem');
  });
});

/**
 * The sibling helper needed the same heartbeat.
 *
 * Instrumenting only withAdvisoryLock left every routine trigger invisible.
 * They are locked, so it was never a correctness problem — but
 * `list_scheduled_runs` showed them registered with nothing recorded, which is
 * exactly the shape of a job that is not firing. Two lock helpers with one of
 * them instrumented is a surface that reports half the schedule while looking
 * like it reports all of it.
 */
describe('withAdvisoryXactLock — heartbeat', () => {
  const makeXactPrisma = (locked: boolean) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked }]) };
    return {
      $transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
      cronHeartbeat: { upsert: jest.fn().mockResolvedValue({}) },
    };
  };

  it('records a run when this replica did the work', async () => {
    const prisma = makeXactPrisma(true);

    await withAdvisoryXactLock(prisma as any, 'routine:lead-scoring', async () => undefined);

    expect(prisma.cronHeartbeat.upsert.mock.calls[0][0].where).toEqual({
      jobName: 'routine:lead-scoring',
    });
  });

  it('records NOTHING when another replica holds the lock', async () => {
    const prisma = makeXactPrisma(false);

    await withAdvisoryXactLock(prisma as any, 'routine:lead-scoring', async () => undefined);

    expect(prisma.cronHeartbeat.upsert).not.toHaveBeenCalled();
  });

  it('records the failure and still rethrows it', async () => {
    const prisma = makeXactPrisma(true);

    await expect(
      withAdvisoryXactLock(prisma as any, 'routine:lead-scoring', async () => {
        throw new Error('routine exploded');
      }),
    ).rejects.toThrow('routine exploded');

    expect(prisma.cronHeartbeat.upsert.mock.calls[0][0].update.lastError).toBe('routine exploded');
  });

  it('does not let a heartbeat write failure break the run', async () => {
    const prisma = makeXactPrisma(true);
    prisma.cronHeartbeat.upsert.mockRejectedValue(new Error('table missing'));

    await expect(
      withAdvisoryXactLock(prisma as any, 'routine:lead-scoring', async () => undefined),
    ).resolves.toBeUndefined();
  });
});
