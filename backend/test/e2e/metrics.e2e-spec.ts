import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Prometheus scrape surface (backlog #2). Proves the endpoint speaks the text
 * exposition format and that the global interceptor actually records traffic —
 * including that route labels use the matched pattern, not the raw URL (the
 * cardinality guarantee a metrics pipeline depends on).
 */
describe('Metrics (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  it('exposes GET /api/metrics in Prometheus text format', async () => {
    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    // HELP/TYPE banners are part of the exposition format.
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
  });

  it('exposes the outbox business gauges (pending + DLQ depth)', async () => {
    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.text).toContain('# TYPE outbox_events_pending gauge');
    expect(res.text).toContain('# TYPE outbox_events_failed gauge');
  });

  it('exposes the settlement-outcome gauge', async () => {
    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.text).toContain('# TYPE payment_orders_total gauge');
  });

  it('records a handled request under its matched route PATTERN (not the raw URL), with method + status labels', async () => {
    // Any request that reaches a controller is metered; the exact outcome
    // doesn't matter here — what matters is the label set: method, the matched
    // route pattern, and the numeric status. That pattern (not a per-id URL) is
    // the cardinality guarantee a Prometheus pipeline depends on.
    await request(app.getHttpServer())
      .post('/api/marketing/auth/login')
      .send({ email: 'someone@example.com', password: 'whatever-123' });

    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /http_requests_total\{method="POST",route="\/api\/marketing\/auth\/login",status="\d{3}"\} \d/,
    );
  });

  it('excludes the health probes from the metrics (no scrape-noise in SLOs)', async () => {
    await request(app.getHttpServer()).get('/api/health');
    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.text).not.toContain('route="/api/health"');
  });

  it('does not meter the scrape endpoint itself', async () => {
    await request(app.getHttpServer()).get('/api/metrics');
    const res = await request(app.getHttpServer()).get('/api/metrics');
    expect(res.text).not.toContain('route="/api/metrics"');
  });
});
