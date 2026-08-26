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
    const email = {
      sendPlainEmail: jest.fn().mockResolvedValue(true),
      isConfigured: jest.fn().mockReturnValue(true),
    };
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

/**
 * The one failure that cannot report itself.
 *
 * Every other problem this brief knows about, it reports IN the brief. Its own
 * non-delivery is the exception — and it was invisible twice over: the cron
 * ignored sendPlainEmail's return value, so `sent++` ran whether or not
 * anything left the building, and with no mailer configured that call logs an
 * [EMAIL MOCK] line and returns TRUE, so an unconfigured deploy reported a
 * successful send every single morning.
 *
 * It now fails the run, which puts the reason on the job's heartbeat — the
 * surface that IS readable when email is not.
 */
describe('DailyDigestCron — undelivered briefs', () => {
  const setup = (over: { sendOk?: boolean; configured?: boolean } = {}) => {
    const email = {
      sendPlainEmail: jest.fn().mockResolvedValue(over.sendOk ?? true),
      isConfigured: jest.fn().mockReturnValue(over.configured ?? true),
    };
    const digest = {
      build: jest.fn().mockResolvedValue({
        workspaceName: 'W',
        forDate: '2026-08-26',
        empty: false,
        needsYou: { title: 'x', items: ['a'] },
      }),
      recipients: jest.fn().mockResolvedValue(['owner@example.com']),
      render: jest.fn().mockReturnValue('body'),
    };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      cronHeartbeat: { upsert: jest.fn().mockResolvedValue({}) },
      workspace: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ws1', timezone: 'UTC', settings: null }]),
      },
      usageCounter: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = jest.fn().mockImplementation(async (cb: any) => cb(prisma));
    return { email, digest, prisma };
  };

  const atDigestHour = () => {
    jest.spyOn(Date.prototype, 'getTime');
    // DIGEST_HOUR defaults to 7 UTC; freeze the clock there.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T07:30:00Z'));
  };

  afterEach(() => jest.useRealTimers());

  it('records the failure on the heartbeat when a send does not go out', async () => {
    atDigestHour();
    const { email, digest, prisma } = setup({ sendOk: false });
    const cron = new DailyDigestCron(prisma, digest as never, email as never);

    await cron.tick();

    const hb = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(hb.update.lastError).toMatch(/undelivered/);
  });

  it('does not even try, and says so, when there is no mailer at all', async () => {
    atDigestHour();
    const { email, digest, prisma } = setup({ configured: false });
    const cron = new DailyDigestCron(prisma, digest as never, email as never);

    await cron.tick();

    // The [EMAIL MOCK] path returns true, so without the guard this deploy
    // would report a successful send every morning forever.
    expect(email.sendPlainEmail).not.toHaveBeenCalled();
    expect(prisma.cronHeartbeat.upsert.mock.calls[0][0].update.lastError).toMatch(
      /not configured/,
    );
  });

  it('still records a clean run when the mail actually goes', async () => {
    atDigestHour();
    const { email, digest, prisma } = setup();
    const cron = new DailyDigestCron(prisma, digest as never, email as never);

    await cron.tick();

    expect(email.sendPlainEmail).toHaveBeenCalledTimes(1);
    expect(prisma.cronHeartbeat.upsert.mock.calls[0][0].update.lastError).toBeNull();
  });
});
