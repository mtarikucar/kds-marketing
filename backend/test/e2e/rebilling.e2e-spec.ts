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
 * Epic D1 — agency REBILLING / SaaS-mode (e2e).
 *
 *  1. An AGENCY OWNER sets a per-location rebilling plan (PUT) → 200, and lists it.
 *  2. The same OWNER computes a charge for that location → 201 DRAFT, with the
 *     base + usage×(1+markup) math settled from the location's REAL UsageCounter usage.
 *  3. Attempting the live charge with Stripe Connect env UNSET → 503 (inert path):
 *     the charge stays DRAFT, no Stripe call.
 *  4. A STANDALONE workspace OWNER is forbidden on every rebilling route (403) —
 *     the kind gate, not a loosened guard.
 *  5. Agency-A cannot plan/charge a location it does not own → 404 (assertAgencyOwns).
 */
describe('Agency rebilling / SaaS-mode (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  const AGENCY_A = 'agency-a';
  const AGENCY_B = 'agency-b';
  const STANDALONE = 'ws-standalone';
  const LOCATION_A1 = 'loc-a1';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = (workspaceId: string) => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ id: `owner-${workspaceId}`, workspaceId, role: 'OWNER' }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: `owner-${workspaceId}`, wsp: workspaceId, role: 'OWNER' })}`;
  };

  const agencyKind = (id: string, kind: string) =>
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ id, kind } as never);

  /** assertAgencyOwns resolves: the location IS this agency's child. */
  const ownsLocation = () =>
    (ctx.prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: LOCATION_A1,
      kind: 'LOCATION',
      parentWorkspaceId: AGENCY_A,
    } as never);

  // ── 1. Set + list a plan ──────────────────────────────────────────────────────

  it('AGENCY OWNER sets a per-location rebilling plan → 200, then lists it', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    ownsLocation();
    (ctx.prisma.rebillingPlan.upsert as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'plan-1', createdAt: new Date(), updatedAt: new Date(), ...args.create }),
    );

    const res = await request(app.getHttpServer())
      .put(`/api/marketing/agency/rebilling/plans/${LOCATION_A1}`)
      .set('Authorization', auth)
      .send({ basePrice: '100.00', usageUnitPrice: '2.00', markupPercent: '25' });

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe(AGENCY_A);
    expect(res.body.locationWorkspaceId).toBe(LOCATION_A1);

    // list
    agencyKind(AGENCY_A, 'AGENCY');
    (ctx.prisma.rebillingPlan.findMany as jest.Mock).mockResolvedValue([
      { id: 'plan-1', workspaceId: AGENCY_A, locationWorkspaceId: LOCATION_A1 },
    ] as never);
    const list = await request(app.getHttpServer())
      .get('/api/marketing/agency/rebilling/plans')
      .set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const where = (ctx.prisma.rebillingPlan.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.workspaceId).toBe(AGENCY_A);
  });

  // ── 2. Compute a charge from REAL usage ────────────────────────────────────────

  it('AGENCY OWNER computes a charge → 201 DRAFT with base + usage×(1+markup) from real UsageCounter', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    ownsLocation();
    (ctx.prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue({
      id: 'plan-1',
      workspaceId: AGENCY_A,
      locationWorkspaceId: LOCATION_A1,
      basePrice: '100.00',
      usageUnitPrice: '2.00',
      markupPercent: '25',
      enabled: true,
    } as never);
    // 40 real metered usage units for the location.
    (ctx.prisma.usageCounter.aggregate as jest.Mock).mockResolvedValue({
      _sum: { value: 40 },
    } as never);
    (ctx.prisma.rebillCharge.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'charge-1', createdAt: new Date(), ...args.data }),
    );

    const res = await request(app.getHttpServer())
      .post(`/api/marketing/agency/rebilling/charges/${LOCATION_A1}/compute`)
      .set('Authorization', auth)
      .send({ periodStart: '2026-05-01T00:00:00.000Z', periodEnd: '2026-06-01T00:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    // 40 × 2.00 = 80; ×1.25 = 100 usage; +100 base = 200 total.
    expect(Number(res.body.totalAmount)).toBeCloseTo(200, 2);
    expect(res.body.usageUnits).toBe(40);

    // It metered the REAL usage source: UsageCounter, scoped to the LOCATION.
    const aggWhere = (ctx.prisma.usageCounter.aggregate as jest.Mock).mock.calls[0][0].where;
    expect(aggWhere.workspaceId).toBe(LOCATION_A1);
    expect(aggWhere.metric.in).toContain('ai.credits');
    expect(aggWhere.metric.in).toContain('messages.sent');
  });

  // ── 3. Inert (env-gated) live charge ───────────────────────────────────────────

  it('live charge with Stripe Connect env UNSET → 503, charge stays DRAFT (no Stripe call)', async () => {
    const auth = ownerAuth(AGENCY_A);
    agencyKind(AGENCY_A, 'AGENCY');
    (ctx.prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue({
      id: 'charge-1',
      workspaceId: AGENCY_A,
      locationWorkspaceId: LOCATION_A1,
      totalAmount: '200.00',
      status: 'DRAFT',
      stripeChargeId: null,
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/marketing/agency/rebilling/charges/charge-1/charge')
      .set('Authorization', auth)
      .send({});

    expect(res.status).toBe(503);
    // No write moved it off DRAFT.
    expect(ctx.prisma.rebillCharge.update).not.toHaveBeenCalled();
  });

  // ── 4. Non-agency workspace is forbidden ───────────────────────────────────────

  it('STANDALONE workspace OWNER is forbidden on rebilling routes → 403', async () => {
    const auth = ownerAuth(STANDALONE);
    agencyKind(STANDALONE, 'STANDALONE');

    const res = await request(app.getHttpServer())
      .get('/api/marketing/agency/rebilling/plans')
      .set('Authorization', auth);

    expect(res.status).toBe(403);
    expect(ctx.prisma.rebillingPlan.findMany).not.toHaveBeenCalled();
  });

  // ── 5. Cross-agency isolation ──────────────────────────────────────────────────

  it('Agency-B cannot set a plan for Agency-A’s location → 404 (assertAgencyOwns)', async () => {
    const auth = ownerAuth(AGENCY_B);
    agencyKind(AGENCY_B, 'AGENCY');
    // assertAgencyOwns: the parent-scoped lookup for loc-a1 under parent=AGENCY_B → null.
    (ctx.prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null as never);

    const res = await request(app.getHttpServer())
      .put(`/api/marketing/agency/rebilling/plans/${LOCATION_A1}`)
      .set('Authorization', auth)
      .send({ basePrice: '10', usageUnitPrice: '1', markupPercent: '0' });

    expect(res.status).toBe(404);
    expect(ctx.prisma.rebillingPlan.upsert).not.toHaveBeenCalled();
  });
});
