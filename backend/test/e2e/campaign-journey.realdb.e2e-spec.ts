import { randomBytes, randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmailService } from '../../src/common/services/email.service';
import { MessageQuotaService } from '../../src/modules/marketing/channels/message-quota.service';
import { ScheduledJobRunnerService } from '../../src/modules/marketing/scheduling/scheduled-job-runner.service';
import { t } from '../../src/common/i18n/mail-copy';
import {
  createRealDbTestApp,
  closeTestApp,
  realDbEnabled,
  signMarketingToken,
} from '../utils/test-app';

/**
 * One bulk journey, against REAL Postgres:
 *
 *   launch → batch → open pixel → tracked click → GET unsubscribe (no effect)
 *   → POST unsubscribe → POST again → the next campaign skips the address
 *
 * The mocked suites already prove each rule in isolation. This lane exists for
 * the four seams that only a database can answer (`campaign-e2e-test`):
 *
 *   - `bump()` is `$executeRawUnsafe` + `jsonb_set` with `$1` in two positions.
 *     Nothing but Postgres evaluates that, so "opens stopped counting" could
 *     ship green through every unit test in the repo.
 *   - the footer the sender mints and the form action the controller renders
 *     are two hardcoded strings in two files; only a real request through the
 *     real `api` prefix proves they are the same URL.
 *   - `recomputeStats` is a `groupBy` over the recipient rows, and the audience
 *     freeze is a Prisma `where` with four reachability predicates.
 *   - an opt-out is decided for the ADDRESS: the projection walks every lead
 *     that shares it, in one transaction, and the `contact_suppressions` row is
 *     upserted on a four-column key whose uniqueness only Postgres enforces.
 *
 * Two seams are cut, neither of them the subject of this test:
 *   - EmailService, so no mail leaves the building. It is cut at the platform
 *     transport rather than at the gateway on purpose: everything above it —
 *     the gate, the ledger row, the composed footer — is what we are testing.
 *   - MessageQuotaService, so a metering rule change cannot turn this journey
 *     red for a reason that has nothing to do with the journey.
 *
 * The send itself is job-driven, so the runner is ticked by hand rather than
 * waited on (see `drainJobs`) — the scheduler is left exactly as it ships.
 *
 * Opt-in via E2E_REAL_DB=1 — skipped (with the whole describe) otherwise, so
 * the default DB-less e2e suite and CI are untouched.
 */
const SEED = `e2e-${randomUUID().slice(0, 8)}`;
const BASE = 'https://campaign-journey.test';
/** The one campaign-authored link, so the tracked rewrite has index 0. */
const LINK = 'https://acme.example.com/menu';
/** A browser, not a scanner: the deny-list must not fire on a real reader. */
const READER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
/**
 * Everything a browser sends when a person clicks a link — a top-level
 * navigation, from the browser or from the webview inside the mail app. The
 * click classifier (`isAutomatedFetch`) reads this shape, not just the UA.
 */
const BROWSER_CLICK = {
  'User-Agent': READER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
};

const SUBSCRIBER = `bulk-${SEED}@example.com`;

/** What this lane changes about the environment, and therefore puts back. */
const TOUCHED_ENV = ['PUBLIC_BASE_URL', 'LINK_BASE_URL', 'EMAIL_FROM', 'MARKETING_SECRET_KEY'] as const;

const describeRealDb = realDbEnabled() ? describe : describe.skip;

/** Captured platform send. */
interface SentMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  unsubUrl?: string;
}

