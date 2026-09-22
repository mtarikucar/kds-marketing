import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmailService } from '../../src/common/services/email.service';
import { MessageQuotaService } from '../../src/modules/marketing/channels/message-quota.service';
import {
  createRealDbTestApp,
  closeTestApp,
  realDbEnabled,
  signMarketingToken,
} from '../utils/test-app';

/**
 * One customer, carried from a quote to a paid invoice BY EMAIL, against REAL
 * Postgres:
 *
 *   quote → emailed → accepted → converted → invoice emailed → paid
 *
 * Every step is a real HTTP request through the production pipeline, and every
 * assertion reads the rows back. The mocked suites prove each service in
 * isolation; this is the one that proves they add up to a sale — that the money
 * documents actually REACH the customer (the gap that existed until
 * DocumentEmailService: `send()` only moved a status and handed the link back to
 * a screen that put it on the clipboard), and that each step leaves a trace on
 * the person, which is what makes a paid customer distinguishable from one who
 * never replied.
 *
 * Two seams are cut, neither of them the subject of this test:
 *   - EmailService, so no mail leaves the building. It is the interception
 *     point rather than the channel adapter because no workspace mailbox is
 *     seeded, so delivery deliberately falls through to the platform transport.
 *   - MessageQuotaService, so a metering rule change cannot turn this journey
 *     red for a reason that has nothing to do with the journey.
 *
 * Opt-in via E2E_REAL_DB=1 — skipped (with the whole describe) otherwise, so the
 * default DB-less e2e suite and CI are untouched.
 */
const SEED = `e2e-${randomUUID().slice(0, 8)}`;
const BASE = 'https://mail-journey.test';
const CUSTOMER_EMAIL = `buyer-${SEED}@example.com`;

