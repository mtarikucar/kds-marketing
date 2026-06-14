/**
 * advisory-lock — unit tests for withAdvisoryXactLock.
 */

import { withAdvisoryXactLock } from './advisory-lock';

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

  it('defaults to 35000ms timeout', async () => {
    const prisma = makePrisma(true);
    const run = jest.fn().mockResolvedValue(undefined);

    await withAdvisoryXactLock(prisma as any, 'test-job', run);

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 35_000 },
    );
  });
});
