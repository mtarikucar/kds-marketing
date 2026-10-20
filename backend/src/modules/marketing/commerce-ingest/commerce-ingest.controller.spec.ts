import { Test } from '@nestjs/testing';
import { HttpException, INestApplication } from '@nestjs/common';
import bodyParser from 'body-parser';
import request from 'supertest';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { hashIngestToken } from '../guards/ingest-token.guard';
import { WebhookReplayStore } from '../channels/inbound/webhook-verifier/webhook-replay.store';
import { CommerceIngestController } from './commerce-ingest.controller';
import { CommerceIngestService } from './commerce-ingest.service';
import { CommerceSourcesService } from './commerce-sources.service';
import { signCommercePayload } from './commerce-signature';
import { VECTOR_BODY } from './commerce-ingest.fixture';

const WS = 'ws-1';
const TOKEN = 'mkt_live_good';
const SECRET = 'whsec_test_only_not_a_real_secret';
const SOURCE = { id: 'src-1', slug: 'shop' };
const URL = '/api/marketing/commerce/ingest/orders';

/** The contract body, moved to "now" so it is fresh. */
function body(over: (o: any) => void = () => undefined): string {
  const o = JSON.parse(VECTOR_BODY);
  o.occurredAt = new Date().toISOString();
  over(o);
  return JSON.stringify(o);
}

function headers(raw: string, opts: { ts?: number; secret?: string; source?: string; token?: string | null } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-jeeta-source': opts.source ?? 'shop',
    'x-jeeta-timestamp': ts,
    'x-jeeta-signature': `v1=${signCommercePayload(opts.secret ?? SECRET, ts, Buffer.from(raw))}`,
  };
  if (opts.token !== null) h['x-ingest-token'] = opts.token ?? TOKEN;
  return h;
}

