import { Prisma } from '@prisma/client';
import { DailyDigestCron } from './daily-digest.cron';

/**
 * A morning brief is only a morning brief in the reader's timezone. Sending
 * every tenant at 07:00 server time lands at 04:00 for one customer and 14:00
 * for another, which is not the feature.
 */
describe('DailyDigestCron', () => {
  const build = (ws: any[], sentAlready = false) => {
    const prisma = {
      workspace: { findMany: jest.fn().mockResolvedValue(ws) },
      usageCounter: {
        create: sentAlready
          ? jest.fn().mockRejectedValue(
              new Prisma.PrismaClientKnownRequestError('dup', {
                code: 'P2002',
                clientVersion: 'x',
              }),
            )
          : jest.fn().mockResolvedValue({}),
      },
      // withAdvisoryLock runs the body inside an interactive transaction and
      // gates it on pg_try_advisory_xact_lock; grant the lock so the body runs.
      $transaction: jest.fn(async (fn: any) =>
        fn({ $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]) }),
      ),
    };
    const digest = {
      build: jest.fn().mockResolvedValue({
        workspaceName: 'HummyTummy',
        forDate: '2026-08-20',
        empty: false,
      }),
      render: jest.fn().mockReturnValue('body'),
      recipients: jest.fn().mockResolvedValue(['owner@x.io', 'manager@x.io']),
    };
    const email = { sendPlainEmail: jest.fn().mockResolvedValue(true) };
    const cron = new DailyDigestCron(prisma as never, digest as never, email as never);
    jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
    return { cron, prisma, digest, email };
  };

  describe('localParts', () => {
    it('reads the wall clock in the workspace timezone, not the server one', () => {
      const at = new Date('2026-08-20T04:30:00Z');
      expect(DailyDigestCron.localParts('Europe/Istanbul', at).hour).toBe(7);
      expect(DailyDigestCron.localParts('UTC', at).hour).toBe(4);
      expect(DailyDigestCron.localParts('America/New_York', at).hour).toBe(0);
    });

    it('rolls the local DATE, not just the hour', () => {
      // 22:30 in New York is already the next day in Istanbul — the
      // idempotency key has to follow the reader's calendar.
      const at = new Date('2026-08-20T02:30:00Z');
      expect(DailyDigestCron.localParts('America/New_York', at).date).toBe('2026-08-19');
      expect(DailyDigestCron.localParts('Europe/Istanbul', at).date).toBe('2026-08-20');
    });

    it('falls back to UTC on a bad timezone rather than silencing the workspace', () => {
      const at = new Date('2026-08-20T04:30:00Z');
      expect(DailyDigestCron.localParts('Not/AZone', at)).toEqual({ hour: 4, date: '2026-08-20' });
    });
  });

  it('sends only to workspaces whose local clock reads the digest hour', async () => {
    // Same instant: 07:00 in Istanbul, 04:00 UTC, midnight in New York.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, email } = build([
      { id: 'ws-tr', timezone: 'Europe/Istanbul', settings: null },
      { id: 'ws-utc', timezone: 'UTC', settings: null },
      { id: 'ws-us', timezone: 'America/New_York', settings: null },
    ]);

    const out = await cron.tick();

    expect(out.sent).toBe(1);
    expect(email.sendPlainEmail).toHaveBeenCalledTimes(2); // owner + manager
    jest.useRealTimers();
  });

  it('respects a workspace that switched it off', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, email } = build([
      {
        id: 'ws-tr',
        timezone: 'Europe/Istanbul',
        settings: { dailyDigest: { enabled: false } },
      },
    ]);

    await cron.tick();
    // A daily email nobody can stop is spam, however well-intentioned.
    expect(email.sendPlainEmail).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('defaults to ON when the workspace never expressed a preference', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, email } = build([
      { id: 'ws-tr', timezone: 'Europe/Istanbul', settings: { somethingElse: true } },
    ]);
    await cron.tick();
    expect(email.sendPlainEmail).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('never sends the same local day twice', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, email } = build(
      [{ id: 'ws-tr', timezone: 'Europe/Istanbul', settings: null }],
      true,
    );

    // The hourly tick re-enters within the same local hour after a restart;
    // the claimed counter row is what stops a duplicate inbox hit.
    await cron.tick();
    expect(email.sendPlainEmail).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps going when one workspace throws', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, digest, email } = build([
      { id: 'ws-a', timezone: 'Europe/Istanbul', settings: null },
      { id: 'ws-b', timezone: 'Europe/Istanbul', settings: null },
    ]);
    digest.build.mockRejectedValueOnce(new Error('boom'));

    const out = await cron.tick();

    expect(out.skipped).toBe(1);
    expect(email.sendPlainEmail).toHaveBeenCalled(); // the second one still went
    jest.useRealTimers();
  });
});
