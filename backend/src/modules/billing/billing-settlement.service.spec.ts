import { Prisma } from '@prisma/client';
import { BillingSettlementService } from './billing-settlement.service';

/**
 * Settlement idempotency contract (the two-layer guard):
 *   - replayed success webhooks activate exactly once
 *   - success-after-failure is refused
 *   - the updateMany flip is the race arbiter (count 0 → no grant)
 *   - paid-but-grant-failed orders stay SUCCEEDED (never rolled back)
 *   - WALLET_TOPUP orders credit the growth wallet (idempotent by ledger ref)
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
  let growthWallet: { credit: jest.Mock };
  let svc: BillingSettlementService;

  beforeEach(() => {
    prisma = {
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue({ ...ORDER }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workspaceSubscription: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ currentPeriodEnd: new Date() }),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      workspaceAddOn: { create: jest.fn().mockResolvedValue({}) },
      growthWalletLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      // FIX 5: activateSubscription now widens the module allow-list. Default to
      // null (all-active) so the common path is a no-op; module-union tests
      // override these.
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ activatedModules: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      package: { findUnique: jest.fn().mockResolvedValue({ features: {} }) },
    };
    entitlements = { invalidate: jest.fn() };
    growthWallet = { credit: jest.fn().mockResolvedValue({ wallet: {}, replayed: false }) };
    svc = new BillingSettlementService(prisma, entitlements as any, growthWallet as any);
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

  describe('module activation on upgrade (FIX 5)', () => {
    it('unions newly-entitled default-ON modules into a customised activatedModules allow-list', async () => {
      prisma.workspace.findUnique.mockResolvedValue({
        activatedModules: ['telephony'],
      });
      prisma.package.findUnique.mockResolvedValue({
        features: { telephony: true, campaigns: true, memberships: true },
      });

      await svc.settleSuccess('order-1'); // SUBSCRIPTION order for pkg-1

      const upd = prisma.workspace.update.mock.calls[0][0];
      expect(upd.where).toEqual({ id: 'ws-1' });
      // campaigns is newly entitled + default-ON → added; telephony already on;
      // memberships is entitled but hidden-by-default → NOT auto-activated.
      expect(upd.data.activatedModules).toEqual(['telephony', 'campaigns']);
      expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
    });

    it('leaves activatedModules untouched when the workspace is all-active (null allow-list)', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ activatedModules: null });
      await svc.settleSuccess('order-1');
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it('does not write when every entitled default-ON module is already active', async () => {
      prisma.workspace.findUnique.mockResolvedValue({
        activatedModules: ['telephony'],
      });
      prisma.package.findUnique.mockResolvedValue({
        features: { telephony: true },
      });
      await svc.settleSuccess('order-1');
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });
  });

  it('reconcileUngrantedOrders re-grants a SUCCEEDED subscription order whose workspace lacks a subscription', async () => {
    // The sweep now issues one findMany per family (subscription vs WALLET_TOPUP) —
    // answer per-where so the topup pass sees nothing here.
    prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
      where.type?.in ? [{ ...ORDER, status: 'SUCCEEDED' }] : []);
    // No subscription on the workspace → this order is genuinely ungranted.
    prisma.workspaceSubscription.findUnique.mockResolvedValue(null);

    const regranted = await svc.reconcileUngrantedOrders();

    expect(regranted).toBe(1);
    // Only subscription-family orders are swept (ADDON excluded — not idempotent).
    expect(prisma.paymentOrder.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'SUCCEEDED',
      type: { in: ['SUBSCRIPTION', 'UPGRADE', 'RENEWAL'] },
    });
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
  });

  it('reconcileUngrantedOrders skips orders whose subscription already reflects the paid order (same package, ACTIVE, live period)', async () => {
    prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
      where.type?.in ? [{ ...ORDER, status: 'SUCCEEDED' }] : []);
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      packageId: 'pkg-1', // matches ORDER.packageId
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });

    const regranted = await svc.reconcileUngrantedOrders();

    expect(regranted).toBe(0);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('reconcileUngrantedOrders RE-GRANTS a paid upgrade whose workspace only has the pre-existing trial row (FIX 2)', async () => {
    // The universal trial→paid upgrade: a TRIALING row for a DIFFERENT package
    // already exists. Old code short-circuited on its mere presence and never
    // ran the paid grant — the customer stayed on trial entitlements.
    prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
      where.type?.in ? [{ ...ORDER, type: 'UPGRADE', status: 'SUCCEEDED' }] : []);
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      packageId: 'trial-pkg',
      status: 'TRIALING',
      currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
    });

    const regranted = await svc.reconcileUngrantedOrders();

    expect(regranted).toBe(1);
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
  });

  describe('WALLET_TOPUP (growth wallet, spec D2)', () => {
    const TOPUP = {
      ...ORDER,
      id: 'topup-1',
      type: 'WALLET_TOPUP',
      packageId: null,
      amount: new Prisma.Decimal('500'),
      currency: 'TRY',
    };

    it('settleSuccess credits the growth wallet by order ref and never touches subscriptions', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue({ ...TOPUP });

      const res = await svc.settleSuccess('topup-1');

      expect(res.settled).toBe(true);
      expect(growthWallet.credit).toHaveBeenCalledTimes(1);
      const [ws, movement] = growthWallet.credit.mock.calls[0];
      expect(ws).toBe('ws-1');
      expect(movement).toMatchObject({ kind: 'TOPUP', ref: 'order:topup-1', currency: 'TRY' });
      expect(movement.amount.toString()).toBe('500');
      // A topup must NOT fall through to the subscription branch (it would
      // throw 'subscription order without packageId').
      expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
      expect(prisma.workspaceAddOn.create).not.toHaveBeenCalled();
      expect(entitlements.invalidate).toHaveBeenCalledWith('ws-1');
    });

    it('reconcile sweep re-credits a SUCCEEDED topup with no matching wallet ledger ref', async () => {
      prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
        where.type === 'WALLET_TOPUP' ? [{ ...TOPUP, status: 'SUCCEEDED' }] : []);
      prisma.growthWalletLedgerEntry.findUnique.mockResolvedValue(null); // credit never landed

      const regranted = await svc.reconcileUngrantedOrders();

      expect(regranted).toBe(1);
      expect(prisma.growthWalletLedgerEntry.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ref: 'order:topup-1' } }),
      );
      expect(growthWallet.credit).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ kind: 'TOPUP', ref: 'order:topup-1' }),
      );
    });

    it('reconcile sweep skips a topup whose wallet credit already landed (ledger ref exists)', async () => {
      prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
        where.type === 'WALLET_TOPUP' ? [{ ...TOPUP, status: 'SUCCEEDED' }] : []);
      prisma.growthWalletLedgerEntry.findUnique.mockResolvedValue({ id: 'entry-1' });

      const regranted = await svc.reconcileUngrantedOrders();

      expect(regranted).toBe(0);
      expect(growthWallet.credit).not.toHaveBeenCalled();
    });
  });

  // Audit A1: the sweep window (`take: limit`, succeededAt asc) went blind once
  // >limit lifetime SUCCEEDED orders existed — a recent failed grant was born
  // OUTSIDE the window and never re-examined. The fix makes ungranted-ness
  // queryable: a `grantedAt` marker set on grant success, and both sweep
  // queries filter `grantedAt: null` so the window always holds genuinely
  // ungranted rows and advances.
  describe('grantedAt marker (audit A1 — sweep-window blindness)', () => {
    const grantMarks = () =>
      prisma.paymentOrder.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.data?.grantedAt instanceof Date,
      );

    it('settleSuccess stamps grantedAt after a successful grant', async () => {
      await svc.settleSuccess('order-1');
      const marks = grantMarks();
      expect(marks).toHaveLength(1);
      expect(marks[0][0].where).toMatchObject({ id: 'order-1' });
    });

    it('settleSuccess does NOT stamp grantedAt when the grant throws', async () => {
      prisma.workspaceSubscription.upsert.mockRejectedValue(new Error('db down'));
      await svc.settleSuccess('order-1');
      expect(grantMarks()).toHaveLength(0);
    });

    it('both reconcile queries filter grantedAt: null (the window fix)', async () => {
      await svc.reconcileUngrantedOrders();
      const wheres = prisma.paymentOrder.findMany.mock.calls.map((c: any[]) => c[0].where);
      expect(wheres).toHaveLength(2);
      for (const where of wheres) expect(where).toMatchObject({ grantedAt: null });
    });

    it('reconcile stamps grantedAt on a successful re-grant', async () => {
      prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
        where.type?.in ? [{ ...ORDER, status: 'SUCCEEDED' }] : []);
      prisma.workspaceSubscription.findUnique.mockResolvedValue(null);

      await svc.reconcileUngrantedOrders();

      const marks = grantMarks();
      expect(marks).toHaveLength(1);
      expect(marks[0][0].where).toMatchObject({ id: 'order-1' });
    });

    it('reconcile stamps grantedAt when the probe shows the grant already landed (self-heal eviction)', async () => {
      prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
        where.type?.in ? [{ ...ORDER, status: 'SUCCEEDED' }] : []);
      prisma.workspaceSubscription.findUnique.mockResolvedValue({
        packageId: 'pkg-1',
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      });

      const regranted = await svc.reconcileUngrantedOrders();

      expect(regranted).toBe(0); // nothing re-granted…
      expect(grantMarks()).toHaveLength(1); // …but the row leaves the window
    });

    it('reconcile does NOT stamp grantedAt when the re-grant throws (stays in the window)', async () => {
      prisma.paymentOrder.findMany.mockImplementation(async ({ where }: any) =>
        where.type?.in ? [{ ...ORDER, status: 'SUCCEEDED' }] : []);
      prisma.workspaceSubscription.findUnique.mockResolvedValue(null);
      prisma.workspaceSubscription.upsert.mockRejectedValue(new Error('db down'));

      await svc.reconcileUngrantedOrders();

      expect(grantMarks()).toHaveLength(0);
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
