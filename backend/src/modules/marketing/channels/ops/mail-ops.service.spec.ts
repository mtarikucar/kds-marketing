import {
  INERT_MAIL_FEATURES,
  MAIL_ALERT_THRESHOLDS,
  MailOpsService,
  breaches,
  inertMailFeatures,
  sweepHeartbeatError,
} from './mail-ops.service';

/**
 * `no-email-observability` — the numbers, the inert list and the two pure
 * verdicts the cron and the poller are built on.
 *
 * Everything the operator and the tenant see comes from `MailLog` +
 * `EmailInboundItem` + `Channel.configPublic.health`. There is no metrics
 * store, so these are plain scoped aggregates and the only thing worth
 * testing hard is that they never cross a workspace, never throw, and that
 * the thresholds say the same thing twice.
 */

const WS = 'ws-1';
const NOW = new Date('2026-09-22T12:00:00.000Z');

function counted(rows: Record<string, unknown>[]): any[] {
  return rows.map((r) => ({ ...r, _count: { _all: (r as any)._n ?? 1 } }));
}

function build(over: Partial<Record<string, any>> = {}) {
  const prisma: any = {
    mailLog: {
      groupBy: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    emailInboundItem: { groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
    contactSuppression: { groupBy: jest.fn(async () => []) },
    channel: { findMany: jest.fn(async () => []) },
    workspace: { findFirst: jest.fn(async () => ({ settings: null })) },
    ...over.prisma,
  };
  const budget = {
    usage: jest.fn(async () => ({ day: '2026-09-22', limit: 1000, used: 12, remaining: 988 })),
    ...over.budget,
  };
  const identity = {
    resolve: jest.fn(async () => ({
      transport: 'PLATFORM',
      fromEmail: 'admin@jeetagrowth.com',
      fromName: 'Acme via Jeeta',
      replyTo: 'owner@acme.com',
      // A ResolvedChannelConfig carries the mailbox SECRETS; the report must
      // never carry it out of the service.
      config: { secrets: { password: 'hunter2' } },
      degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
    })),
    ...over.identity,
  };
  return {
    prisma,
    budget,
    identity,
    svc: new MailOpsService(prisma, budget as any, identity as any),
  };
}

describe('sweepHeartbeatError — an honest IMAP heartbeat', () => {
  // A percentage threshold on a shared platform cron means one tenant's bad
  // password reds the job for everyone, and the surface stops being believed.
  it('stays green when one of three mailboxes fails', () => {
    expect(sweepHeartbeatError({ ok: 2, failed: 1, skipped: 0 }, ['auth failed'])).toBeNull();
  });

  it('reds when every mailbox that was attempted failed', () => {
    const msg = sweepHeartbeatError({ ok: 0, failed: 3, skipped: 1 }, [
      'login failed',
      'connection reset',
      'timeout',
    ]);
    expect(msg).toContain('3');
    expect(msg).toContain('login failed');
    expect(msg).toContain('connection reset');
    // Only the first two reasons — a hundred dead mailboxes must still fit in
    // CronHeartbeat.lastError.
    expect(msg).not.toContain('timeout');
  });

  it('stays green when there was nothing to do', () => {
    expect(sweepHeartbeatError({ ok: 0, failed: 0, skipped: 4 }, [])).toBeNull();
  });
});

describe('inertMailFeatures — why nothing sent', () => {
  it('names every env-gated email feature that is currently off', () => {
    const list = inertMailFeatures({});
    expect(list.map((f) => f.key).sort()).toEqual(
      INERT_MAIL_FEATURES.map((f) => f.key).sort(),
    );
    const oauth = list.find((f) => f.key === 'MAILBOX_OAUTH_GOOGLE')!;
    expect(oauth.missing).toEqual(['GOOGLE_MAIL_CLIENT_ID', 'GOOGLE_MAIL_CLIENT_SECRET']);
  });

  it('drops a feature once every key it needs is set, and never echoes a value', () => {
    const list = inertMailFeatures({
      GOOGLE_MAIL_CLIENT_ID: 'id',
      GOOGLE_MAIL_CLIENT_SECRET: 'secret',
    });
    expect(list.find((f) => f.key === 'MAILBOX_OAUTH_GOOGLE')).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  it('counts a blank string as unset — a rendered `KEY=` is not a credential', () => {
    const list = inertMailFeatures({ EMAIL_INBOUND_SECRET: '   ' });
    expect(list.find((f) => f.key === 'INBOUND_WEBHOOK')).toBeDefined();
  });

  it('treats a named ESP provider as half-armed until its credential is there', () => {
    const list = inertMailFeatures({ SENDING_DOMAIN_ESP: 'true' });
    expect(list.find((f) => f.key === 'SENDING_DOMAIN_ESP')).toBeDefined();
  });

  /**
   * The sending-domain entry asks the GATE, not the environment.
   *
   * The gate's own answer is the one the nav item, the register endpoint and
   * the From-override all obey, and it is stricter than "the key is set": a
   * provider name it does not recognise arms nothing, and the SPF include has
   * to be a real host rather than the placeholder the feature shipped with. A
   * panel that reads `process.env` itself tells an operator the path is armed
   * while the product refuses it — and names a key (`SENDING_DOMAIN_ESP_API_KEY`)
   * that nothing in the deploy or the code has ever read.
   */
  describe('the sending-domain entry agrees with the gate', () => {
    const find = (env: Record<string, string | undefined>) =>
      inertMailFeatures(env).find((f) => f.key === 'SENDING_DOMAIN_ESP');

    it('names only keys an operator can actually set', () => {
      const entry = find({});
      expect(entry!.env).toEqual(['SENDING_DOMAIN_ESP', 'SENDING_DOMAIN_SPF_INCLUDE']);
      expect(JSON.stringify(entry)).not.toContain('SENDING_DOMAIN_ESP_API_KEY');
    });

    it('stays inert for a provider name the gate does not know', () => {
      // `SENDING_DOMAIN_ESP=1` is the value the feature shipped with; it arms
      // nothing, so the panel must not report it as configured.
      const entry = find({ SENDING_DOMAIN_ESP: '1', SENDING_DOMAIN_SPF_INCLUDE: 'spf.jeeta.example' });
      expect(entry!.missing).toEqual(['SENDING_DOMAIN_ESP']);
    });

    it('stays inert for the placeholder SPF include, which authorises nobody', () => {
      const entry = find({ SENDING_DOMAIN_ESP: 'postmark', SENDING_DOMAIN_SPF_INCLUDE: 'spf.platform.example' });
      expect(entry!.missing).toEqual(['SENDING_DOMAIN_SPF_INCLUDE']);
    });

    it('drops off the list once the gate is genuinely armed', () => {
      expect(find({ SENDING_DOMAIN_ESP: 'postmark', SENDING_DOMAIN_SPF_INCLUDE: 'spf.jeeta.example' })).toBeUndefined();
    });
  });
});

describe('breaches — the Gmail/Yahoo thresholds, evaluated once', () => {
  const base = {
    send: {
      attempted: 100,
      sent: 100,
      failedPermanent: 0,
      failedTransient: 0,
      bounced: 0,
      complained: 0,
      failureRate: 0,
      bounceRate: 0,
      complaintRate: 0,
    },
    inbound: { quarantined: 0 },
    mailboxes: [] as any[],
  } as any;

  it('says nothing about a healthy workspace', () => {
    expect(breaches(base, NOW)).toEqual([]);
  });

  it('raises one send-failure alert, not one per failed row', () => {
    const snap = {
      ...base,
      send: { ...base.send, attempted: 100, sent: 70, failedPermanent: 30, failureRate: 0.3 },
    };
    const out = breaches(snap, NOW);
    expect(out.map((a) => a.kind)).toEqual(['SEND_FAILURE_RATE']);
    expect(out[0].detail).toMatchObject({ attempted: 100, failed: 30 });
  });

  it('ignores a high failure rate on a sample too small to mean anything', () => {
    const snap = {
      ...base,
      send: { ...base.send, attempted: 4, sent: 1, failedPermanent: 3, failureRate: 0.75 },
    };
    expect(breaches(snap, NOW)).toEqual([]);
  });

  it('raises bounce and complaint separately at the published ceilings', () => {
    const snap = {
      ...base,
      send: { ...base.send, bounced: 6, complained: 1, bounceRate: 0.06, complaintRate: 0.01 },
    };
    expect(breaches(snap, NOW).map((a) => a.kind).sort()).toEqual([
      'BOUNCE_RATE',
      'COMPLAINT_RATE',
    ]);
  });

  it('raises RECEIVE_DOWN only after the mailbox has been down for two hours', () => {
    const justNow = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const longAgo = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString();
    const fresh = {
      ...base,
      mailboxes: [{ channelId: 'ch-1', name: 'Inbox', receiveOk: false, receiveSince: justNow }],
    };
    expect(breaches(fresh, NOW)).toEqual([]);

    const stale = {
      ...base,
      mailboxes: [{ channelId: 'ch-1', name: 'Inbox', receiveOk: false, receiveSince: longAgo }],
    };
    expect(breaches(stale, NOW).map((a) => a.kind)).toEqual(['RECEIVE_DOWN']);
  });

  it('raises one inbound alert for any quarantined mail at all', () => {
    const snap = { ...base, inbound: { quarantined: 7 } };
    const out = breaches(snap, NOW);
    expect(out.map((a) => a.kind)).toEqual(['INBOUND_QUARANTINED']);
    expect(out[0].detail).toMatchObject({ count: 7 });
    expect(MAIL_ALERT_THRESHOLDS.bounceRate).toBe(0.05);
  });
});

describe('MailOpsService.snapshot', () => {
  it('scopes every read to the workspace it was asked about', async () => {
    const { svc, prisma } = build();
    await svc.snapshot(WS, { since: new Date(NOW.getTime() - 86_400_000), until: NOW });

    for (const call of [
      ...prisma.mailLog.groupBy.mock.calls,
      ...prisma.mailLog.count.mock.calls,
      ...prisma.emailInboundItem.groupBy.mock.calls,
      ...prisma.emailInboundItem.count.mock.calls,
      ...prisma.contactSuppression.groupBy.mock.calls,
      ...prisma.channel.findMany.mock.calls,
    ]) {
      expect(call[0].where.workspaceId).toBe(WS);
    }
  });

  it('turns the ledger rows into counts, rates and a per-class breakdown', async () => {
    const { svc, prisma } = build();
    prisma.mailLog.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.[0] === 'mailClass') {
        return counted([
          { mailClass: 'BULK', status: 'SENT', _n: 80 },
          { mailClass: 'BULK', status: 'FAILED_PERMANENT', _n: 20 },
          { mailClass: 'TRANSACTIONAL', status: 'REFUSED', _n: 5 },
        ]);
      }
      return counted([{ reason: 'SUPPRESSED_BOUNCE', _n: 5 }]);
    });
    prisma.mailLog.count.mockImplementation(async (args: any) =>
      args.where.bouncedAt ? 6 : args.where.complainedAt ? 1 : 0,
    );

    const snap = await svc.snapshot(WS, { since: new Date(0), until: NOW });

    expect(snap.send).toMatchObject({
      total: 105,
      sent: 80,
      refused: 5,
      failedPermanent: 20,
      attempted: 100,
      bounced: 6,
      complained: 1,
    });
    expect(snap.send.failureRate).toBeCloseTo(0.2);
    expect(snap.send.bounceRate).toBeCloseTo(0.075);
    expect(snap.byClass.BULK).toMatchObject({ sent: 80, failed: 20, refused: 0 });
    expect(snap.send.topReasons).toEqual([{ reason: 'SUPPRESSED_BOUNCE', count: 5 }]);
  });

  it('reports the standing quarantine, not only the window, because a parked mail stays parked', async () => {
    const { svc, prisma } = build();
    prisma.emailInboundItem.groupBy.mockResolvedValue(
      counted([
        { state: 'DONE', _n: 40 },
        { state: 'SKIPPED', _n: 3 },
      ]),
    );
    prisma.emailInboundItem.count.mockResolvedValue(2);

    const snap = await svc.snapshot(WS, { since: NOW, until: NOW });

    expect(snap.inbound).toMatchObject({ done: 40, skipped: 3, quarantined: 2 });
    const [quarantineCall] = prisma.emailInboundItem.count.mock.calls;
    expect(quarantineCall[0].where.updatedAt).toBeUndefined();
  });

  it('renders each mailbox as two lanes plus its parked count', async () => {
    const { svc, prisma } = build();
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'ch-1',
        name: 'Destek',
        externalId: 'destek@acme.com',
        lastVerifiedAt: new Date('2026-09-20T00:00:00.000Z'),
        configPublic: {
          health: {
            send: { ok: true, lastOkAt: '2026-09-22T10:00:00.000Z' },
            receive: { ok: false, since: '2026-09-22T08:00:00.000Z', reason: 'AUTH_FAILED', lastError: 'AUTHENTICATIONFAILED' },
            oauthReauthRequiredAt: '2026-09-22T09:00:00.000Z',
          },
        },
      },
    ]);
    prisma.emailInboundItem.groupBy.mockImplementation(async (args: any) =>
      args.by?.[0] === 'channelId' ? counted([{ channelId: 'ch-1', _n: 3 }]) : [],
    );

    const snap = await svc.snapshot(WS, { since: new Date(0), until: NOW });

    expect(snap.mailboxes).toEqual([
      expect.objectContaining({
        channelId: 'ch-1',
        name: 'Destek',
        address: 'destek@acme.com',
        verified: true,
        sendOk: true,
        receiveOk: false,
        receiveReason: 'AUTH_FAILED',
        receiveSince: '2026-09-22T08:00:00.000Z',
        reauthRequiredAt: '2026-09-22T09:00:00.000Z',
        quarantined: 3,
      }),
    ]);
  });

  it('reads `settings.email.paused` and defaults an absent one to not paused', async () => {
    const { svc, prisma } = build();
    expect((await svc.snapshot(WS, { since: NOW })).paused).toBe(false);
    prisma.workspace.findFirst.mockResolvedValue({ settings: { email: { paused: true } } });
    expect((await svc.snapshot(WS, { since: NOW })).paused).toBe(true);
  });

  it('answers with zeros and `partial` instead of throwing when the database is down', async () => {
    const { svc, prisma } = build();
    prisma.mailLog.groupBy.mockRejectedValue(new Error('P2024 pool timeout'));
    prisma.channel.findMany.mockRejectedValue(new Error('P2024 pool timeout'));

    const snap = await svc.snapshot(WS, { since: NOW });

    expect(snap.partial).toBe(true);
    expect(snap.send.total).toBe(0);
    expect(snap.mailboxes).toEqual([]);
  });
});

describe('MailOpsService.health — the tenant card', () => {
  it('names the sender, the degradation, the cap and the inert features, and no secret', async () => {
    const { svc } = build();
    const report = await svc.health(WS, { env: {}, now: NOW });

    expect(report.identity).toEqual({
      transport: 'PLATFORM',
      fromEmail: 'admin@jeetagrowth.com',
      fromName: 'Acme via Jeeta',
      replyTo: 'owner@acme.com',
      degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
    });
    expect(report.daily).toMatchObject({ limit: 1000, used: 12 });
    expect(report.inert.some((f) => f.key === 'INBOUND_WEBHOOK')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('still answers when the identity ladder itself fails', async () => {
    const { svc, identity } = build();
    identity.resolve.mockRejectedValue(new Error('no mailbox service'));
    const report = await svc.health(WS, { env: {}, now: NOW });
    expect(report.identity).toBeNull();
    expect(report.partial).toBe(true);
  });
});
