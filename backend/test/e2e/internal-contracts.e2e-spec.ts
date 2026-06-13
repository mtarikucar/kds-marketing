import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TEST_ENV,
  TestApp,
} from '../utils/test-app';
import { OutboxService } from '../../src/modules/outbox/outbox.service';

/**
 * Service-to-service surface (`/api/internal/*`). The README pins the wire
 * contract hard: every route is token-guarded, answers with a JSON envelope
 * (never an empty body), and a bad referral code is a `null` result, never an
 * error. These e2e tests lock that contract against the real guards + pipes.
 */
describe('Internal service contracts (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  const appendMock = jest.fn();

  beforeAll(async () => {
    ctx = await createTestApp((builder) => {
      // Stub the outbox so the events test asserts the HTTP contract, not the
      // durable-append internals (those have their own unit coverage).
      builder
        .overrideProvider(OutboxService)
        .useValue({ append: appendMock });
    });
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));
  beforeEach(() => appendMock.mockReset());

  const TOKEN = TEST_ENV.INTERNAL_SERVICE_TOKEN;

  describe('POST /api/internal/referral/resolve', () => {
    const url = '/api/internal/referral/resolve';

    it('401s without the internal token', async () => {
      const res = await request(app.getHttpServer()).post(url).send({ code: 'ABC' });
      expect(res.status).toBe(401);
    });

    it('401s with a wrong internal token', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', 'wrong-token')
        .send({ code: 'ABC' });
      expect(res.status).toBe(401);
    });

    it('400s a malformed body even with a valid token', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', TOKEN)
        .send({});
      expect(res.status).toBe(400);
    });

    it('resolves an unknown code to { resolved: null } (never an error)', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue(null as never);
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', TOKEN)
        .send({ code: 'UNKNOWN' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ resolved: null });
    });

    it('resolves an active marketer to its attribution envelope', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue({
        id: 'mu-7',
        referralCode: 'GOLD',
        status: 'ACTIVE',
      } as never);
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', TOKEN)
        .send({ code: 'GOLD' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        resolved: { marketingUserId: 'mu-7', referralCode: 'GOLD' },
      });
    });
  });

  describe('POST /api/internal/events', () => {
    const url = '/api/internal/events';

    it('401s without the internal token', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .send({ type: 'payment.succeeded.v1', payload: {} });
      expect(res.status).toBe(401);
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('400s a body missing the event type', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', TOKEN)
        .send({ payload: {} });
      expect(res.status).toBe(400);
    });

    it('202s a well-formed event and returns its outbox id', async () => {
      appendMock.mockResolvedValue('evt-123');
      const res = await request(app.getHttpServer())
        .post(url)
        .set('x-internal-token', TOKEN)
        .send({
          type: 'payment.succeeded.v1',
          payload: { tenantId: 't-1', paymentId: 'p-1' },
          idempotencyKey: 'payment-succeeded:p-1',
        });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ id: 'evt-123' });
      // The producer's idempotency key is forwarded verbatim (at-least-once).
      expect(appendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'payment.succeeded.v1',
          idempotencyKey: 'payment-succeeded:p-1',
        }),
      );
    });
  });
});