describe('CommerceIngestController (contract §1.1, §1.6)', () => {
  let app: INestApplication;
  const svc = { ingest: jest.fn() };
  const sources = { resolveForVerification: jest.fn() };
  const replay = { check: jest.fn(), remember: jest.fn() };
  const prisma = {
    ingestToken: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.tokenHash === hashIngestToken(TOKEN) ? { id: 't1', workspaceId: WS, status: 'ACTIVE' } : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const savedFlag = process.env.COMMERCE_INGEST_ENABLED;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [CommerceIngestController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: CommerceIngestService, useValue: svc },
        { provide: CommerceSourcesService, useValue: sources },
        { provide: WebhookReplayStore, useValue: replay },
      ],
    }).compile();
    app = mod.createNestApplication({ bodyParser: false });
    // The same mount app.config.ts makes (see the mount spec).
    app.use('/api/marketing/commerce/ingest', bodyParser.raw({ type: '*/*', limit: '256kb' }));
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (savedFlag === undefined) delete process.env.COMMERCE_INGEST_ENABLED;
    else process.env.COMMERCE_INGEST_ENABLED = savedFlag;
  });

  beforeEach(() => {
    process.env.COMMERCE_INGEST_ENABLED = 'true';
    jest.clearAllMocks();
    sources.resolveForVerification.mockImplementation(async (ws: string, slug: string) =>
      ws === WS && slug === 'shop' ? { source: SOURCE, secrets: [SECRET] } : null,
    );
    replay.check.mockResolvedValue({ seen: false });
    replay.remember.mockResolvedValue(undefined);
    svc.ingest.mockResolvedValue({
      ok: true,
      duplicate: false,
      orderId: 'ord-1',
      status: 'PAID',
      leadId: 'lead-1',
      leadMatched: 'created',
    });
  });

  const post = (raw: string, h: Record<string, string>) => request(app.getHttpServer()).post(URL).set(h).send(raw);

  it('accepts a signed order.paid: 200, the service gets the parsed event and sha256 of the exact bytes', async () => {
    const raw = body();
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: false, orderId: 'ord-1', status: 'PAID', leadId: 'lead-1', leadMatched: 'created' });
    const hash = createHash('sha256').update(raw).digest('hex');
    expect(svc.ingest).toHaveBeenCalledWith(WS, SOURCE, expect.objectContaining({ eventId: 'figurunica:order.paid:FIG-7K2M9QXA', event: 'order.paid' }), hash);
    // Replay is keyed per source (eventId is unique only inside a source) and spent only after 2xx.
    expect(replay.check).toHaveBeenCalledWith('commerce', 'src-1:figurunica:order.paid:FIG-7K2M9QXA', hash);
    expect(replay.remember).toHaveBeenCalledWith('commerce', 'src-1:figurunica:order.paid:FIG-7K2M9QXA', hash);
  });

  it('answers a duplicate with 200 duplicate:true', async () => {
    svc.ingest.mockResolvedValue({ ok: true, duplicate: true, orderId: 'ord-1', status: 'PAID', leadId: 'lead-1' });
    const raw = body();
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  describe('401', () => {
    it.each([
      ['MISSING_INGEST_TOKEN', { token: null }],
      ['INVALID_INGEST_TOKEN', { token: 'mkt_live_wrong' }],
      ['UNKNOWN_SOURCE', { source: 'other-shop' }],
      ['UNKNOWN_SOURCE', { source: 'NOT A SLUG' }],
      ['BAD_SIGNATURE', { secret: 'whsec_someone_else' }],
      ['STALE_TIMESTAMP', { ts: Math.floor(Date.now() / 1000) - 301 }],
    ] as const)('%s', async (code, opts) => {
      const raw = body();
      const res = await post(raw, headers(raw, opts as never));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, code });
      expect(typeof res.body.message).toBe('string');
      expect(svc.ingest).not.toHaveBeenCalled();
      expect(replay.remember).not.toHaveBeenCalled();
    });

    it('keeps the guard messages the existing ingest endpoint uses', async () => {
      const raw = body();
      const res = await post(raw, headers(raw, { token: null }));
      expect(res.body.message).toBe('Missing ingest token');
    });

    it('rejects a body changed after signing', async () => {
      const raw = body();
      const h = headers(raw);
      const res = await post(raw.replace('349900', '1'), h);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('BAD_SIGNATURE');
    });
  });

  describe('400', () => {
    it.each([
      ['MALFORMED_JSON', () => '{"version":1,'],
      ['UNSUPPORTED_VERSION', () => body((o) => (o.version = 2))],
      ['VALIDATION_FAILED', () => body((o) => delete o.eventId)],
      ['VALIDATION_FAILED', () => body((o) => (o.order.amountMinor = 12.5))],
      ['VALIDATION_FAILED', () => body((o) => (o.order.currency = 'try'))],
      ['VALIDATION_FAILED', () => body((o) => (o.event = 'order.shipped'))],
      ['VALIDATION_FAILED', () => body((o) => (o.order.refundedMinor = o.order.amountMinor + 1))],
      ['VALIDATION_FAILED', () => body((o) => (o.occurredAt = new Date(Date.now() + 6 * 60_000).toISOString()))],
      ['VALIDATION_FAILED', () => body((o) => (o.order.items = Array(101).fill(o.order.items[0])))],
      // forbidNonWhitelisted, applied by hand: an unknown field is refused.
      ['VALIDATION_FAILED', () => body((o) => (o.order.discountMinor = 5))],
      ['VALIDATION_FAILED', () => body((o) => (o.extra = true))],
    ] as const)('%s', async (code, make) => {
      const raw = make();
      const res = await post(raw, headers(raw));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code });
      if (code === 'VALIDATION_FAILED') expect(Array.isArray(res.body.details)).toBe(true);
      expect(svc.ingest).not.toHaveBeenCalled();
    });
  });

  it('409 EVENT_ID_REUSED straight from the replay store, without touching the database', async () => {
    replay.check.mockResolvedValue({ seen: true, sameBody: false });
    const raw = body();
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: 'EVENT_ID_REUSED' });
    expect(svc.ingest).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'EVENT_ID_REUSED'],
    [422, 'CURRENCY_MISMATCH'],
  ])('%s %s from the service, in the same error shape', async (status, code) => {
    svc.ingest.mockRejectedValue(new HttpException({ ok: false, code, message: 'x' }, status));
    const raw = body();
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ ok: false, code, message: 'x' });
    expect(replay.remember).not.toHaveBeenCalled();
  });

  it('does not spend the replay token when the service fails (the retry must get through)', async () => {
    svc.ingest.mockRejectedValue(new Error('db down'));
    const raw = body();
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('db down');
    expect(replay.remember).not.toHaveBeenCalled();
  });

  it('404 when COMMERCE_INGEST_ENABLED is off — before the token is even looked at', async () => {
    process.env.COMMERCE_INGEST_ENABLED = 'false';
    const raw = body();
    const res = await post(raw, headers(raw, { token: null }));
    expect(res.status).toBe(404);
    expect(prisma.ingestToken.findUnique).not.toHaveBeenCalled();
    expect(svc.ingest).not.toHaveBeenCalled();
  });

  it('413 for a body over 256 kb', async () => {
    const raw = body((o) => (o.order.paymentMethod = 'x'.repeat(300 * 1024)));
    const res = await post(raw, headers(raw));
    expect(res.status).toBe(413);
    expect(svc.ingest).not.toHaveBeenCalled();
  });
});
