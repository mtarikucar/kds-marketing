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

  /**
   * The external research routine's surface. Unlike the referral/events routes
   * this one is CROSS-WORKSPACE — a single token reads every active tenant's
   * work-list and can write leads into any of them — so these tests pin the
   * realm boundary at the wire: the route must be guarded by
   * RESEARCH_ROUTINE_TOKEN specifically, and no sibling service credential (nor
   * the sibling header name) may open it. The behavioural contract of the
   * handlers themselves lives in `internal-research.controller.spec.ts`.
   */
  describe('/api/internal/research/*', () => {
    const RESEARCH_TOKEN = TEST_ENV.RESEARCH_ROUTINE_TOKEN;
    const jobsUrl = '/api/internal/research/jobs';
    const leadsUrl = '/api/internal/research/jobs/ws-1/leads';
    const validLead = {
      externalRef: 'instagram:@biz1',
      businessName: 'Biz One',
      businessType: 'CAFE',
      painPoint: 'slow service',
      evidence: 'reviews mention waits',
      pitch: 'faster tickets',
    };

    describe('GET /jobs', () => {
      it('401s without a research token', async () => {
        const res = await request(app.getHttpServer()).get(jobsUrl);
        expect(res.status).toBe(401);
      });

      it('401s with a wrong research token', async () => {
        const res = await request(app.getHttpServer())
          .get(jobsUrl)
          .set('x-research-token', 'wrong-token');
        expect(res.status).toBe(401);
      });

      it('401s when presented the INTERNAL_SERVICE_TOKEN (separate principal)', async () => {
        const res = await request(app.getHttpServer())
          .get(jobsUrl)
          .set('x-research-token', TOKEN);
        expect(res.status).toBe(401);
      });

      it('401s when the token is sent under the sibling header name', async () => {
        const res = await request(app.getHttpServer())
          .get(jobsUrl)
          .set('x-internal-token', RESEARCH_TOKEN);
        expect(res.status).toBe(401);
      });

      it('answers the { generatedAt, jobs } envelope with a valid token', async () => {
        const res = await request(app.getHttpServer())
          .get(jobsUrl)
          .set('x-research-token', RESEARCH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.jobs).toEqual([]); // no ACTIVE workspaces in the mock DB
        expect(typeof res.body.generatedAt).toBe('string');
      });
    });

    describe('POST /jobs/:workspaceId/leads', () => {
      beforeEach(() => (ctx.prisma.lead.create as jest.Mock).mockClear());

      it('401s without a research token — and never reaches the DB', async () => {
        const res = await request(app.getHttpServer())
          .post(leadsUrl)
          .send({ profileId: 'prof-1', leads: [validLead] });
        expect(res.status).toBe(401);
        expect(ctx.prisma.lead.create).not.toHaveBeenCalled();
      });

      it('400s a body missing profileId even with a valid token', async () => {
        const res = await request(app.getHttpServer())
          .post(leadsUrl)
          .set('x-research-token', RESEARCH_TOKEN)
          .send({ leads: [validLead] });
        expect(res.status).toBe(400);
      });

      it('400s a candidate whose externalRef is off-pattern', async () => {
        const res = await request(app.getHttpServer())
          .post(leadsUrl)
          .set('x-research-token', RESEARCH_TOKEN)
          .send({
            profileId: 'prof-1',
            leads: [{ ...validLead, externalRef: 'whatever' }],
          });
        expect(res.status).toBe(400);
      });

      it('400s an unknown property (forbidNonWhitelisted — no mass assignment)', async () => {
        const res = await request(app.getHttpServer())
          .post(leadsUrl)
          .set('x-research-token', RESEARCH_TOKEN)
          .send({ profileId: 'prof-1', leads: [validLead], workspaceId: 'ws-2' });
        expect(res.status).toBe(400);
      });

      it('404s an unknown workspace and writes nothing', async () => {
        const res = await request(app.getHttpServer())
          .post(leadsUrl)
          .set('x-research-token', RESEARCH_TOKEN)
          .send({ profileId: 'prof-1', leads: [validLead] });
        expect(res.status).toBe(404);
        expect(ctx.prisma.lead.create).not.toHaveBeenCalled();
      });
    });
  });
});
