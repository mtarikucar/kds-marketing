import { seedOperatorWorkspace } from '../../../prisma/seed-operator-workspace';
import {
  INTERNAL_GRANT_PERIOD_END,
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
  limits: {},
};

function makePrisma() {
  return {
    workspace: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'ws-1', defaultCurrency: 'TRY' }),
    },
    package: {
      findUnique: jest.fn().mockResolvedValue(OPERATOR_PKG),
      findMany: jest.fn().mockResolvedValue([{ code: 'TRIAL' }]),
    },
    workspaceSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function makeLog() {
  return { log: jest.fn(), error: jest.fn() };
}

describe('seedOperatorWorkspace (deploy-time bootstrap)', () => {
  it('no-ops when OPERATOR_WORKSPACE_ID is unset (safe on every environment)', async () => {
    const prisma = makePrisma();
    const log = makeLog();
    const outcome = await seedOperatorWorkspace(prisma, {}, log);

    expect(outcome).toBe('skipped');
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('OPERATOR_WORKSPACE_ID'));
    expect(log.error).not.toHaveBeenCalled();
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('no-ops when OPERATOR_WORKSPACE_ID is empty/whitespace', async () => {
    const prisma = makePrisma();
    expect(
      await seedOperatorWorkspace(prisma, { OPERATOR_WORKSPACE_ID: '   ' }, makeLog()),
    ).toBe('skipped');
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it('puts the named workspace on the OPERATOR package', async () => {
    const prisma = makePrisma();
    const outcome = await seedOperatorWorkspace(
      prisma,
      { OPERATOR_WORKSPACE_ID: ' ws-1 ' },
      makeLog(),
    );

    expect(outcome).toBe('assigned');
    expect(prisma.package.findUnique).toHaveBeenCalledWith({
      where: { code: 'OPERATOR' },
    });
    const args = prisma.workspaceSubscription.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: 'ws-1' }); // env value trimmed
    expect(args.update).toEqual(
      expect.objectContaining({
        packageId: 'pkg-op',
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: INTERNAL_GRANT_PERIOD_END,
      }),
    );
  });

  it('is a no-op on the second deploy (already on OPERATOR)', async () => {
    const prisma = makePrisma();
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      packageId: 'pkg-op',
      status: 'ACTIVE',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(INTERNAL_GRANT_PERIOD_END),
    });

    const outcome = await seedOperatorWorkspace(
      prisma,
      { OPERATOR_WORKSPACE_ID: 'ws-1' },
      makeLog(),
    );

    expect(outcome).toBe('unchanged');
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('throws (→ non-zero exit) when the workspace id points at nothing', async () => {
    const prisma = makePrisma();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(
      seedOperatorWorkspace(prisma, { OPERATOR_WORKSPACE_ID: 'ghost' }, makeLog()),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('throws when the OPERATOR package is missing (package seed did not run)', async () => {
    const prisma = makePrisma();
    prisma.package.findUnique.mockResolvedValue(null);
    await expect(
      seedOperatorWorkspace(prisma, { OPERATOR_WORKSPACE_ID: 'ws-1' }, makeLog()),
    ).rejects.toBeInstanceOf(UnknownPackageCodeError);
  });
});
