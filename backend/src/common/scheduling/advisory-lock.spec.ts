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

/**
 * The lock slots.
 *
 * A lock pins a pooled connection for its whole body, and the body queries the
 * same pool — so with as many locks open as the pool has connections, every body
 * waits forever for a connection only another body can free. CI's pool is 5 and
 * every :X0 tick starts eleven locked crons; the app stalled for the full
 * pool_timeout each time, and whichever realdb suite was mid-query went red.
 * test/e2e/advisory-lock-pool.realdb.e2e-spec.ts shows it on a real pool. Here:
 * the cap itself, and that a slot is always given back.
 */
describe('lock slots', () => {
  const makePooledPrisma = (poolSize: number) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) };
    const state = { open: 0, maxOpen: 0 };
    return {
      poolSize,
      state,
      $transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => {
        state.open += 1;
        state.maxOpen = Math.max(state.maxOpen, state.open);
        try {
          return await cb(tx);
        } finally {
          state.open -= 1;
        }
      }),
      cronHeartbeat: { upsert: jest.fn().mockResolvedValue({}) },
    };
  };
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((resolve) => (open = resolve));
    return { shut, open };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it.each([
    ['withAdvisoryLock', withAdvisoryLock],
    ['withAdvisoryXactLock', withAdvisoryXactLock],
  ] as const)(
    '%s never holds more lock transactions open than half the pool, and still runs every job',
    async (_, lock) => {
      const prisma = makePooledPrisma(5);
      const { shut, open } = gate();
      const ran: number[] = [];

      const jobs = Array.from({ length: 11 }, (_, i) =>
        lock(prisma as any, `tick-job-${i}`, async () => {
          await shut;
          ran.push(i);
        }),
      );
      await settle();

      // Two transactions pinned, three connections left for their bodies.
      expect(prisma.state.open).toBe(2);

      open();
      await Promise.all(jobs);
      expect(prisma.state.maxOpen).toBe(2);
      expect(ran).toHaveLength(11);
    },
  );

  it('counts both helpers against the same pool', async () => {
    const prisma = makePooledPrisma(4);
    const { shut, open } = gate();

    const jobs = [
      withAdvisoryLock(prisma as any, 'cron-a', () => shut),
      withAdvisoryXactLock(prisma as any, 'routine-b', () => shut),
      withAdvisoryLock(prisma as any, 'cron-c', () => shut),
    ];
    await settle();

    expect(prisma.state.open).toBe(2);
    open();
    await Promise.all(jobs);
  });

  it('gives the slot back when the body throws', async () => {
    const prisma = makePooledPrisma(2);

    await expect(
      withAdvisoryLock(prisma as any, 'boom', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // One slot in all: a leaked one would park this job forever.
    const run = jest.fn().mockResolvedValue(undefined);
    await withAdvisoryLock(prisma as any, 'next', run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives the slot back when the transaction never starts', async () => {
    const prisma = makePooledPrisma(2);
    prisma.$transaction.mockRejectedValueOnce(new Error('Unable to start a transaction in the given time.'));

    await expect(withAdvisoryXactLock(prisma as any, 'starved', async () => undefined)).rejects.toThrow(
      'Unable to start a transaction',
    );

    const run = jest.fn().mockResolvedValue(undefined);
    await withAdvisoryXactLock(prisma as any, 'next', run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still lets one lock through on a pool too small to halve', async () => {
    const prisma = makePooledPrisma(1);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryLock(prisma as any, 'tiny-pool', run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
