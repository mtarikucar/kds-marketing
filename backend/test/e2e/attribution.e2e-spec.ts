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
 * Multi-touch attribution end to end (DB seam mocked). Drives one converted
 * lead through a WEBSITE → EMAIL touch path and asserts first/last/linear each
 * split its accepted-offer value differently, scoped to the caller's workspace.
 */
describe('Attribution analytics (e2e)', () => {
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

  function seedConvertedLead() {
    (ctx.prisma.lead.findMany as unknown as jest.Mock).mockResolvedValue([
      {
        id: 'A',
        source: 'WEBSITE',
        status: 'WON',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        convertedAt: new Date('2026-01-03T00:00:00Z'),
        offers: [{ status: 'ACCEPTED', customPrice: 1200, planMonthlyPrice: null }],
        activities: [{ type: 'EMAIL', createdAt: new Date('2026-01-02T00:00:00Z') }],
      },
    ]);
  }

  it('requires auth', async () => {
    const res = await request(app.getHttpServer()).get('/api/marketing/analytics/attribution');
    expect(res.status).toBe(401);
  });

  it('first-touch credits the origin channel (WEBSITE)', async () => {
    seedConvertedLead();
    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/attribution?model=first')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('first');
    expect(res.body.totalRevenue).toBe(1200);
    const credited = res.body.channels.filter((c: any) => c.revenue > 0);
    expect(credited).toEqual([
      expect.objectContaining({ channel: 'WEBSITE', revenue: 1200 }),
    ]);
  });

  it('last-touch credits the final channel (EMAIL)', async () => {
    seedConvertedLead();
    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/attribution?model=last')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    const credited = res.body.channels.filter((c: any) => c.revenue > 0);
    expect(credited).toEqual([
      expect.objectContaining({ channel: 'EMAIL', revenue: 1200 }),
    ]);
  });

  it('linear splits value evenly across both touches', async () => {
    seedConvertedLead();
    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/attribution?model=linear')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    const rev = Object.fromEntries(
      res.body.channels.map((c: any) => [c.channel, c.revenue]),
    );
    expect(rev.WEBSITE).toBe(600);
    expect(rev.EMAIL).toBe(600);
  });

  it('defaults to last-touch on an unknown model and pins the workspace', async () => {
    seedConvertedLead();
    const res = await request(app.getHttpServer())
      .get('/api/marketing/analytics/attribution?model=bogus')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('last');
    const arg = (ctx.prisma.lead.findMany as unknown as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId).toBe('ws-1');
  });
});