const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Email journey — quote to paid invoice, real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const workspaceId = randomUUID();
  const packageId = randomUUID();
  const ownerId = randomUUID();
  let leadId: string;
  let estimateId: string;
  let invoiceId: string;

  /** Every message the platform transport was asked to send. */
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const emailStub = {
    isConfigured: () => true,
    sendPlainEmail: jest.fn(async (to: string, subject: string, body: string) => {
      sent.push({ to, subject, body });
      return true;
    }),
    sendCampaignEmail: jest.fn(async () => true),
    consumeLastPlainSendError: jest.fn(() => null),
    // The gateway dispatches through the `*Result` variants, not the boolean
    // ones: a stub that only implements the old names makes the platform
    // transport call `undefined` and the whole journey answers NOT_CONFIGURED.
    sendPlainEmailResult: jest.fn(async (to: string, subject: string, body: string) => {
      sent.push({ to, subject, body });
      return { ok: true, messageId: `e2e-${sent.length}` };
    }),
    sendCampaignEmailResult: jest.fn(async (to: string, subject: string, text: string) => {
      sent.push({ to, subject, body: text });
      return { ok: true, messageId: `e2e-${sent.length}` };
    }),
    sendPlainEmailWithIcsResult: jest.fn(async (to: string, subject: string, body: string) => {
      sent.push({ to, subject, body });
      return { ok: true, messageId: `e2e-${sent.length}` };
    }),
  };
  const quotaStub = {
    reserve: jest.fn(async () => undefined),
    refund: jest.fn(async () => undefined),
  };

  const auth = () =>
    `Bearer ${signMarketingToken({ sub: ownerId, wsp: workspaceId, role: 'OWNER' })}`;

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    // The public quote/pay links are built from this; DocumentEmailService
    // refuses to send without one rather than mail a dead link.
    process.env.PUBLIC_BASE_URL = BASE;
    // SenderIdentityService resolves the platform From from these; both are
    // unset in the test env, and without one the gateway refuses every send as
    // NOT_CONFIGURED before a transport is ever reached.
    process.env.EMAIL_FROM = 'no-reply@mail-journey.test';

    ({ app, prisma } = await createRealDbTestApp((builder) => {
      builder.overrideProvider(EmailService).useValue(emailStub);
      builder.overrideProvider(MessageQuotaService).useValue(quotaStub);
    }));

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: SEED,
        name: 'Acme Email E2E',
        productName: 'Acme POS',
        status: 'ACTIVE',
      },
    });

    // `invoicing` is a FeatureGuard gate on the invoices controller — without it
    // every invoice request 403s before any of this journey is exercised.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `PKG-${SEED}`,
        name: 'E2E Plan',
        dailyLeadQuota: 100,
        maxUsers: 50,
        maxResearchProfiles: 10,
        features: { invoicing: true },
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

    await prisma.marketingUser.createMany({
      data: [
        {
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
        {
          // CommerceTraceService attributes a commerce row to this sentinel when
          // nobody clicked — the customer paying is not a colleague acting.
          id: randomUUID(),
          workspaceId,
          email: `system-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'System',
          lastName: 'Sentinel',
          role: 'SYSTEM',
          status: 'ACTIVE',
          tokenVersion: 0,
        },
      ],
    });
    await prisma.workspaceMembership.create({
      data: { userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
    });

    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        businessName: 'Bella Trattoria',
        contactPerson: 'Bella',
        businessType: 'RESTAURANT',
        source: 'EMAIL',
        status: 'NEW',
        email: CUSTOMER_EMAIL,
      },
      select: { id: true },
    });
    leadId = lead.id;
  });

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
      await del(() => prisma.invoice.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.estimate.deleteMany({ where: { workspaceId } }));
      // Lead→LeadActivity cascades, which clears the Restrict FK to the SYSTEM user.
      await del(() => prisma.lead.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.outboxEvent.deleteMany({ where: { tenantId: workspaceId } }));
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workspaceMembership.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: workspaceId } }));
    } finally {
      await closeTestApp(app);
    }
  });

  it('1) quotes the customer', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/estimates')
      .set('Authorization', auth())
      .send({
        leadId,
        currency: 'TRY',
        items: [{ description: 'Online ordering — setup', qty: 1, unitPrice: 250000 }],
      });

    expect(res.status).toBe(201);
    estimateId = res.body.id;
    expect(res.body.status).toBe('DRAFT');
  });

  it('2) emails the quote to the customer — the step that used to be missing', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/estimates/${estimateId}/email`)
      .set('Authorization', auth());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent: true, to: CUSTOMER_EMAIL, via: 'platform' });

    // A real message, carrying the public accept/decline page.
    const mail = sent.find((m) => m.to === CUSTOMER_EMAIL);
    expect(mail?.body).toContain(`${BASE}/api/public/e/`);

    // …and the quote really moved, in the database.
    const row = await prisma.estimate.findFirst({
      where: { id: estimateId, workspaceId },
      select: { status: true },
    });
    expect(row?.status).toBe('SENT');
  });

  it('3) leaves the emailed quote on the person, not only in a mailbox', async () => {
    const activity = await prisma.leadActivity.findFirst({
      where: { leadId, type: 'COMMERCE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(activity?.title).toMatch(/Quote .* emailed/);
    expect(activity?.metadata).toMatchObject({ kind: 'commerce', event: 'quote_sent' });
  });

  it('4) the customer accepts, and the quote becomes an invoice', async () => {
    const accept = await request(app.getHttpServer())
      .post(`/api/marketing/estimates/${estimateId}/accept`)
      .set('Authorization', auth());
    expect(accept.status).toBe(201);

    const convert = await request(app.getHttpServer())
      .post(`/api/marketing/estimates/${estimateId}/convert`)
      .set('Authorization', auth());
    expect(convert.status).toBe(201);
    invoiceId = convert.body.id;
    expect(invoiceId).toBeTruthy();
  });

  it('5) emails the invoice, carrying the pay link', async () => {
    const before = sent.length;
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/invoices/${invoiceId}/email`)
      .set('Authorization', auth());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent: true, to: CUSTOMER_EMAIL });
    expect(sent.length).toBe(before + 1);
    expect(sent[sent.length - 1].body).toContain(`${BASE}/api/public/i/`);

    const row = await prisma.invoice.findFirst({
      where: { id: invoiceId, workspaceId },
      select: { status: true },
    });
    expect(row?.status).toBe('SENT');
  });

  it('6) the customer pays, and the sale is recorded exactly once', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/invoices/${invoiceId}/mark-paid`)
      .set('Authorization', auth());
    expect(res.status).toBe(201);

    const row = await prisma.invoice.findFirst({
      where: { id: invoiceId, workspaceId },
      select: { status: true, paidAt: true },
    });
    expect(row?.status).toBe('PAID');
    expect(row?.paidAt).toBeTruthy();

    // The settle path claims the flip conditionally and appends the event INSIDE
    // that transaction, so a paid invoice emits exactly one of these.
    const paid = await prisma.outboxEvent.findMany({
      where: { type: 'marketing.invoice.paid.v1', idempotencyKey: `invoice-paid:${invoiceId}` },
      select: { id: true },
    });
    expect(paid).toHaveLength(1);
  });

  it('7) refuses to email a resolved quote rather than mailing a dead offer', async () => {
    // The quote was accepted in step 4; emailing it again would invite the
    // customer to answer a question they have already answered.
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/estimates/${estimateId}/email`)
      .set('Authorization', auth());
    expect(res.status).toBe(400);
  });

  it('8) refuses to email a PAID invoice', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/invoices/${invoiceId}/email`)
      .set('Authorization', auth());
    expect(res.status).toBe(400);
  });
});
