import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import request from 'supertest';
import { createHmac } from 'crypto';
import { EspFeedbackController } from './esp-feedback.controller';
import { EspFeedbackService } from '../channels/esp-feedback.service';

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
      providers: [{ provide: EspFeedbackService, useValue: { suppress } }],
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