describeRealDb('Campaign journey — launch to opt-out, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let runner: ScheduledJobRunnerService;

  const workspaceId = randomUUID();
  const packageId = randomUUID();
  const ownerId = randomUUID();

  /** The audience, by the reason each lead is (or is not) in it. */
  const leads: Record<'subscriber' | 'duplicate' | 'colleague' | 'optedOut' | 'invalid' | 'bounced', string> =
    {} as any;

  let campaignId: string;
  let secondCampaignId: string;
  /** The clicking recipient's own token — the one in every tracked URL below. */
  let token: string;

  const priorEnv: Record<string, string | undefined> = {};

  const sent: SentMail[] = [];
  const emailStub = {
    isConfigured: () => true,
    consumeLastPlainSendError: jest.fn(() => null),
    sendPlainEmail: jest.fn(async () => true),
    sendCampaignEmail: jest.fn(async () => true),
    // The gateway dispatches through the `*Result` variants. A stub that only
    // implements the boolean names makes the platform transport call
    // `undefined` and every send answers NOT_CONFIGURED.
    sendPlainEmailResult: jest.fn(
      async (to: string, subject: string, text: string, _from?: unknown, unsubUrl?: string) => {
        sent.push({ to, subject, text, ...(unsubUrl ? { unsubUrl } : {}) });
        return { ok: true, messageId: `e2e-${sent.length}` };
      },
    ),
    sendCampaignEmailResult: jest.fn(
      async (
        to: string,
        subject: string,
        text: string,
        html?: string,
        _from?: unknown,
        unsubUrl?: string,
      ) => {
        sent.push({ to, subject, text, ...(html ? { html } : {}), ...(unsubUrl ? { unsubUrl } : {}) });
        return { ok: true, messageId: `e2e-${sent.length}` };
      },
    ),
    sendPlainEmailWithIcsResult: jest.fn(async (to: string, subject: string, text: string) => {
      sent.push({ to, subject, text });
      return { ok: true, messageId: `e2e-${sent.length}` };
    }),
  };
  const quotaStub = {
    reserve: jest.fn(async () => undefined),
    refund: jest.fn(async () => undefined),
  };

  const auth = () =>
    `Bearer ${signMarketingToken({ sub: ownerId, wsp: workspaceId, role: 'OWNER' })}`;

  /** The campaign's stats blob, read back out of Postgres. */
  const stats = async (id = campaignId): Promise<Record<string, unknown>> => {
    const row = await prisma.campaign.findUnique({ where: { id }, select: { stats: true } });
    return (row?.stats ?? {}) as Record<string, unknown>;
  };

  const recipientOf = (leadId: string, id = campaignId) =>
    prisma.campaignRecipient.findFirst({ where: { workspaceId, campaignId: id, leadId } });

  const leadRow = (id: string) =>
    prisma.lead.findFirst({
      where: { id, workspaceId },
      select: { emailOptOut: true, emailNormalized: true },
    });

  /**
   * Run the queued `campaign.batch` job the way the minute cron would, until
   * the audience is settled.
   *
   * A loop rather than one call, because the real minute cron is running in
   * this process too: its tick holds the runner's in-process overlap guard, and
   * a single hand-driven tick that landed inside one would be a silent no-op
   * and a flaky suite. Whoever gets there first is fine — the loop asks the
   * rows, not the runner.
   */
  const drainJobs = async (id = campaignId): Promise<void> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const unsettled = await prisma.campaignRecipient.count({
        where: { workspaceId, campaignId: id, status: { in: ['PENDING', 'SENDING'] } },
      });
      if (unsettled === 0) return;
      await runner.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`campaign ${id} never drained its audience`);
  };

  /** How many times `needle` occurs in `hay` — a second footer is a defect. */
  const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

  /**
   * RFC 8058 asks for a success status on the one-click POST, not for one
   * particular code — a 5xx is what makes Gmail and Yahoo redeliver. The range
   * is the contract; the exact code is Nest's POST default and nothing a
   * provider distinguishes.
   */
  const expectSuccess = (status: number): void => {
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  };

  const seedLead = (email: string | null, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: {
        workspaceId,
        businessName: `Acme ${randomUUID().slice(0, 4)}`,
        contactPerson: 'Bella',
        businessType: 'RESTAURANT',
        source: 'EMAIL',
        status: 'NEW',
        email,
        // Written by hand because the lead is created through Prisma rather
        // than through MarketingLeadsService: the address projection and the
        // audience filter both key on this column, so a null here would make
        // the whole opt-out half of this lane pass vacuously.
        emailNormalized: email ? email.trim().toLowerCase() : null,
        ...extra,
      },
      select: { id: true },
    });

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    // Every key this lane sets is restored in afterAll: e2e files share one
    // process, and a leaked PUBLIC_BASE_URL or pepper changes what the NEXT
    // suite boots against.
    for (const key of TOUCHED_ENV) priorEnv[key] = process.env[key];
    // Without this the sender emits no footer, no pixel and no tracked links
    // at all, and every assertion below would pass against an empty string.
    process.env.PUBLIC_BASE_URL = BASE;
    // The bulk link host defaults to PUBLIC_BASE_URL; an ambient override
    // would make the minted URLs and the asserted ones disagree.
    delete process.env.LINK_BASE_URL;
    // SenderIdentityService resolves the platform From from this; without one
    // the gateway refuses every send as NOT_CONFIGURED before a transport is
    // ever reached.
    process.env.EMAIL_FROM = 'no-reply@campaign-journey.test';
    // The `contact_suppressions` pepper. Absent, the table is skipped and the
    // opt-out is carried by the lead flags alone — which is the fallback, not
    // the path this lane is here to prove. 32 raw bytes, because the same key
    // is the AES-GCM sealing key everywhere else in the product.
    process.env.MARKETING_SECRET_KEY = randomBytes(32).toString('base64');

    ({ app, prisma } = await createRealDbTestApp((builder) => {
      builder.overrideProvider(EmailService).useValue(emailStub);
      builder.overrideProvider(MessageQuotaService).useValue(quotaStub);
    }));
    runner = app.get(ScheduledJobRunnerService);
    // Park the minute cron and drive the runner by hand. The scheduler is real
    // and running in this process, so a tick that landed between a launch and
    // the assertion that reads the frozen rows back would send the audience
    // early and red the lane for a reason that is not a defect. `drainJobs`
    // still loops, so a rename here degrades to the slower path rather than
    // silently leaving the suite racing the clock.
    try {
      app.get(SchedulerRegistry).getCronJob('scheduled-job-runner').stop();
    } catch {
      /* the cron is named elsewhere or already gone — drainJobs copes */
    }

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: SEED,
        name: 'Acme Campaign E2E',
        productName: 'Acme POS',
        status: 'ACTIVE',
        defaultLanguage: 'tr',
      },
    });

    // `campaigns` is a FeatureGuard gate on the whole campaigns controller —
    // without it every request in this lane 403s before anything is exercised.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `PKG-${SEED}`,
        name: 'E2E Plan',
        dailyLeadQuota: 100,
        maxUsers: 50,
        maxResearchProfiles: 10,
        features: { campaigns: true },
        limits: {},
        priceMonthlyTRY: 0,
        priceMonthlyUSD: 0,
      },
    });
    const now = new Date();
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId,
        packageId,
        status: 'ACTIVE',
        currency: 'USD',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      },
    });

    await prisma.marketingUser.create({
      data: {
        id: ownerId,
        workspaceId,
        email: `owner-${SEED}@example.com`,
        password: 'seed-not-a-real-hash',
        firstName: 'Olive',
        lastName: 'Owner',
        role: 'OWNER',
        status: 'ACTIVE',
        tokenVersion: 0,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
    });

    // The audience, and the three shapes that must never be in it.
    leads.subscriber = (await seedLead(SUBSCRIBER)).id;
    // The SAME person, on file twice — the whole reason an opt-out is decided
    // for the address rather than for the row that was clicked.
    leads.duplicate = (await seedLead(SUBSCRIBER.toUpperCase())).id;
    leads.colleague = (await seedLead(`colleague-${SEED}@example.com`)).id;
    leads.optedOut = (await seedLead(`gone-${SEED}@example.com`, { emailOptOut: true })).id;
    leads.invalid = (await seedLead(`typo-${SEED}@example.com`, { emailVerifiedStatus: 'INVALID' })).id;
    leads.bounced = (
      await seedLead(`dead-${SEED}@example.com`, { emailBouncedAt: new Date('2026-01-02T03:04:05Z') })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      await del(() => prisma.campaignRecipient.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.campaign.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.mailLog.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.contactSuppression.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.consentRecord.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.scheduledJob.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingNotification.deleteMany({ where: { workspaceId } }));
      // The workspace's own daily mail budget. The deployment-wide sentinel row
      // this service also bumps (`__platform__`) is deliberately left alone: it
      // is a shared counter, not a fixture of ours, and zeroing it would hand
      // the next tenant on this database a budget that has already been spent.
      await del(() => prisma.usageCounter.deleteMany({ where: { workspaceId } }));
      // Lead→LeadActivity cascades, which clears the trace rows the gateway
      // wrote onto each person.
      await del(() => prisma.lead.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.outboxEvent.deleteMany({ where: { tenantId: workspaceId } }));
      // The engagement events the tracker raises carry `tenantId: null` (they
      // are consumed by the workflow engine, not by a tenant subscriber), so
      // the clause above cannot see them. Their idempotency key is
      // `<workspaceId>:<type>:<subject>`, which is ours and nobody else's.
      await del(() =>
        prisma.outboxEvent.deleteMany({ where: { idempotencyKey: { startsWith: `${workspaceId}:` } } }),
      );
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workspaceMembership.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: workspaceId } }));
    } finally {
      await closeTestApp(app);
      for (const key of TOUCHED_ENV) {
        if (priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
      }
    }
  }, 60_000);

  it('1) freezes an audience of the leads that can actually receive mail', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/marketing/campaigns')
      .set('Authorization', auth())
      .send({
        name: `Spring menu ${SEED}`,
        channel: 'EMAIL',
        subject: 'Yeni menümüz yayında',
        body: `Merhaba, yeni menümüze bakın: ${LINK}`,
        bodyHtml: `<html><body><p>Merhaba</p><p><a href="${LINK}">Menü</a></p></body></html>`,
      });
    expect(created.status).toBe(201);
    campaignId = created.body.id;

    const launched = await request(app.getHttpServer())
      .post(`/api/marketing/campaigns/${campaignId}/launch`)
      .set('Authorization', auth());
    expect(launched.status).toBe(201);

    // Three reachable leads. The opted-out, the INVALID and the hard-bounced
    // one are excluded by `buildAudienceWhere` itself — compiled here by real
    // Prisma against real columns, which is the only place those four
    // predicates are ever evaluated together.
    expect(launched.body.recipients).toBe(3);
    // The whole counter blob starts at zero, so every number asserted further
    // down is a transition this lane caused rather than a value that was
    // already there.
    expect(await stats()).toEqual({
      recipients: 3,
      sent: 0,
      failed: 0,
      skipped: 0,
      opened: 0,
      clicked: 0,
      unsubscribed: 0,
    });

    const frozen = await prisma.campaignRecipient.findMany({
      where: { workspaceId, campaignId },
      select: { leadId: true, status: true, channel: true, token: true },
    });
    expect(frozen.map((r) => r.leadId).sort()).toEqual(
      [leads.subscriber, leads.duplicate, leads.colleague].sort(),
    );
    expect(frozen.every((r) => r.status === 'PENDING' && r.channel === 'EMAIL')).toBe(true);
    token = frozen.find((r) => r.leadId === leads.subscriber)!.token;
    expect(token).toMatch(/^cr_[0-9a-f]{36}$/);
  });

  it('2) sends the whole batch through the gateway and counts it from the rows', async () => {
    sent.length = 0;
    await drainJobs();

    expect(sent).toHaveLength(3);
    expect(sent.map((m) => m.to).sort()).toEqual(
      [SUBSCRIBER, SUBSCRIBER.toUpperCase(), `colleague-${SEED}@example.com`].sort(),
    );

    const rows = await prisma.campaignRecipient.findMany({ where: { workspaceId, campaignId } });
    expect(rows.every((r) => r.status === 'SENT' && r.sentAt && r.messageId)).toBe(true);

    // `recomputeStats` is a real groupBy over those rows, not an accumulated
    // delta — so the campaign's own report has to agree with them.
    expect(await stats()).toMatchObject({ recipients: 3, sent: 3, failed: 0, skipped: 0 });
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(campaign?.status).toBe('SENT');
    expect(campaign?.completedAt).toBeTruthy();

    // The ledger the gateway opened before each dispatch. The idempotency key
    // is per recipient and the index behind it is partial-unique — a shape
    // only Postgres enforces.
    const ledger = await prisma.mailLog.findMany({
      where: { workspaceId, source: `campaign:${campaignId}` },
      select: { status: true, mailClass: true, idempotencyKey: true, messageId: true, transport: true },
    });
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.status === 'SENT' && l.mailClass === 'BULK')).toBe(true);
    expect(ledger.every((l) => l.messageId && l.transport === 'PLATFORM')).toBe(true);
    expect(ledger.map((l) => l.idempotencyKey).sort()).toEqual(
      rows.map((r) => `campaign:${r.id}`).sort(),
    );
  });

  it('3) gives every recipient their own tracked link, pixel and ONE unsubscribe footer', async () => {
    const mail = sent.find((m) => m.to === SUBSCRIBER)!;
    const unsub = `${BASE}/api/public/u/${token}`;

    expect(mail.html).toContain(`${BASE}/api/public/t/c/${token}?i=0`);
    expect(mail.html).toContain(`${BASE}/api/public/t/o/${token}`);
    // The campaign-authored destination is gone from the wire: an untracked
    // href here is a click that would never be counted.
    expect(mail.html).not.toContain(`href="${LINK}"`);
    expect(mail.text).toContain(`${BASE}/api/public/t/c/${token}?i=0`);

    // The sender rendered the footer, so the gateway must recognise it and not
    // append a second one.
    expect(occurrences(mail.html!, unsub)).toBe(1);
    expect(occurrences(mail.text, unsub)).toBe(1);
    // …and the RFC 8058 header URI is that same link, not a second one.
    expect(mail.unsubUrl).toBe(unsub);

    // Each recipient's token is their own: one person's opt-out cannot be
    // another's.
    const tokens = new Set(sent.map((m) => m.text.match(/\/api\/public\/u\/(cr_[0-9a-f]+)/)![1]));
    expect(tokens.size).toBe(3);
  });

  it('4) counts an open exactly once, through the raw jsonb_set bump', async () => {
    // A hit inside PREFETCH_WINDOW_MS of the send is a delivery-time scanner,
    // not a reader. The batch above finished milliseconds ago, so move the send
    // back to when a person could plausibly have opened it.
    await prisma.campaignRecipient.updateMany({
      where: { workspaceId, campaignId },
      data: { sentAt: new Date(Date.now() - 10 * 60_000) },
    });

    // The mail-security gateway that detonates every link on delivery still
    // gets its image — a broken picture in an inbox is worse than a missed
    // open — but it is not a reader, and it must not spend this recipient's
    // one open either (the row is deliberately left unstamped).
    const scanned = await request(app.getHttpServer())
      .get(`/api/public/t/o/${token}`)
      .set('User-Agent', 'Mozilla/5.0 (compatible; Mimecast Link Protection)');
    expect(scanned.status).toBe(200);
    expect(await stats()).toMatchObject({ opened: 0 });

    const pixel = await request(app.getHttpServer())
      .get(`/api/public/t/o/${token}`)
      .set('User-Agent', READER_UA);
    expect(pixel.status).toBe(200);
    expect(pixel.headers['content-type']).toBe('image/gif');

    // A mail client that renders the message twice is one open.
    await request(app.getHttpServer()).get(`/api/public/t/o/${token}`).set('User-Agent', READER_UA);

    expect(await stats()).toMatchObject({ opened: 1 });
    const row = await recipientOf(leads.subscriber);
    expect(row?.openedAt).toBeTruthy();
  });

  it('5) redirects a click to the campaign-authored URL and counts it once', async () => {
    // A person's click is a top-level navigation. A bare User-Agent with no
    // Accept or Accept-Language is the shape of a script, and 5b) pins that it
    // is not counted — so the reader here must send what a browser sends.
    const click = await request(app.getHttpServer())
      .get(`/api/public/t/c/${token}?i=0`)
      .set(BROWSER_CLICK);
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe(LINK);

    await request(app.getHttpServer()).get(`/api/public/t/c/${token}?i=0`).set(BROWSER_CLICK);

    expect(await stats()).toMatchObject({ opened: 1, clicked: 1 });
    const row = await recipientOf(leads.subscriber);
    expect(row?.clickedAt).toBeTruthy();
  });

  it('5b) counts a person who clicks, and none of the machines that fetched the same link first', async () => {
    // The colleague's own token: nobody has clicked or opened it yet, so every
    // number below is a transition this test caused — whatever 5) counted on
    // the subscriber's row.
    const colleague = await recipientOf(leads.colleague);
    const url = `/api/public/t/c/${colleague!.token}?i=0`;
    const before = await stats();

    // What reaches a tracked link before the recipient does. Each one is still
    // taken to the campaign's own destination — a scanner that got an error
    // page would flag the mail — but none of them is a click.
    const machines: Array<[string, () => request.Test]> = [
      ['a HEAD probe', () => request(app.getHttpServer()).head(url).set(BROWSER_CLICK)],
      [
        'a declared prefetch',
        () => request(app.getHttpServer()).get(url).set({ ...BROWSER_CLICK, 'Sec-Purpose': 'prefetch' }),
      ],
      [
        'a non-navigation fetch',
        () => request(app.getHttpServer()).get(url).set({ ...BROWSER_CLICK, 'Sec-Fetch-Mode': 'no-cors' }),
      ],
      [
        'a named link scanner',
        () =>
          request(app.getHttpServer())
            .get(url)
            .set({ ...BROWSER_CLICK, 'User-Agent': 'Mozilla/5.0 (compatible; Mimecast Link Protection)' }),
      ],
      [
        'a script wearing a browser UA (the curl shape)',
        () => request(app.getHttpServer()).get(url).set({ 'User-Agent': READER_UA, Accept: '*/*' }),
      ],
    ];
    for (const [label, fetch] of machines) {
      const res = await fetch();
      expect({ label, status: res.status, location: res.headers.location }).toEqual({
        label,
        status: 302,
        location: LINK,
      });
    }
    expect(await stats()).toMatchObject({ clicked: before.clicked, opened: before.opened });
    expect(await recipientOf(leads.colleague)).toMatchObject({ clickedAt: null, openedAt: null });

    // Then the person.
    const click = await request(app.getHttpServer()).get(url).set(BROWSER_CLICK);
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe(LINK);
    // A double-click is one click.
    await request(app.getHttpServer()).get(url).set(BROWSER_CLICK);

    // One click, and — because a reader who blocks images still read the mail
    // to click it — one open with it (`click-not-open`).
    expect(await stats()).toMatchObject({
      clicked: (before.clicked as number) + 1,
      opened: (before.opened as number) + 1,
    });
    const row = await recipientOf(leads.colleague);
    expect(row?.clickedAt).toBeTruthy();
    expect(row?.openedAt).toBeTruthy();
  });

  it('6) lets a mail-security scanner fetch the unsubscribe link without opting anybody out', async () => {
    const page = await request(app.getHttpServer()).get(`/api/public/u/${token}`);
    expect(page.status).toBe(200);
    // The form posts back to the very URL the sender minted into the footer —
    // two hardcoded strings in two files, proven equal through the real `api`
    // prefix and the real router.
    expect(page.text).toContain(`action="/api/public/u/${token}"`);
    const unsub = `${BASE}/api/public/u/${token}`;
    expect(`${BASE}${page.text.match(/action="([^"]+)"/)![1]}`).toBe(unsub);

    expect((await leadRow(leads.subscriber))?.emailOptOut).toBe(false);
    expect(await stats()).toMatchObject({ unsubscribed: 0 });
    expect(await recipientOf(leads.subscriber).then((r) => r?.status)).toBe('SENT');
  });

  it('7) unsubscribes the ADDRESS on the POST, not just the row that was clicked', async () => {
    const res = await request(app.getHttpServer()).post(`/api/public/u/${token}`);
    expectSuccess(res.status);
    // The workspace's own language, not a raw English server string (G8).
    expect(res.text).toContain(t('tr', 'unsubscribe.done.heading'));

    // Both copies of the same person, in one transaction.
    expect((await leadRow(leads.subscriber))?.emailOptOut).toBe(true);
    expect((await leadRow(leads.duplicate))?.emailOptOut).toBe(true);
    // …and nobody else.
    expect((await leadRow(leads.colleague))?.emailOptOut).toBe(false);

    const suppressions = await prisma.contactSuppression.findMany({
      where: { workspaceId, kind: 'EMAIL', liftedAt: null },
      select: { reason: true, source: true },
    });
    expect(suppressions).toEqual([{ reason: 'OPT_OUT', source: 'unsubscribe-link' }]);

    // No opt-out flag moves without a dated, sourced consent record — one per
    // lead the projection touched.
    const withdrawals = await prisma.consentRecord.findMany({
      where: { workspaceId, type: 'MARKETING_EMAIL', granted: false },
      select: { leadId: true },
    });
    expect(withdrawals.map((c) => c.leadId).sort()).toEqual([leads.subscriber, leads.duplicate].sort());

    expect(await recipientOf(leads.subscriber).then((r) => r?.status)).toBe('UNSUBSCRIBED');
    // The duplicate was mailed under its OWN token and nobody pressed it.
    expect(await recipientOf(leads.duplicate).then((r) => r?.status)).toBe('SENT');
    expect(await stats()).toMatchObject({ unsubscribed: 1 });
    // `sent` counts the timestamp, so an opt-out must not make the campaign
    // report that it reached fewer people than it did.
    expect(await stats()).toMatchObject({ sent: 3 });
  });

  it('8) answers a redelivered one-click POST without recording it twice', async () => {
    const again = await request(app.getHttpServer()).post(`/api/public/u/${token}`);
    expectSuccess(again.status);

    expect(await stats()).toMatchObject({ unsubscribed: 1 });
    expect(
      await prisma.consentRecord.count({ where: { workspaceId, type: 'MARKETING_EMAIL', granted: false } }),
    ).toBe(2);
    expect(await prisma.contactSuppression.count({ where: { workspaceId, kind: 'EMAIL' } })).toBe(1);
    expect(await recipientOf(leads.subscriber).then((r) => r?.status)).toBe('UNSUBSCRIBED');
  });

  it('9) the next campaign skips every lead that shares the unsubscribed address', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/marketing/campaigns')
      .set('Authorization', auth())
      .send({
        name: `Summer menu ${SEED}`,
        channel: 'EMAIL',
        subject: 'Yaz menüsü',
        body: `Merhaba, yaz menümüz: ${LINK}`,
      });
    expect(created.status).toBe(201);
    secondCampaignId = created.body.id;

    const launched = await request(app.getHttpServer())
      .post(`/api/marketing/campaigns/${secondCampaignId}/launch`)
      .set('Authorization', auth());
    expect(launched.status).toBe(201);
    // Only the colleague is left: unsubscribing through ONE lead row took the
    // duplicate out of the audience too (`optout-per-lead-row`).
    expect(launched.body.recipients).toBe(1);

    const frozen = await prisma.campaignRecipient.findMany({
      where: { workspaceId, campaignId: secondCampaignId },
      select: { leadId: true },
    });
    expect(frozen.map((r) => r.leadId)).toEqual([leads.colleague]);

    sent.length = 0;
    await drainJobs(secondCampaignId);
    expect(sent.map((m) => m.to)).toEqual([`colleague-${SEED}@example.com`]);
    expect(await stats(secondCampaignId)).toMatchObject({ recipients: 1, sent: 1, failed: 0 });
  });
});
