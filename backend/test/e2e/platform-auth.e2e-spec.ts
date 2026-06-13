import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Platform-operator realm auth pipeline. Mirrors the marketing-auth coverage
 * for the second human realm: DTO validation, fail-closed authn, and a guarded
 * profile route.
 */
describe('Platform auth (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  it('400s a malformed login body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/auth/login')
      .send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
  });

  it('401s unknown operator credentials (fail closed)', async () => {
    ctx.prisma.platformOperator.findUnique.mockResolvedValue(null as never);
    const res = await request(app.getHttpServer())
      .post('/api/platform/auth/login')
      .send({ email: 'operator@example.com', password: 'whatever-123' });
    expect(res.status).toBe(401);
  });

  it('401s the guarded profile route without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/platform/auth/profile');
    expect(res.status).toBe(401);
  });
});
