import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { hashIngestToken } from '../../src/modules/marketing/guards/ingest-token.guard';
import { CommerceSourcesService } from '../../src/modules/marketing/commerce-ingest/commerce-sources.service';
import { signCommercePayload } from '../../src/modules/marketing/commerce-ingest/commerce-signature';
import { VECTOR_BODY } from '../../src/modules/marketing/commerce-ingest/commerce-ingest.fixture';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The order webhook end to end against a REAL database (contract A2, A3, A4,
 * A8): the real app wiring (app.config.ts raw mount, guards, filter), real
 * Prisma, real unique indexes. Nothing is faked.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('commerce ingest — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let secret: string;
  const workspaceId = randomUUID();
  const token = `mkt_live_${randomBytes(24).toString('hex')}`;
  const URL = '/api/marketing/commerce/ingest/orders';
  const saved = { flag: process.env.COMMERCE_INGEST_ENABLED, key: process.env.MARKETING_SECRET_KEY };

  /** The contract body, moved to "now", with overrides. */
  const body = (over: (o: any) => void = () => undefined) => {
    const o = JSON.parse(VECTOR_BODY);
    o.occurredAt = new Date().toISOString();
    o.customer.email = `ayse+${workspaceId.slice(0, 8)}@example.com`;
    over(o);
    return JSON.stringify(o);
  };
  const send = (raw: string, s = secret) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app.getHttpServer())
      .post(URL)
      .set('content-type', 'application/json')
      .set('x-ingest-token', token)
      .set('x-jeeta-source', 'shop')
      .set('x-jeeta-timestamp', ts)
      .set('x-jeeta-signature', `v1=${signCommercePayload(s, ts, Buffer.from(raw))}`)
      .send(raw);
  };

  beforeAll(async () => {
    process.env.COMMERCE_INGEST_ENABLED = 'true';
    process.env.MARKETING_SECRET_KEY ??= randomBytes(32).toString('base64');
    ({ app, prisma } = await createRealDbTestApp());
    await prisma.workspace.create({
      data: { id: workspaceId, slug: `ci-${workspaceId.slice(0, 8)}`, name: 'Shop', productName: 'Shop', defaultCurrency: 'TRY' } as never,
    });
    await prisma.ingestToken.create({
      data: { workspaceId, label: 'e2e', tokenHash: hashIngestToken(token), tokenPrefix: token.slice(0, 13) } as never,
    });
    ({ signingSecret: secret } = await app.get(CommerceSourcesService).create(workspaceId, { slug: 'shop', kind: 'CUSTOM' }));
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.externalOrderEvent.deleteMany({ where: { workspaceId } });
      await prisma.externalOrder.deleteMany({ where: { workspaceId } });
      await prisma.commerceSource.deleteMany({ where: { workspaceId } });
      await prisma.leadAttribution.deleteMany({ where: { workspaceId } });
      await prisma.outboxEvent.deleteMany({ where: { payload: { path: ['workspaceId'], equals: workspaceId } } as never });
      await prisma.lead.deleteMany({ where: { workspaceId } });
      await prisma.ingestToken.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await closeTestApp(app);
    process.env.COMMERCE_INGEST_ENABLED = saved.flag;
    if (saved.key === undefined) delete process.env.MARKETING_SECRET_KEY;
  });

  it('records a signed order.paid: ExternalOrder PAID, a COMMERCE lead, first-touch attribution', async () => {
    const res = await send(body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: false, status: 'PAID', leadMatched: 'created' });

    const order = await prisma.externalOrder.findFirstOrThrow({ where: { workspaceId, externalId: 'FIG-7K2M9QXA' } });
    expect(order).toMatchObject({ status: 'PAID', amountMinor: 349900, currency: 'TRY', utmCampaign: 'ekim-hediye' });
    expect(order.paidAt).toBeInstanceOf(Date);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.leadId } });
    expect(lead).toMatchObject({ source: 'COMMERCE', phone: '+905321234567', contactPerson: 'Ayşe Yılmaz' });
    const attribution = await prisma.leadAttribution.findUnique({ where: { leadId: lead.id } });
    expect(attribution).toMatchObject({ utmSource: 'instagram', utmCampaign: 'ekim-hediye' });
    const events = await prisma.externalOrderEvent.findMany({ where: { workspaceId } });
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(true);
  });

  it('answers the same delivery again with 200 duplicate:true and writes nothing', async () => {
    const raw = body();
    // A redelivery is byte-identical — including occurredAt. Reuse the first
    // event's timestamp so the body hash matches what is on file.
    const first = await prisma.externalOrderEvent.findFirstOrThrow({ where: { workspaceId } });
    const same = raw.replace(/"occurredAt":"[^"]+"/, `"occurredAt":"${first.occurredAt.toISOString()}"`);
    const res = await send(same);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true, status: 'PAID' });
    expect(await prisma.externalOrderEvent.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.externalOrder.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.lead.count({ where: { workspaceId } })).toBe(1);
  });

  it('409s the same eventId with a different body', async () => {
    const res = await send(body((o) => (o.order.amountMinor = 1)));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: 'EVENT_ID_REUSED' });
  });

  it('401s a bad signature and writes nothing', async () => {
    const res = await send(body((o) => (o.eventId = 'other')), 'whsec_not_the_secret');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(await prisma.externalOrderEvent.count({ where: { workspaceId } })).toBe(1);
  });

  it('applies a cumulative refund: partial stays PAID, full becomes REFUNDED', async () => {
    const partial = await send(
      body((o) => {
        o.eventId = 'shop:order.refunded:FIG-7K2M9QXA:1';
        o.event = 'order.refunded';
        o.order.refundedMinor = 100000;
      }),
    );
    expect(partial.body).toMatchObject({ ok: true, status: 'PAID' });
    const full = await send(
      body((o) => {
        o.eventId = 'shop:order.refunded:FIG-7K2M9QXA:2';
        o.event = 'order.refunded';
        o.order.refundedMinor = 349900;
      }),
    );
    expect(full.body).toMatchObject({ ok: true, status: 'REFUNDED' });
    const order = await prisma.externalOrder.findFirstOrThrow({ where: { workspaceId } });
    expect(order.refundedMinor).toBe(349900);
  });

  it('finds the same customer again by phone on a second order (no second lead)', async () => {
    const res = await send(
      body((o) => {
        o.eventId = 'shop:order.paid:FIG-SECOND';
        o.order.externalId = 'FIG-SECOND';
        delete o.customer.email;
        o.customer.phone = '0532 123 45 67';
      }),
    );
    expect(res.body).toMatchObject({ ok: true, leadMatched: 'phone' });
    expect(await prisma.lead.count({ where: { workspaceId } })).toBe(1);
  });

  it('404s with the flag off, whatever is sent', async () => {
    process.env.COMMERCE_INGEST_ENABLED = 'false';
    try {
      const res = await send(body((o) => (o.eventId = 'flag-off')));
      expect(res.status).toBe(404);
    } finally {
      process.env.COMMERCE_INGEST_ENABLED = 'true';
    }
  });
});
