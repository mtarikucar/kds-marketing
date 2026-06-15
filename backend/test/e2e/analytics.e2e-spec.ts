import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Epic G — lead analytics end to end (DB seam mocked): the funnel waterfall +
 * conversion rate, and the source breakdown, scoped to the caller's workspace.
 */
describe('Analytics (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser() as never);
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('returns a funnel with conversion rate', async () => {
    (ctx.prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([
      { status: 'NEW', _count: 6 },
      { status: 'WON', _count: 3 },
      { status: 'LOST', _count: 1 },
    ]);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/funnel')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 10, won: 3, conversionRate: 30 });
    expect(Array.isArray(res.body.waterfall)).toBe(true);
  });

  it('returns a source breakdown sorted descending', async () => {
    (ctx.prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([
      { source: 'WEBSITE', _count: 2 },
      { source: 'INSTAGRAM', _count: 9 },
    ]);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/by-source')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ key: 'INSTAGRAM', count: 9 });
  });
});
