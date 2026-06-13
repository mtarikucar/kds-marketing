import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TEST_ENV, TestApp } from '../utils/test-app';

/**
 * The nightly research routine's surface (/api/internal/research/*). It's a
 * SEPARATE principal from the core service token — guarded by
 * RESEARCH_ROUTINE_TOKEN (x-research-token), so the internal service token must
 * NOT open it. These tests pin that isolation + the envelope.
 */
describe('Internal research routine (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  describe('auth', () => {
    it('401s GET /jobs without a research token', async () => {
      const res = await request(app.getHttpServer()).get('/api/internal/research/jobs');
      expect(res.status).toBe(401);
    });

    it('401s with a wrong research token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/internal/research/jobs')
        .set('x-research-token', 'nope');
      expect(res.status).toBe(401);
    });

    it('rejects the internal SERVICE token on the research realm (principal isolation)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/internal/research/jobs')
        .set('x-internal-token', TEST_ENV.INTERNAL_SERVICE_TOKEN);
      expect(res.status).toBe(401);
    });

    it('401s lead submission without a research token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/internal/research/jobs/ws-1/leads')
        .send({ leads: [] });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /jobs with a valid token', () => {
    it('returns the { generatedAt, jobs } envelope', async () => {
      ctx.prisma.workspace.findMany.mockResolvedValue([] as never);
      const res = await request(app.getHttpServer())
        .get('/api/internal/research/jobs')
        .set('x-research-token', TEST_ENV.RESEARCH_ROUTINE_TOKEN);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
      expect(typeof res.body.generatedAt).toBe('string');
    });
  });
});
