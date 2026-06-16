import { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Affiliate manager — full happy path + RBAC:
 *  1. MANAGER creates affiliate (201)
 *  2. MANAGER records referral
 *  3. MANAGER converts referral — asserts commission amount is correct
 *  4. MANAGER approves commission → 200
 *  5. MANAGER marks commission paid → 200
 *  6. REP forbidden on create → 403
 */
describe('Affiliates (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  // ── Auth helpers ─────────────────────────────────────────────────────────

  /**
   * Mock the entitlements chain: workspaceSubscription + package must both
   * resolve so the FeatureGuard grants access to the 'commissions' feature.
   */
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
      features: { commissions: true },
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

  const repAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role: 'REP' }) as never,
    );
    mockEntitlements();
    return `Bearer ${signMarketingToken({ sub: 'mu-2', wsp: 'ws-1', role: 'REP' })}`;
  };

  // ── Shared fixture data ──────────────────────────────────────────────────

  const affiliateRow = {
    id: 'aff-1',
    workspaceId: 'ws-1',
    name: 'Bob Partner',
    email: 'bob@partner.com',
    code: 'BOB20',
    commissionType: 'PERCENT',
    commissionValue: new Prisma.Decimal('20.00'),
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const referralRow = {
    id: 'ref-1',
    workspaceId: 'ws-1',
    affiliateId: 'aff-1',
    referredLeadId: 'lead-42',
    status: 'PENDING',
    convertedAt: null,
    createdAt: new Date(),
  };

  const commissionRow = {
    id: 'com-1',
    workspaceId: 'ws-1',
    affiliateId: 'aff-1',
    referralId: 'ref-1',
    amount: new Prisma.Decimal('100.00'), // 20% of 500
    status: 'OWED',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // ── Tests ─────────────────────────────────────────────────────────────────

  it('MANAGER creates affiliate → 201', async () => {
    const auth = managerAuth();
    ctx.prisma.affiliate.findFirst.mockResolvedValue(null as never);
    ctx.prisma.affiliate.create.mockResolvedValue(affiliateRow as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/affiliates')
      .set('Authorization', auth)
      .send({
        name: 'Bob Partner',
        email: 'bob@partner.com',
        code: 'BOB20',
        commissionType: 'PERCENT',
        commissionValue: 20,
      });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('BOB20');
  });

  it('MANAGER records referral → 201', async () => {
    const auth = managerAuth();
    // getAffiliate call
    ctx.prisma.affiliate.findFirst.mockResolvedValue(affiliateRow as never);
    // recordReferral call (by code)
    ctx.prisma.affiliateReferral.create.mockResolvedValue(referralRow as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/affiliates/aff-1/referrals')
      .set('Authorization', auth)
      .send({ referredLeadId: 'lead-42' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
  });

  it('MANAGER converts referral → commission amount correct (20% of 500 = 100)', async () => {
    const auth = managerAuth();
    const referralWithAffiliate = { ...referralRow, affiliate: affiliateRow };

    ctx.prisma.affiliateReferral.findFirst.mockResolvedValue(referralWithAffiliate as never);
    ctx.prisma.affiliateReferral.updateMany.mockResolvedValue({ count: 1 } as never);
    ctx.prisma.affiliateReferral.findUniqueOrThrow.mockResolvedValue({
      ...referralRow,
      status: 'CONVERTED',
      convertedAt: new Date(),
    } as never);
    ctx.prisma.affiliateCommission.create.mockResolvedValue(commissionRow as never);
    // $transaction must execute the callback
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: any) => Promise<any>) => fn(ctx.prisma),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/affiliates/referrals/ref-1/convert')
      .set('Authorization', auth)
      .send({ conversionValue: 500 });

    expect(res.status).toBe(201);
    // Commission amount should be 20% of 500 = 100.00
    expect(Number(res.body.commission.amount)).toBeCloseTo(100, 2);
    expect(res.body.commission.status).toBe('OWED');
  });

  it('MANAGER approves commission → 200', async () => {
    const auth = managerAuth();
    const owedCommission = { ...commissionRow, status: 'OWED' };
    const approvedCommission = { ...commissionRow, status: 'APPROVED' };

    ctx.prisma.affiliateCommission.findFirst.mockResolvedValue(owedCommission as never);
    ctx.prisma.affiliateCommission.updateMany.mockResolvedValue({ count: 1 } as never);
    ctx.prisma.affiliateCommission.findUniqueOrThrow.mockResolvedValue(approvedCommission as never);
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: any) => Promise<any>) => fn(ctx.prisma),
    );

    const res = await request(app.getHttpServer())
      .patch('/api/marketing/affiliates/commissions/com-1/approve')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('MANAGER marks commission paid → 200', async () => {
    const auth = managerAuth();
    const approvedCommission = { ...commissionRow, status: 'APPROVED' };
    const paidCommission = { ...commissionRow, status: 'PAID' };

    ctx.prisma.affiliateCommission.findFirst.mockResolvedValue(approvedCommission as never);
    ctx.prisma.affiliateCommission.updateMany.mockResolvedValue({ count: 1 } as never);
    ctx.prisma.affiliateCommission.findUniqueOrThrow.mockResolvedValue(paidCommission as never);
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: any) => Promise<any>) => fn(ctx.prisma),
    );

    const res = await request(app.getHttpServer())
      .patch('/api/marketing/affiliates/commissions/com-1/pay')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
  });

  it('REP forbidden on affiliate create → 403', async () => {
    const auth = repAuth();

    const res = await request(app.getHttpServer())
      .post('/api/marketing/affiliates')
      .set('Authorization', auth)
      .send({
        name: 'Sneaky Rep',
        email: 'sneaky@rep.com',
        code: 'SNEAKY',
        commissionType: 'FLAT',
        commissionValue: 10,
      });

    expect(res.status).toBe(403);
  });
});
