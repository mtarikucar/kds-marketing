import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  signMarketingToken,
  mockMarketingUser,
  TestApp,
} from '../utils/test-app';

/**
 * Marketing auth surface, exercised through the full pipeline
 * (ThrottlerGuard → MarketingGuard → ValidationPipe → controller). Asserts the
 * cross-cutting guarantees — input validation, fail-closed authn, and the
 * tight per-route rate limit — not the credential logic (unit-tested already).
 */
describe('Marketing auth (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  describe('POST /api/marketing/auth/login — validation', () => {
    it('400s a malformed body (ValidationPipe enforces the DTO)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/marketing/auth/login')
        .send({ email: 'not-an-email', password: '' });
      expect(res.status).toBe(400);
    });

    it('401s valid-shaped but unknown credentials (fail closed)', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue(null as never);
      const res = await request(app.getHttpServer())
        .post('/api/marketing/auth/login')
        .send({ email: 'nobody@example.com', password: 'whatever-123' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/marketing/auth/profile — authn', () => {
    it('401s without a bearer token', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/marketing/auth/profile',
      );
      expect(res.status).toBe(401);
    });

    it('401s a token whose workspace claim no longer matches the user (session revoked)', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue(
        mockMarketingUser({ workspaceId: 'ws-moved' }) as never,
      );
      const token = signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' });
      const res = await request(app.getHttpServer())
        .get('/api/marketing/auth/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('200s with a valid token for an active user', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue(
        mockMarketingUser() as never,
      );
      const token = signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' });
      const res = await request(app.getHttpServer())
        .get('/api/marketing/auth/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email: 'owner@example.com' });
    });

    it('401s an inactive user even with an otherwise valid token', async () => {
      ctx.prisma.marketingUser.findUnique.mockResolvedValue(
        mockMarketingUser({ status: 'SUSPENDED' }) as never,
      );
      const token = signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' });
      const res = await request(app.getHttpServer())
        .get('/api/marketing/auth/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  // Fresh app → fresh in-memory throttle bucket, isolated from the tests above.
  describe('Rate limiting (brute-force protection)', () => {
    let throttleCtx: TestApp;

    beforeAll(async () => {
      throttleCtx = await createTestApp();
    });
    afterAll(() => closeTestApp(throttleCtx.app));

    it('429s once the 5/min login limit is exceeded', async () => {
      throttleCtx.prisma.marketingUser.findUnique.mockResolvedValue(null as never);
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await request(throttleCtx.app.getHttpServer())
          .post('/api/marketing/auth/login')
          .send({ email: 'brute@example.com', password: 'guessing-123' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
      // No more than the configured limit of requests got through to the handler.
      expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(5);
    });
  });
});
