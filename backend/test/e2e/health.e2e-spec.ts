import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Health probes + the request-id/observability wiring — the cross-cutting
 * contract every other surface relies on. Validates the harness boots the real
 * app through `configureApp` (so a green run here proves the pipeline is wired).
 */
describe('Health & observability (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  describe('GET /api/health (liveness)', () => {
    it('returns 200 ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', service: 'kds-marketing' });
      expect(typeof res.body.uptime).toBe('number');
    });

    it('stays 200 even when the database is down (liveness must not depend on it)', async () => {
      // Persistent override (liveness never consumes a DB call, so a `...Once`
      // would leak to the next probe); restored in finally.
      (ctx.prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('db down'));
      try {
        const res = await request(app.getHttpServer()).get('/api/health');
        expect(res.status).toBe(200);
      } finally {
        (ctx.prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      }
    });

    it('is not cached by upstream proxies', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('GET /api/health/ready (readiness)', () => {
    it('returns 200 ready when the database answers', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/ready');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ready',
        checks: { database: 'up' },
      });
    });

    it('returns 503 not-ready when the database is unreachable', async () => {
      // Persistent override (not `...Once`) so the OutboxWorker's concurrent
      // poll can't consume the queued value out from under the probe.
      (ctx.prisma.$queryRaw as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );
      try {
        const res = await request(app.getHttpServer()).get('/api/health/ready');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          status: 'not-ready',
          checks: { database: 'down' },
        });
      } finally {
        (ctx.prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      }
    });
  });

  describe('X-Request-ID correlation', () => {
    it('mints a request id when none is supplied', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('echoes a caller-supplied request id end to end', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .set('X-Request-ID', 'trace-abc-123');
      expect(res.headers['x-request-id']).toBe('trace-abc-123');
    });

    it('rejects a malformed inbound id and mints a safe one instead', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .set('X-Request-ID', 'bad id with spaces!');
      expect(res.headers['x-request-id']).not.toBe('bad id with spaces!');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('Security headers (helmet)', () => {
    it('sets hardening headers on every response', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    });
  });

  describe('Unknown routes', () => {
    it('404s an unmapped path (a 404 here means wrong URL, never wrong auth)', async () => {
      const res = await request(app.getHttpServer()).get('/api/does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
