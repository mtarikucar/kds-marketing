import {
  assignPackageToWorkspace,
  INTERNAL_GRANT_PERIOD_END,
  OPERATOR_PACKAGE_CODE,
  UnknownPackageCodeError,
  WorkspaceNotFoundError,
} from './package-assignment';

const OPERATOR_PKG = {
  id: 'pkg-op',
  code: 'OPERATOR',
  name: 'Operator (internal)',
  dailyLeadQuota: -1,
  maxUsers: -1,
  maxResearchProfiles: -1,
  limits: { aiCreditsMonthly: -1, messagesMonthly: -1 },
};

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    workspace: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'ws-1', defaultCurrency: 'TRY' }),
    },
    package: {
      findUnique: jest.fn().mockResolvedValue(OPERATOR_PKG),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { code: 'TRIAL' },
          { code: 'STARTER' },
          { code: 'OPERATOR' },
        ]),
    },
    workspaceSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as any;
}

describe('assignPackageToWorkspace', () => {
  it('upserts the subscription with fields the billing scheduler can never expire', async () => {
    const prisma = makePrisma();
    const result = await assignPackageToWorkspace(
      prisma,
      'ws-1',
      OPERATOR_PACKAGE_CODE,
    );

    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.workspaceSubscription.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: 'ws-1' });

    for (const data of [args.create, args.update]) {
      // ACTIVE + a period end in 2999 → sweepLifecycle's `ACTIVE and
      // currentPeriodEnd < now` branch never matches, so it never becomes
      // PAST_DUE (and therefore never EXPIRED).
      expect(data.status).toBe('ACTIVE');
      expect(data.currentPeriodEnd).toEqual(INTERNAL_GRANT_PERIOD_END);
      // null trialEndsAt keeps it out of the TRIALING sweep and out of the
      // read-side "trial past its end → zero entitlements" belt.
      expect(data.trialEndsAt).toBeNull();
      // false → the lapse branch could never route it to CANCELLED either.
      expect(data.cancelAtPeriodEnd).toBe(false);
      expect(data.packageId).toBe('pkg-op');
      expect(data.provider).toBe('manual');
    }
    expect(args.create.workspaceId).toBe('ws-1');
    expect(args.create.currency).toBe('TRY');

    expect(result).toEqual(
      expect.objectContaining({
        workspaceId: 'ws-1',
        packageCode: 'OPERATOR',
        status: 'ACTIVE',
        changed: true,
        trialEndsAt: null,
      }),
    );
    expect(result.limits).toEqual(
      expect.objectContaining({
        dailyLeadQuota: -1,
        maxUsers: -1,
        maxResearchProfiles: -1,
        aiCreditsMonthly: -1,
      }),
    );
  });

  it('is a no-op the second time (same package already granted)', async () => {
    const prisma = makePrisma();
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      workspaceId: 'ws-1',
      packageId: 'pkg-op',
      status: 'ACTIVE',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(INTERNAL_GRANT_PERIOD_END),
    });

    const result = await assignPackageToWorkspace(prisma, 'ws-1', 'OPERATOR');

    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.packageCode).toBe('OPERATOR');
    expect(result.status).toBe('ACTIVE');
  });

  it('rewrites an existing subscription that drifted (expired trial → operator grant)', async () => {
    const prisma = makePrisma();
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      workspaceId: 'ws-1',
      packageId: 'pkg-trial',
      status: 'EXPIRED',
      trialEndsAt: new Date('2020-01-01T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date('2020-01-01T00:00:00.000Z'),
    });

    const result = await assignPackageToWorkspace(prisma, 'ws-1', 'OPERATOR');

    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
    const { update } = prisma.workspaceSubscription.upsert.mock.calls[0][0];
    expect(update).toEqual(
      expect.objectContaining({
        packageId: 'pkg-op',
        status: 'ACTIVE',
        trialEndsAt: null,
      }),
    );
    expect(result.changed).toBe(true);
  });

  it('rewrites when the same fields are set but the package differs', async () => {
    const prisma = makePrisma();
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      packageId: 'pkg-scale',
      status: 'ACTIVE',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(INTERNAL_GRANT_PERIOD_END),
    });
    await assignPackageToWorkspace(prisma, 'ws-1', 'OPERATOR');
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledTimes(1);
  });

  it('throws WorkspaceNotFoundError for an unknown workspace (before touching billing rows)', async () => {
    const prisma = makePrisma();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(
      assignPackageToWorkspace(prisma, 'ghost', 'OPERATOR'),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('throws UnknownPackageCodeError listing the valid codes', async () => {
    const prisma = makePrisma();
    prisma.package.findUnique.mockResolvedValue(null);
    await expect(
      assignPackageToWorkspace(prisma, 'ws-1', 'NOPE'),
    ).rejects.toMatchObject({
      name: 'UnknownPackageCodeError',
      code: 'NOPE',
      validCodes: ['TRIAL', 'STARTER', 'OPERATOR'],
    });
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('falls back to USD when the workspace currency is not a billable one', async () => {
    const prisma = makePrisma();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws-1',
      defaultCurrency: 'EUR',
    });
    await assignPackageToWorkspace(prisma, 'ws-1', 'OPERATOR');
    const { create } = prisma.workspaceSubscription.upsert.mock.calls[0][0];
    expect(create.currency).toBe('USD');
  });
});
