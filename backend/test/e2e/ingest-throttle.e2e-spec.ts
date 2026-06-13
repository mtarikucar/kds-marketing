import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Regression for the public lead-ingest rate limit (security review C2).
 *
 * The `@Throttle` override on the ingest controller must key on `default` — the
 * name @nestjs/throttler gives the single global (unnamed) throttler. A
 * mismatched key (the old `long`) is silently ignored, leaving this public
 * bulk-ingest endpoint on the loose 300/min global limit instead of 6/min.
 *
 * The global ThrottlerGuard runs before the ingest-token guard, so the limit
 * trips regardless of token validity — exactly what protects against a flood.
 */
describe('Lead ingest throttle (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });
  afterAll(() => closeTestApp(app));

  it('429s within a handful of calls (6/min override active, not the 300 global)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/marketing/leads/ingest')
        .set('x-ingest-token', 'irrelevant-the-throttle-fires-first')
        .send({ leads: [] });
      statuses.push(res.status);
    }
    // The throttle must engage — if the override were ignored (300/min) none of
    // these 9 calls would 429.
    expect(statuses).toContain(429);
    // At most the configured 6 requests reach past the throttle in the window.
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(6);
  });
});
