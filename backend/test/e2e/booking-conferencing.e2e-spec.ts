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
 * Conferencing config flows through the real HTTP stack end to end: the admin
 * calendar route (MANAGER + `funnels` + settings.manage) accepts a valid
 * `conferencing` provider through the global ValidationPipe and persists it, and
 * rejects an out-of-enum value with a 400 (the DTO's @IsIn under
 * forbidNonWhitelisted). The Meet/Teams link creation itself is unit-tested in
 * the calendar-sync conferencing specs.
 */
describe('Booking conferencing config (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await closeTestApp(app);
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => jest.clearAllMocks());

  // Grant the `funnels` feature so the FeatureGuard admits the calendar routes.
  const mockEntitlements = () => {
    ctx.prisma.workspaceSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      workspaceId: 'ws-1',
      packageId: 'pkg-1',
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodEnd: new Date(Date.now() + 86400_000),
    } as never);
    ctx.prisma.package.findUnique.mockResolvedValue({
      id: 'pkg-1',
      code: 'PRO',
      features: { funnels: true },
      dailyLeadQuota: 100,
      maxUsers: 50,
      maxResearchProfiles: 10,
      limits: {},
    } as never);
    ctx.prisma.workspaceAddOn.findMany.mockResolvedValue([] as never);
  };

  const managerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role: 'MANAGER' }) as never,
    );
    mockEntitlements();
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'MANAGER' })}`;
  };

  it('persists a Google Meet conferencing choice on calendar create', async () => {
    const a = managerAuth();
    ctx.prisma.bookingCalendar.create.mockResolvedValue({
      id: 'cal-1',
      conferencing: 'GOOGLE_MEET',
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/calendars')
      .set('Authorization', a)
      .send({ name: 'Sales call', conferencing: 'GOOGLE_MEET' });

    expect(res.status).toBe(201);
    const createArg = ctx.prisma.bookingCalendar.create.mock.calls[0][0] as any;
    expect(createArg.data.conferencing).toBe('GOOGLE_MEET');
  });

  it('rejects an out-of-enum conferencing value with 400', async () => {
    const a = managerAuth();
    const res = await request(app.getHttpServer())
      .post('/api/marketing/calendars')
      .set('Authorization', a)
      .send({ name: 'Bad', conferencing: 'ZOOM' });

    expect(res.status).toBe(400);
    expect(ctx.prisma.bookingCalendar.create).not.toHaveBeenCalled();
  });
});
