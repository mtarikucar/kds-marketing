import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Confirms the generated OpenAPI spec is served and non-trivial — the CLI
 * plugin introspected the controllers/DTOs into a real document.
 */
describe('OpenAPI docs (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  it('serves a valid OpenAPI document at /api/docs-json', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info?.title).toBe('KDS Marketing API');
    expect(Object.keys(res.body.paths ?? {}).length).toBeGreaterThan(10);
  });

  it('registers the credential security schemes', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const schemes = res.body.components?.securitySchemes ?? {};
    expect(schemes).toHaveProperty('marketing');
    expect(schemes).toHaveProperty('platform');
    expect(schemes).toHaveProperty('internal-token');
  });
});
