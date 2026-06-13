import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Locks the global error envelope (AllExceptionsFilter): every error response,
 * regardless of source, carries the Nest defaults PLUS correlation fields, and
 * the `requestId` matches the `X-Request-ID` header for the same request.
 */
describe('Error envelope (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  const expectEnvelope = (body: any, status: number) => {
    expect(body).toMatchObject({ statusCode: status });
    expect(body).toHaveProperty('message');
    expect(typeof body.path).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    expect(body).toHaveProperty('requestId');
  };

  it('wraps a 400 validation error and keeps `message` for clients', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/auth/login')
      .send({ email: 'bad', password: '' });
    expect(res.status).toBe(400);
    expectEnvelope(res.body, 400);
    expect(res.body.path).toBe('/api/marketing/auth/login');
  });

  it('wraps a 401 and the body requestId matches the X-Request-ID header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/marketing/leads')
      .set('X-Request-ID', 'corr-err-1');
    expect(res.status).toBe(401);
    expectEnvelope(res.body, 401);
    expect(res.headers['x-request-id']).toBe('corr-err-1');
    expect(res.body.requestId).toBe('corr-err-1');
  });

  it('wraps a 404 for an unmapped route', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope');
    expect(res.status).toBe(404);
    expectEnvelope(res.body, 404);
  });
});
