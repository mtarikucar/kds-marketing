import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import request from 'supertest';
import { createHmac } from 'crypto';
import { EspFeedbackController } from './esp-feedback.controller';
import { EspFeedbackService } from '../channels/esp-feedback.service';
import { WebhookReplayStore } from '../channels/inbound/webhook-verifier/webhook-replay.store';

/**
 * Routing, not parsing — the part a mocked `ctrl.receive(...)` cannot prove.
 *
 * Two assumptions this locks:
 *  1. `/feedback/:provider` really resolves (and the segment reaches the
 *     handler), so adding a provider does not need a second controller.
 *  2. The raw-body parser mounted on `/api/public/esp/feedback` in
 *     `app.config.ts` covers the sub-path, because `app.use` matches by PREFIX.
 *     If it ever stops covering it, `req.body` becomes a re-serialised object,
 *     every signature over the original bytes fails, and every ESP event is
 *     lost behind a 401 — so the body below is deliberately pretty-printed:
 *     re-serialising it would change the bytes and red this spec.
 *
 * The mounts are reproduced here in the same order as `app.config.ts` rather
 * than booting the whole app, which needs the full container.
 */
describe('EspFeedbackController (routing)', () => {
  let app: NestExpressApplication;
  const suppress = jest.fn().mockResolvedValue({ suppressed: 1, failed: 0 });
  const realSecret = process.env.ESP_FEEDBACK_SECRET;
  const SECRET = 'esp-secret';

  // Pretty-printed on purpose — see the docblock.
  const body = JSON.stringify([{ email: 'dead@x.com', event: 'bounce' }], null, 2);
  const sig = () => createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');

  beforeAll(async () => {
    process.env.ESP_FEEDBACK_SECRET = SECRET;
    const mod = await Test.createTestingModule({
      controllers: [EspFeedbackController],
      providers: [{ provide: EspFeedbackService, useValue: { suppress } }, WebhookReplayStore],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.use('/api/public/esp/feedback', bodyParser.raw({ type: '*/*', limit: '2mb' }));
    app.use(bodyParser.json({ limit: '200kb' }));
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (realSecret === undefined) delete process.env.ESP_FEEDBACK_SECRET;
    else process.env.ESP_FEEDBACK_SECRET = realSecret;
  });

  beforeEach(() => suppress.mockClear());

  it('the legacy relay path still verifies over the raw bytes', async () => {
    await request(app.getHttpServer())
      .post('/api/public/esp/feedback')
      .set('content-type', 'application/json')
      .set('x-esp-signature', sig())
      .send(body)
      .expect(200);
    expect(suppress).toHaveBeenCalled();
  });

  it('the per-provider path resolves AND is covered by the raw-body mount', async () => {
    await request(app.getHttpServer())
      .post('/api/public/esp/feedback/generic')
      .set('content-type', 'application/json')
      .set('x-esp-signature', sig())
      .send(body)
      .expect(200);
    expect(suppress.mock.calls[0][0]).toEqual([{ email: 'dead@x.com', kind: 'bounce' }]);
  });

  it('404s an unknown provider rather than falling back to the generic secret', async () => {
    await request(app.getHttpServer())
      .post('/api/public/esp/feedback/brevo')
      .set('content-type', 'application/json')
      .set('x-esp-signature', sig())
      .send(body)
      .expect(404);
    expect(suppress).not.toHaveBeenCalled();
  });

  it('a provider whose key is unset answers 401, never 500', async () => {
    await request(app.getHttpServer())
      .post('/api/public/esp/feedback/sendgrid')
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);
    expect(suppress).not.toHaveBeenCalled();
  });
});

/**
 * Mailgun signs `timestamp + token` — NOT the body — so one captured signature
 * block authenticates any payload for as long as the timestamp stays fresh,
 * and SIGNATURE_MAX_AGE_MS is deliberately 24 hours so a provider's retries are
 * not lost. The token is what makes that safe, and only if WE remember it:
 * Mailgun makes it single-use on their side, which says nothing about a
 * forgery posted directly at us.
 *
 * So the rule is: one token, one body. A second request under the same token
 * carrying the SAME bytes is the provider's own redelivery and is acknowledged;
 * one carrying different bytes is a forgery and is refused.
 */
describe('EspFeedbackController — a Mailgun token is spent once', () => {
  let app: NestExpressApplication;
  const suppress = jest.fn().mockResolvedValue({ suppressed: 1, failed: 0 });
  const realKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  const KEY = 'mailgun-signing-key';

  const sign = (token: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      timestamp,
      token,
      signature: createHmac('sha256', KEY).update(timestamp + token).digest('hex'),
    };
  };
  /** A whole Mailgun body: the captured signature block plus an event. */
  const payload = (signature: any, recipient: string) =>
    JSON.stringify({ signature, 'event-data': { event: 'failed', severity: 'permanent', recipient } });

  const post = (raw: string) =>
    request(app.getHttpServer())
      .post('/api/public/esp/feedback/mailgun')
      .set('content-type', 'application/json')
      .send(raw);

  beforeAll(async () => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    const mod = await Test.createTestingModule({
      controllers: [EspFeedbackController],
      providers: [
        { provide: EspFeedbackService, useValue: { suppress } },
        WebhookReplayStore,
      ],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.use('/api/public/esp/feedback', bodyParser.raw({ type: '*/*', limit: '2mb' }));
    app.use(bodyParser.json({ limit: '200kb' }));
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (realKey === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = realKey;
  });

  beforeEach(() => suppress.mockClear());

  it('refuses a captured signature block re-used for a different recipient', async () => {
    const block = sign('tok-forge');
    await post(payload(block, 'real@customer.test')).expect(200);
    expect(suppress).toHaveBeenCalledWith([{ email: 'real@customer.test', kind: 'bounce' }]);

    suppress.mockClear();
    await post(payload(block, 'someone-elses@customer.test')).expect(401);
    expect(suppress).not.toHaveBeenCalled();
  });

  it('still acknowledges the provider’s own redelivery of the SAME bytes', async () => {
    // Mailgun retries a failed webhook for 8 hours, replaying the original
    // signed payload. A 401 there loses the event permanently.
    const raw = payload(sign('tok-retry'), 'dead@customer.test');
    await post(raw).expect(200);
    suppress.mockClear();
    await post(raw).expect(200);
    // Idempotent AND cheap: the suppression is already on file.
    expect(suppress).not.toHaveBeenCalled();
  });

  it('does not spend the token when the request failed, so the ESP can retry', async () => {
    suppress.mockResolvedValueOnce({ suppressed: 0, failed: 1 });
    const raw = payload(sign('tok-blip'), 'retryable@customer.test');
    await post(raw).expect(500);
    suppress.mockClear();
    await post(raw).expect(200);
    expect(suppress).toHaveBeenCalledWith([{ email: 'retryable@customer.test', kind: 'bounce' }]);
  });
});
