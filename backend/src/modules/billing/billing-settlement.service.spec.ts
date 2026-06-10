import { BillingSettlementService } from './billing-settlement.service';

/**
 * Settlement idempotency contract (the two-layer guard):
 *   - replayed success webhooks activate exactly once
 *   - success-after-failure is refused
 *   - the updateMany flip is the race arbiter (count 0 → no grant)
 *   - paid-but-grant-failed orders stay SUCCEEDED (never rolled back)
 */
describe('BillingSettlementService — idempotent settlement', () => {
  const ORDER = {
    id: 'order-1',
    workspaceId: 'ws-1',
    type: 'SUBSCRIPTION',
    packageId: 'pkg-1',
    addOnCode: null,
    quantity: 1,
    billingCycle: 'MONTHLY',
    currency: 'USD',
    provider: 'manual',
    providerRef: 'MKT-REF1',
    status: 'AWAITING_TRANSFER',
  };

  let prisma: any;
  let entitlements: { invalidate: jest.Mock };
  let svc: BillingSettlementService;

  beforeEach(() => {
    prisma = {
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue({ ...ORDER }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workspaceSubscription: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ currentPeriodEnd: new Date() }),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      workspaceAddOn: { create: jest.fn().mockResolvedValue({}) },
    };
    entitlements = { invalidate: jest.fn() };
    svc = new BillingSettlementService(prisma, entitlements as any);
  });

  it('activates the subscription and invalidates entitlements on first success', async () => {
    const res = await svc.settleSuccess('order-1');
    expect(res.settled).toBe(true);

    const upsert = prisma.workspaceSubscription.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ workspaceId: 'ws-1' });
    expect(upsert.update).toMatchObject({
      packageId: 'pkg-1',
      status: 'ACTIVE',
      trialEndsAt: null,
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
  });

  it('replayed webhook: already-SUCCEEDED order is a no-op', async () => {
    prisma.paymentOrder.findUnique.mockResolvedValue({
      ...ORDER,
      status: 'SUCCEEDED',
    });
    const res = await svc.settleSuccess('order-1');
    expect(res).toMatchObject({ settled: false, reason: 'already settled' });
    expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('refuses success-after-failure', async () => {
    prisma.paymentOrder.findUnique.mockResolvedValue({
      ...ORDER,
      status: 'FAILED',
    });
    const res = await svc.settleSuccess('order-1');
    expect(res.settled).toBe(false);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('losing the flip race grants nothing (two concurrent settlers, one winner)', async () => {
    prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });
    const res = await svc.settleSuccess('order-1');
    expect(res).toMatchObject({ settled: false, reason: 'lost the settlement race' });
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('a paid order whose grant explodes stays SUCCEEDED (logged, not rolled back)', async () => {
    prisma.workspaceSubscription.upsert.mockRejectedValue(new Error('db down'));
    const res = await svc.settleSuccess('order-1');
    expect(res.settled).toBe(true); // the money is real; ops fixes the grant
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
  });

  it('ADDON orders create the boost with the subscription period end', async () => {
    const periodEnd = new Date('2026-07-10');
    prisma.paymentOrder.findUnique.mockResolvedValue({
      ...ORDER,
      type: 'ADDON',
      packageId: null,
      addOnCode: 'quota_boost_10',
      quantity: 2,
    });
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      currentPeriodEnd: periodEnd,
    });

    await svc.settleSuccess('order-1');
    expect(prisma.workspaceAddOn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        code: 'quota_boost_10',
        quantity: 2,
        grants: { 'limit.dailyLeadQuota': 10 },
        currentPeriodEnd: periodEnd,
      }),
    });
  });

  it('settleFailure flips only PENDING/AWAITING_TRANSFER rows', async () => {
    prisma.paymentOrder.updateMany.mockResolvedValue({ count: 1 });
    const res = await svc.settleFailure('order-1', 'card declined');
    expect(res.settled).toBe(true);
    expect(prisma.paymentOrder.updateMany.mock.calls[0][0].where.status).toEqual({
      in: ['PENDING', 'AWAITING_TRANSFER'],
    });
  });
});
