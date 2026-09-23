import { Prisma } from '@prisma/client';
import { MailboxHealthService } from './mailbox-health.service';
import {
  isMailboxBackedOff,
  nextBackoffMs,
  readMailboxHealth,
  reauthRequiredWhere,
} from './mailbox-health.service';

/**
 * "Is this mailbox working, and if not, since when?"
 *
 * Every one of these tests exists because the answer used to live nowhere a
 * human could reach it: a revoked Google token was sealed inside the AES-GCM
 * box as `oauthError`, with nothing to filter on and no reader, so the account
 * center showed HEALTHY while every send failed forever
 * (`oauth-revoked-invisible`).
 */
describe('MailboxHealthService', () => {
  const REF = { id: 'ch-1', workspaceId: 'ws-1' };
  const NOW = new Date('2026-09-22T10:00:00.000Z');

  let prisma: any;
  let svc: MailboxHealthService;

  /**
   * The `configPublic` PATCH this write hands the database.
   *
   * It is a patch, not a blob: the write is one `configPublic || $patch`
   * statement, so anything not named here keeps whatever the row holds at
   * write time. That is why nothing below asserts on the column's other keys.
   */
  function written(): any {
    const calls = prisma.$executeRaw.mock.calls;
    return JSON.parse(patchIn(calls[calls.length - 1][0]));
  }

  /** The JSON parameter out of a `Prisma.sql` statement. */
  function patchIn(sql: any): string {
    return (sql.values as unknown[]).find((v) => typeof v === 'string' && v.startsWith('{')) as string;
  }

  /** Hand the next re-read a row whose `configPublic` looks like this. */
  function rowIs(configPublic: unknown): void {
    prisma.channel.findFirst.mockResolvedValue({ configPublic });
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue({ configPublic: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      // The health patch is written with ONE statement that merges it onto the
      // row in the database (`configPublic || $patch`), so the column's other
      // writers — the two IMAP cursors, a settings save — cannot be clobbered
      // by a blob this service read seconds ago.
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    svc = new MailboxHealthService(prisma);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('writing without clobbering', () => {
    it('re-reads the row inside its workspace and writes the health key ALONE', async () => {
      // The caller has been holding a Channel row since before it opened an
      // IMAP connection. The re-read is for the patch — `since`, the failure
      // count — and the write names one key, so the tenant's own settings and
      // both IMAP cursors are untouchable from here whatever this copy says.
      rowIs({ greeting: 'merhaba', imapLastUid: 41 });

      await svc.recordOk(REF, 'send');

      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { id: 'ch-1', workspaceId: 'ws-1' },
        select: { configPublic: true },
      });
      expect(Object.keys(written())).toEqual(['health']);
      expect(written().health.send.ok).toBe(true);
      // Never a whole-blob write, however stale the copy in hand.
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('leaves the other lane alone — sending and receiving fail separately', async () => {
      rowIs({ health: { receive: { ok: false, lastError: 'AUTHENTICATIONFAILED' } } });

      await svc.recordOk(REF, 'send');

      expect(written().health.receive).toEqual({ ok: false, lastError: 'AUTHENTICATIONFAILED' });
      expect(written().health.send.ok).toBe(true);
    });

    it('records the provider\'s own words, truncated, not a paraphrase', async () => {
      await svc.recordFailure(REF, 'send', { error: 'x'.repeat(1000), reason: 'AUTH_FAILED' });

      const lane = written().health.send;
      expect(lane.ok).toBe(false);
      expect(lane.reason).toBe('AUTH_FAILED');
      expect(lane.lastError.length).toBeLessThanOrEqual(300);
      expect(lane.lastError.startsWith('xxx')).toBe(true);
      expect(lane.lastErrorAt).toBe(NOW.toISOString());
    });

    it('keeps `since` pinned to when the lane went bad, so "down for 2h" is answerable', async () => {
      const wentBad = '2026-09-22T07:00:00.000Z';
      rowIs({ health: { receive: { ok: false, since: wentBad, lastError: 'ECONNRESET' } } });

      await svc.recordFailure(REF, 'receive', { error: 'ECONNRESET again' });

      expect(written().health.receive.since).toBe(wentBad);
      expect(written().health.receive.lastErrorAt).toBe(NOW.toISOString());
    });

    it('does not roll back a cursor that moved while the patch was being computed', async () => {
      // The re-read narrows the window; it does not close it. `configPublic`
      // is ONE column carrying both this health block and the IMAP pollers'
      // cursors, and a send settling and a sweep finishing are not serialized
      // by anything. Read at 400, write the whole blob back at 400, and the
      // sweep's 500 is gone — the next tick re-fetches the same fifty
      // messages, every tick, for as long as the pattern repeats. The reverse
      // interleave erases an `oauthReauthRequiredAt` the owner's card is
      // supposed to be showing. Only a write that touches the health key
      // ALONE, inside the database, is safe.
      const row: { configPublic: Record<string, unknown> } = { configPublic: { imapLastUid: 400 } };
      prisma.channel.findFirst.mockImplementation(async () => {
        const snapshot = { configPublic: { ...row.configPublic } };
        // The INBOX sweep drains the mailbox and moves its cursor while this
        // health write is holding its copy.
        row.configPublic = { ...row.configPublic, imapLastUid: 500 };
        return snapshot;
      });
      prisma.$executeRaw.mockImplementation(async (sql: any) => {
        // The real statement is `configPublic || $patch` — a shallow merge the
        // database applies to the row as it is at write time.
        row.configPublic = { ...row.configPublic, ...JSON.parse(patchIn(sql)) };
        return 1;
      });

      await svc.recordOk(REF, 'send');

      expect(row.configPublic.imapLastUid).toBe(500);
      expect((row.configPublic.health as any).send.ok).toBe(true);
    });

    it('does not resurrect a deleted mailbox', async () => {
      prisma.channel.findFirst.mockResolvedValue(null);

      await expect(svc.recordOk(REF, 'send')).resolves.toBeUndefined();
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('never throws — a health write must not fail the mail it is describing', async () => {
      prisma.$executeRaw.mockRejectedValue(new Error('deadlock detected'));

      await expect(svc.recordFailure(REF, 'send', { error: 'nope' })).resolves.toBeUndefined();
    });
  });

  describe('backoff — failed holds only', () => {
    it('counts consecutive failed holds and stretches the wait each time', async () => {
      rowIs({});
      const first = await svc.recordBackoff(REF, { error: 'connect ETIMEDOUT' });
      expect(first.failCount).toBe(1);
      expect(written().health.consecutiveFailures).toBe(1);
      expect(written().health.backoffUntil).toBe(new Date(NOW.getTime() + 60_000).toISOString());

      rowIs(written());
      const second = await svc.recordBackoff(REF, { error: 'connect ETIMEDOUT' });
      expect(second.failCount).toBe(2);
      expect(written().health.backoffUntil).toBe(new Date(NOW.getTime() + 120_000).toISOString());

      rowIs(written());
      await svc.recordBackoff(REF, { error: 'connect ETIMEDOUT' });
      expect(written().health.backoffUntil).toBe(new Date(NOW.getTime() + 240_000).toISOString());
    });

    it('resets the moment a hold succeeds', async () => {
      rowIs({ health: { consecutiveFailures: 5, backoffUntil: '2026-09-22T10:30:00.000Z' } });

      await svc.recordOk(REF, 'receive');

      expect(written().health.consecutiveFailures).toBe(0);
      expect(written().health.backoffUntil).toBeUndefined();
      expect(written().health.receive.ok).toBe(true);
    });

    it('clears the wait when the operator re-verifies, without claiming receive works', async () => {
      // ChannelsService.verify's `health.ok` branch is SEND-truth. A fixed
      // password should let inbound retry at once rather than serving out an
      // hour of backoff earned under the old one.
      rowIs({ health: { consecutiveFailures: 5, backoffUntil: '2026-09-22T10:30:00.000Z' } });

      await svc.clearBackoff(REF);

      expect(written().health.consecutiveFailures).toBe(0);
      expect(written().health.backoffUntil).toBeUndefined();
      expect(written().health.receive).toBeUndefined();
    });

    it('does not back off on a plain failure — a dropped IDLE socket is routine', async () => {
      rowIs({ health: { consecutiveFailures: 2, backoffUntil: '2026-09-22T10:02:00.000Z' } });

      await svc.recordFailure(REF, 'receive', { error: 'socket closed' });

      expect(written().health.consecutiveFailures).toBe(2);
      expect(written().health.backoffUntil).toBe('2026-09-22T10:02:00.000Z');
    });

    it('does not back the poller off because a send failed', async () => {
      rowIs({ health: { consecutiveFailures: 0 } });

      await svc.recordFailure(REF, 'send', { error: '535 authentication failed' });

      expect(written().health.consecutiveFailures).toBe(0);
      expect(written().health.backoffUntil).toBeUndefined();
    });

    it('caps the wait at an hour, and at six for a classified credential failure', () => {
      expect(nextBackoffMs(1)).toBe(60_000);
      expect(nextBackoffMs(2)).toBe(120_000);
      expect(nextBackoffMs(5)).toBe(16 * 60_000);
      expect(nextBackoffMs(7)).toBe(60 * 60_000);
      expect(nextBackoffMs(99)).toBe(60 * 60_000);
      // Never "stop forever on auth failure": a transient AUTHENTICATIONFAILED
      // would otherwise kill this mailbox's inbound permanently.
      expect(nextBackoffMs(99, true)).toBe(6 * 60 * 60_000);
      expect(nextBackoffMs(2, true)).toBe(120_000);
    });

    it('tells the poller when to stay away, and when it may try again', () => {
      const held = { health: { backoffUntil: '2026-09-22T10:05:00.000Z' } };
      expect(isMailboxBackedOff(held)).toBe(true);
      expect(isMailboxBackedOff(held, new Date('2026-09-22T10:06:00.000Z'))).toBe(false);
      expect(isMailboxBackedOff({})).toBe(false);
      expect(isMailboxBackedOff({ health: { backoffUntil: 'soon' } })).toBe(false);
      expect(isMailboxBackedOff(null)).toBe(false);
    });
  });

  describe('a revoked connection the owner can actually see', () => {
    it('stamps the marker in plaintext, outside the sealed box', async () => {
      await svc.recordOAuthReauthRequired(REF, { error: 'invalid_grant' });

      // The statement names `configPublic` and nothing else — `configSealed`
      // is not even reachable from here.
      const sql: string = prisma.$executeRaw.mock.calls[0][0].sql;
      expect(sql).not.toContain('configSealed');
      expect(written().health.oauthReauthRequiredAt).toBe(NOW.toISOString());
      expect(written().health.send).toMatchObject({
        ok: false,
        reason: 'OAUTH_REAUTH_REQUIRED',
        lastError: 'invalid_grant',
      });
    });

    it('is queryable without a key — the whole point of not sealing it', () => {
      // `oauthError` is inside AES-GCM with nothing to filter on, which is why
      // no digest, readiness check or notification could ever see it.
      expect(reauthRequiredWhere()).toEqual({
        configPublic: { path: ['health', 'oauthReauthRequiredAt'], not: Prisma.DbNull },
      });
    });

    it('keeps the first sighting instead of refreshing it every hour', async () => {
      const first = '2026-09-20T08:00:00.000Z';
      rowIs({ health: { oauthReauthRequiredAt: first } });

      await svc.recordOAuthReauthRequired(REF, { error: 'invalid_grant' });

      expect(written().health.oauthReauthRequiredAt).toBe(first);
    });

    it('clears on reconnect, so a fixed mailbox stops reading as broken', async () => {
      rowIs({
        health: {
          oauthReauthRequiredAt: '2026-09-20T08:00:00.000Z',
          send: { ok: false, reason: 'OAUTH_REAUTH_REQUIRED', lastError: 'invalid_grant' },
        },
      });

      await svc.clearOAuthReauthRequired(REF);

      expect(written().health.oauthReauthRequiredAt).toBeUndefined();
      expect(written().health.send).toBeUndefined();
    });

    it('leaves a real SMTP failure standing when it clears the marker', async () => {
      rowIs({
        health: {
          oauthReauthRequiredAt: '2026-09-20T08:00:00.000Z',
          send: { ok: false, reason: 'AUTH_FAILED', lastError: '535 5.7.8' },
        },
      });

      await svc.clearOAuthReauthRequired(REF);

      expect(written().health.oauthReauthRequiredAt).toBeUndefined();
      expect(written().health.send.reason).toBe('AUTH_FAILED');
    });
  });

  describe('what the card reads', () => {
    it('bumps lastPolledAt only when it really was a poll', async () => {
      rowIs({});
      await svc.recordOk(REF, 'receive');
      expect(written().health.lastPolledAt).toBeUndefined();

      rowIs({});
      await svc.recordOk(REF, 'receive', { polled: true });
      expect(written().health.lastPolledAt).toBe(NOW.toISOString());
    });

    it('bumps lastMessageAt and nothing else', async () => {
      rowIs({ health: { receive: { ok: false, lastError: 'boom' } } });

      await svc.recordMessage(REF);

      expect(written().health.lastMessageAt).toBe(NOW.toISOString());
      expect(written().health.receive).toEqual({ ok: false, lastError: 'boom' });
    });

    it('reads junk as "nothing known yet" rather than throwing at a renderer', () => {
      expect(readMailboxHealth(null)).toEqual({});
      expect(readMailboxHealth('nope')).toEqual({});
      expect(readMailboxHealth({ health: 'nope' })).toEqual({});
      expect(readMailboxHealth({ health: { send: { ok: true } } })).toEqual({ send: { ok: true } });
    });
  });
});
