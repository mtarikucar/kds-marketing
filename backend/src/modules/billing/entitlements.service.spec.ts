import { EntitlementsService, FEATURE_KEYS } from './entitlements.service';

describe('EntitlementsService — fold semantics', () => {
  const NOW = Date.now();
  const FUTURE = new Date(NOW + 7 * 24 * 3600 * 1000);
  const PAST = new Date(NOW - 24 * 3600 * 1000);

  const PKG = {
    id: 'pkg-1',
    code: 'GROWTH',
    dailyLeadQuota: 25,
    maxUsers: 10,
    maxResearchProfiles: 2,
    features: {
      autoAssign: true,
      telephony: true,
      installations: false,
      commissions: false,
      advancedReports: true,
      apiAccess: false,
    },
  };

  let prisma: any;
  let svc: EntitlementsService;

  beforeEach(() => {
    prisma = {
      workspaceSubscription: { findUnique: jest.fn() },
      package: { findUnique: jest.fn().mockResolvedValue({ ...PKG }) },
      workspaceAddOn: { findMany: jest.fn().mockResolvedValue([]) },
      // Module-activation lookup: default null = every entitled module active.
      workspace: { findUnique: jest.fn().mockResolvedValue({ activatedModules: null }) },
    };
    svc = new EntitlementsService(prisma);
  });

  function sub(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sub-1',
      workspaceId: 'ws-1',
      packageId: 'pkg-1',
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodEnd: FUTURE,
      ...overrides,
    };
  }

  it('no subscription → zero entitlements (quota 0, every feature false)', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(null);
    const e = await svc.getEffective('ws-1');
    expect(e.dailyLeadQuota).toBe(0);
    expect(e.maxResearchProfiles).toBe(0);
    expect(Object.values(e.features).every((v) => v === false)).toBe(true);
  });

  it('ACTIVE subscription → package limits + features', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    const e = await svc.getEffective('ws-1');
    expect(e).toMatchObject({
      packageCode: 'GROWTH',
      dailyLeadQuota: 25,
      maxUsers: 10,
      features: expect.objectContaining({ telephony: true, apiAccess: false }),
    });
  });

  it('activation allow-list deactivates entitled-but-unlisted modules; entitledModules still lists them', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    prisma.workspace.findUnique.mockResolvedValue({ activatedModules: ['advancedReports'] });
    const e = await svc.getEffective('ws-1');
    expect(e.features.telephony).toBe(false); // entitled but not activated → gated off
    expect(e.features.advancedReports).toBe(true); // entitled AND activated → on
    expect(e.entitledModules).toEqual(
      expect.arrayContaining(['telephony', 'advancedReports']),
    );
  });

  it('null activatedModules keeps every entitled module active (back-compat)', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    prisma.workspace.findUnique.mockResolvedValue({ activatedModules: null });
    const e = await svc.getEffective('ws-1');
    expect(e.features.telephony).toBe(true);
    expect(e.features.advancedReports).toBe(true);
  });

  it('live TRIALING grants the package; an expired trial computes to zero immediately', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(
      sub({ status: 'TRIALING', trialEndsAt: FUTURE }),
    );
    expect((await svc.getEffective('ws-1')).dailyLeadQuota).toBe(25);

    svc.invalidate('ws-1');
    prisma.workspaceSubscription.findUnique.mockResolvedValue(
      sub({ status: 'TRIALING', trialEndsAt: PAST }),
    );
    expect((await svc.getEffective('ws-1')).dailyLeadQuota).toBe(0);
  });

  it('PAST_DUE keeps entitlements (grace); EXPIRED zeroes them', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(
      sub({ status: 'PAST_DUE' }),
    );
    expect((await svc.getEffective('ws-1')).dailyLeadQuota).toBe(25);

    svc.invalidate('ws-1');
    prisma.workspaceSubscription.findUnique.mockResolvedValue(
      sub({ status: 'EXPIRED' }),
    );
    expect((await svc.getEffective('ws-1')).dailyLeadQuota).toBe(0);
  });

  it('add-on grants fold: limit.* sums (× quantity), feature.* ORs', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    prisma.workspaceAddOn.findMany.mockResolvedValue([
      { grants: { 'limit.dailyLeadQuota': 10 }, quantity: 2 },
      { grants: { 'limit.maxResearchProfiles': 1 }, quantity: 1 },
      { grants: { 'feature.apiAccess': true }, quantity: 1 },
    ]);
    const e = await svc.getEffective('ws-1');
    expect(e.dailyLeadQuota).toBe(45); // 25 + 2×10
    expect(e.maxResearchProfiles).toBe(3); // 2 + 1
    expect(e.features.apiAccess).toBe(true);
  });

  it('unlimited (-1) absorbs add-on additions', async () => {
    prisma.package.findUnique.mockResolvedValue({ ...PKG, dailyLeadQuota: -1 });
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    prisma.workspaceAddOn.findMany.mockResolvedValue([
      { grants: { 'limit.dailyLeadQuota': 10 }, quantity: 1 },
    ]);
    expect((await svc.getEffective('ws-1')).dailyLeadQuota).toBe(-1);
  });

  it('an add-on GRANTING -1 sets the limit unlimited, not base-minus-quantity', async () => {
    // -1 is the universal "unlimited" sentinel, so an "unlimited X" add-on grants
    // it. Treating that grant as an additive delta would SUBTRACT from the base
    // (maxUsers 10 → 9; maxWorkflows 5 → 4) instead of unlocking it.
    prisma.package.findUnique.mockResolvedValue({ ...PKG, limits: { maxWorkflows: 5 } });
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    prisma.workspaceAddOn.findMany.mockResolvedValue([
      { grants: { 'limit.maxUsers': -1, 'limit.maxWorkflows': -1 }, quantity: 1 },
    ]);
    const e = await svc.getEffective('ws-1');
    expect(e.maxUsers).toBe(-1);
    expect(e.limits.maxWorkflows).toBe(-1);
  });

  it('caches for the TTL and recomputes after invalidate()', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    await svc.getEffective('ws-1');
    await svc.getEffective('ws-1');
    expect(prisma.workspaceSubscription.findUnique).toHaveBeenCalledTimes(1);

    svc.invalidate('ws-1');
    await svc.getEffective('ws-1');
    expect(prisma.workspaceSubscription.findUnique).toHaveBeenCalledTimes(2);
  });

  it('every FEATURE_KEY appears in the computed feature map', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue(sub());
    const e = await svc.getEffective('ws-1');
    expect(Object.keys(e.features).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});
