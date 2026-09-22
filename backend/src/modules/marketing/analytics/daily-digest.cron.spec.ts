import { Prisma } from '@prisma/client';
import { DailyDigestCron } from './daily-digest.cron';
import { MailReceipt } from '../channels/outbound/outbound-mail.types';

/** What the gateway hands back. SENT unless a case says otherwise. */
const receipt = (over: Partial<MailReceipt> = {}): MailReceipt => ({
  outcome: 'SENT',
  ok: true,
  mailLogId: 'ml-1',
  messageId: 'mid@jeetagrowth.com',
  transport: 'PLATFORM',
  retriable: false,
  ...over,
});

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
    const mail = { send: jest.fn().mockResolvedValue(receipt()) };
    const cron = new DailyDigestCron(prisma as never, digest as never, mail as never);
    jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
    return { cron, prisma, digest, mail };
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
    const { cron, mail } = build([
      { id: 'ws-tr', timezone: 'Europe/Istanbul', settings: null },
      { id: 'ws-utc', timezone: 'UTC', settings: null },
      { id: 'ws-us', timezone: 'America/New_York', settings: null },
    ]);

    const out = await cron.tick();

    expect(out.sent).toBe(1);
    expect(mail.send).toHaveBeenCalledTimes(2); // owner + manager
    jest.useRealTimers();
  });

  it('respects a workspace that switched it off', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, mail } = build([
      {
        id: 'ws-tr',
        timezone: 'Europe/Istanbul',
        settings: { dailyDigest: { enabled: false } },
      },
    ]);

    await cron.tick();
    // A daily email nobody can stop is spam, however well-intentioned.
    expect(mail.send).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('defaults to ON when the workspace never expressed a preference', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, mail } = build([
      { id: 'ws-tr', timezone: 'Europe/Istanbul', settings: { somethingElse: true } },
    ]);
    await cron.tick();
    expect(mail.send).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('never sends the same local day twice', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, mail } = build(
      [{ id: 'ws-tr', timezone: 'Europe/Istanbul', settings: null }],
      true,
    );

    // The hourly tick re-enters within the same local hour after a restart;
    // the claimed counter row is what stops a duplicate inbox hit.
    await cron.tick();
    expect(mail.send).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('keeps going when one workspace throws', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T04:30:00Z'));
    const { cron, digest, mail } = build([
      { id: 'ws-a', timezone: 'Europe/Istanbul', settings: null },
      { id: 'ws-b', timezone: 'Europe/Istanbul', settings: null },
    ]);
    digest.build.mockRejectedValueOnce(new Error('boom'));

    const out = await cron.tick();

    expect(out.skipped).toBe(1);
    expect(mail.send).toHaveBeenCalled(); // the second one still went
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
  const setup = (over: { receipt?: MailReceipt } = {}) => {
    const mail = { send: jest.fn().mockResolvedValue(over.receipt ?? receipt()) };
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
    return { mail, digest, prisma };
  };

  const atDigestHour = () => {
    jest.spyOn(Date.prototype, 'getTime');
    // DIGEST_HOUR defaults to 7 UTC; freeze the clock there.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T07:30:00Z'));
  };

  const lastError = (prisma: any) =>
    prisma.cronHeartbeat.upsert.mock.calls[0][0].update.lastError as string;

  afterEach(() => jest.useRealTimers());

  it('never writes a recipient address or workspace id onto the heartbeat', async () => {
    atDigestHour();
    // A real relay quotes the mailbox back at you inside the rejection, so the
    // reason itself carries the address unless something strips it.
    const { mail, digest, prisma } = setup({
      receipt: receipt({
        ok: false,
        outcome: 'FAILED_TRANSIENT',
        reason: 'SYSTEMIC',
        error: '535 Authentication Failed for owner@example.com',
        transport: 'PLATFORM',
      }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    // The heartbeat is a PLATFORM row every tenant can read through
    // jeeta.list_scheduled_runs. Naming the mailbox there handed one
    // workspace's owner address to every other workspace's agent.
    expect(lastError(prisma)).not.toContain('owner@example.com');
    expect(lastError(prisma)).not.toContain('ws1');
    // The actionable half must survive: the reason, without the identity.
    expect(lastError(prisma)).toContain('535 Authentication Failed');
    expect(lastError(prisma)).toContain('1 recipient(s)');
  });

  it('records the failure on the heartbeat when a send does not go out', async () => {
    atDigestHour();
    const { mail, digest, prisma } = setup({
      receipt: receipt({ ok: false, outcome: 'FAILED_TRANSIENT', reason: 'TRANSIENT' }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    expect(lastError(prisma)).toMatch(/undelivered/);
  });

  it('treats a gateway REFUSAL as undelivered too, not as a send', async () => {
    atDigestHour();
    // REFUSED is not a failure — but the brief still did not arrive, and the
    // one surface that can say so is the heartbeat.
    const { mail, digest, prisma } = setup({
      receipt: receipt({
        ok: false,
        outcome: 'REFUSED',
        reason: 'BAD_RECIPIENT',
        transport: 'NONE',
      }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    expect(lastError(prisma)).toMatch(/undelivered/);
    expect(lastError(prisma)).toContain('BAD_RECIPIENT');
  });

  it('says so when there is no transport at all, instead of counting a mock send', async () => {
    atDigestHour();
    // EmailService deliberately logs [EMAIL MOCK] and returns true with no
    // transporter, so before the gateway an inert deploy reported a successful
    // send every morning forever. NOT_CONFIGURED is the gateway's answer.
    const { mail, digest, prisma } = setup({
      receipt: receipt({
        ok: false,
        outcome: 'FAILED_PERMANENT',
        reason: 'NOT_CONFIGURED',
        error: 'email transport is not configured',
        transport: 'NONE',
      }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    expect(lastError(prisma)).toMatch(/not configured/);
  });

  it('still records a clean run when the mail actually goes', async () => {
    atDigestHour();
    const { mail, digest, prisma } = setup();
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(lastError(prisma)).toBeNull();
  });

  it('carries the SMTP reason, not just the fact of failure', async () => {
    atDigestHour();
    const { mail, digest, prisma } = setup({
      receipt: receipt({
        ok: false,
        outcome: 'FAILED_TRANSIENT',
        reason: 'SYSTEMIC',
        error: '535 5.7.8 Authentication credentials invalid',
      }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    // "Undelivered" tells the owner to look; the SMTP line tells them what to
    // fix. Live, the first real failure said only the former.
    expect(lastError(prisma)).toContain('535 5.7.8 Authentication credentials invalid');
  });

  it('still records the failure when no reason is available', async () => {
    atDigestHour();
    const { mail, digest, prisma } = setup({
      receipt: receipt({ ok: false, outcome: 'FAILED_PERMANENT' }),
    });
    const cron = new DailyDigestCron(prisma, digest as never, mail as never);

    await cron.tick();

    expect(lastError(prisma)).toMatch(/undelivered/);
  });
});

/**
 * The brief is mail we send to OUR OWN users about OUR OWN product.
 *
 * That is what `INTERNAL` is for, and every cell of its gate row is a decision:
 * an unsubscribe header on an account-service mail invites the manager to
 * switch off the one report that tells them the machine is running; metering it
 * against `messagesMonthly` spends a paying customer's quota on our mail; and a
 * tenant Reply-To would send "why did I get this?" to the tenant's own sales
 * inbox instead of to us.
 */
describe('DailyDigestCron — the class the brief is sent under', () => {
  it('sends INTERNAL, with no unsubscribe, no lead and no idempotency key', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T07:30:00Z'));
    const mail = { send: jest.fn().mockResolvedValue(receipt()) };
    const digest = {
      build: jest.fn().mockResolvedValue({ workspaceName: 'W', forDate: '2026-08-26', empty: false }),
      recipients: jest.fn().mockResolvedValue(['owner@example.com']),
      render: jest.fn().mockReturnValue('the brief'),
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

    await new DailyDigestCron(prisma, digest as never, mail as never).tick();

    const sent = mail.send.mock.calls[0][0];
    expect(sent).toMatchObject({
      workspaceId: 'ws1',
      mailClass: 'INTERNAL',
      to: 'owner@example.com',
      text: 'the brief',
      source: 'digest',
    });
    expect(sent.subject).toContain('W');
    expect(sent.unsubscribe).toBeUndefined();
    expect(sent.leadId).toBeUndefined();
    // The UsageCounter row already claims the local day; a second dedupe key
    // would only stand between a retry and a brief nobody got.
    expect(sent.idempotencyKey).toBeUndefined();
    jest.useRealTimers();
  });
});
