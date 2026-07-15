import { ForbiddenException, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mockDeep } from 'jest-mock-extended';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from './agency.service';

/**
 * Epic D1 — agency / sub-account hierarchy unit specs.
 *
 * Proves the hierarchy invariants WITHOUT a database:
 *  - createLocation seeds a child with kind=LOCATION + parentWorkspaceId=agency;
 *  - assertAgencyOwns REJECTS a location that isn't the agency's child
 *    (cross-agency isolation: agency-B cannot touch agency-A's location);
 *  - a STANDALONE / LOCATION workspace cannot drive agency methods (the
 *    assertIsAgency gate throws Forbidden);
 *  - listLocations is scoped to the agency's own children only.
 */

const AGENCY_A = 'agency-a';
const AGENCY_B = 'agency-b';
const LOCATION_A1 = 'loc-a1';

function makeSvc() {
  const prisma = mockDeep<PrismaService>();
  // $transaction executes its callback against the mocked prisma as the tx.
  (prisma.$transaction as jest.Mock).mockImplementation(
    (fn: (tx: any) => Promise<any>) => fn(prisma),
  );
  const config = { get: jest.fn().mockReturnValue('10') } as unknown as ConfigService;
  const authService = {
    issueSession: jest.fn().mockReturnValue({ accessToken: 'at', refreshToken: 'rt', user: { id: 'owner-x' } }),
  };
  const svc = new AgencyService(prisma as any, config, authService as any);
  return { prisma, svc, authService };
}

const agencyRow = (over: Record<string, unknown> = {}) => ({
  id: AGENCY_A,
  kind: 'AGENCY',
  status: 'ACTIVE',
  ...over,
});

const locationRow = (over: Record<string, unknown> = {}) => ({
  id: LOCATION_A1,
  slug: 'loc-a1',
  name: 'Location A1',
  status: 'ACTIVE',
  kind: 'LOCATION',
  parentWorkspaceId: AGENCY_A,
  productName: 'Prod',
  productUrl: null,
  defaultLanguage: 'en',
  defaultCurrency: 'USD',
  timezone: 'UTC',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('AgencyService — createLocation', () => {
  it('creates a child workspace with kind=LOCATION and parentWorkspaceId=agency', async () => {
    const { prisma, svc } = makeSvc();

    // assertIsAgency
    (prisma.workspace.findUnique as jest.Mock).mockImplementation((args: any) => {
      // slug-collision probe inside the tx returns null (slug free); the
      // assertIsAgency read returns the agency row.
      if (args?.where?.id === AGENCY_A) return Promise.resolve(agencyRow());
      return Promise.resolve(null);
    });
    prisma.marketingUser.findUnique.mockResolvedValue(null as never); // email free

    let createdWorkspaceData: any;
    (prisma.workspace.create as jest.Mock).mockImplementation((args: any) => {
      createdWorkspaceData = args.data;
      return Promise.resolve(locationRow());
    });
    prisma.marketingUser.create.mockResolvedValue({ id: 'owner-1' } as never);
    prisma.marketingDistributionConfig.create.mockResolvedValue({ id: 'dist-1' } as never);

    const result = await svc.createLocation(AGENCY_A, {
      name: 'Location A1',
      productName: 'Prod',
      ownerEmail: 'owner@a1.com',
      ownerPassword: 'password123',
      ownerFirstName: 'Owen',
      ownerLastName: 'Owner',
    });

    expect(createdWorkspaceData.kind).toBe('LOCATION');
    expect(createdWorkspaceData.parentWorkspaceId).toBe(AGENCY_A);
    expect(result.kind).toBe('LOCATION');
    expect(result.parentWorkspaceId).toBe(AGENCY_A);

    // The owner is seeded under the CHILD workspace, not the agency.
    const ownerCreate = prisma.marketingUser.create.mock.calls.find(
      (c: any) => c[0]?.data?.role === 'OWNER',
    );
    expect(ownerCreate?.[0]?.data?.workspaceId).toBe(LOCATION_A1);
  });

  it('creates an ACTIVE OWNER membership for the new location owner', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id === AGENCY_A ? agencyRow() : null),
    );
    prisma.marketingUser.findUnique.mockResolvedValue(null as never); // email free
    (prisma.workspace.create as jest.Mock).mockResolvedValue(locationRow());
    prisma.marketingUser.create.mockResolvedValue({ id: 'owner-1' } as never);
    prisma.marketingDistributionConfig.create.mockResolvedValue({ id: 'dist-1' } as never);

    await svc.createLocation(AGENCY_A, {
      name: 'Location A1',
      productName: 'Prod',
      ownerEmail: 'owner@a1.com',
      ownerPassword: 'password123',
      ownerFirstName: 'Owen',
      ownerLastName: 'Owner',
    });

    expect(prisma.workspaceMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'owner-1',
          workspaceId: LOCATION_A1,
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('starts the new location on the TRIAL package so it is usable (not zero-entitlement) out of the box', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id === AGENCY_A ? agencyRow() : null),
    );
    prisma.marketingUser.findUnique.mockResolvedValue(null as never);
    (prisma.workspace.create as jest.Mock).mockResolvedValue(locationRow());
    prisma.marketingUser.create.mockResolvedValue({ id: 'owner-1' } as never);
    prisma.marketingDistributionConfig.create.mockResolvedValue({ id: 'dist-1' } as never);
    (prisma.package.findUnique as jest.Mock).mockResolvedValue({ id: 'pkg-trial', trialDays: 14 });
    prisma.workspaceSubscription.create.mockResolvedValue({ id: 'sub-1' } as never);

    await svc.createLocation(AGENCY_A, {
      name: 'Location A1', productName: 'Prod', ownerEmail: 'owner@a1.com',
      ownerPassword: 'password123', ownerFirstName: 'Owen', ownerLastName: 'Owner',
    });

    // Without this the location resolves to zeroEntitlements (every feature off,
    // every limit 0) — dead on arrival — since getEffective reads only the
    // location's own subscription and there's no parent-agency fallback.
    const subCreate = (prisma.workspaceSubscription.create as jest.Mock).mock.calls[0]?.[0]?.data;
    expect(subCreate).toMatchObject({ workspaceId: LOCATION_A1, packageId: 'pkg-trial', status: 'TRIALING' });
    expect(subCreate.trialEndsAt).toBeInstanceOf(Date);
  });

  it('rejects when the caller workspace is not an AGENCY (STANDALONE → 403)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(
      agencyRow({ id: 'ws-standalone', kind: 'STANDALONE' }) as never,
    );

    await expect(
      svc.createLocation('ws-standalone', {
        name: 'X',
        productName: 'Y',
        ownerEmail: 'o@x.com',
        ownerPassword: 'password123',
        ownerFirstName: 'O',
        ownerLastName: 'O',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('rejects when the caller workspace is a LOCATION (sub-account → 403)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(
      agencyRow({ id: LOCATION_A1, kind: 'LOCATION' }) as never,
    );

    await expect(svc.listLocations(LOCATION_A1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('409s when the owner email is already registered', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(agencyRow() as never);
    prisma.marketingUser.findUnique.mockResolvedValue({ id: 'existing' } as never);

    await expect(
      svc.createLocation(AGENCY_A, {
        name: 'X',
        productName: 'Y',
        ownerEmail: 'taken@x.com',
        ownerPassword: 'password123',
        ownerFirstName: 'O',
        ownerLastName: 'O',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a racing duplicate owner-email P2002 to a 409, not a raw 500', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id === AGENCY_A ? agencyRow() : null),
    );
    prisma.marketingUser.findUnique.mockResolvedValue(null as never); // pre-check passes
    (prisma.workspace.create as jest.Mock).mockResolvedValue(locationRow());
    // The owner INSERT loses the email-unique race inside the tx (a concurrent
    // createLocation with the same owner email passed the pre-check too).
    (prisma.marketingUser.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email'] },
      }),
    );

    await expect(
      svc.createLocation(AGENCY_A, {
        name: 'X',
        productName: 'Y',
        ownerEmail: 'race@x.com',
        ownerPassword: 'password123',
        ownerFirstName: 'O',
        ownerLastName: 'O',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AgencyService — assertAgencyOwns (cross-into-child guard)', () => {
  it('resolves a location the agency parents', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findFirst.mockResolvedValue(locationRow() as never);

    const loc = await svc.assertAgencyOwns(AGENCY_A, LOCATION_A1);
    expect(loc.id).toBe(LOCATION_A1);

    // The lookup must constrain by id + kind=LOCATION + parentWorkspaceId.
    const where = (prisma.workspace.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: LOCATION_A1,
      kind: 'LOCATION',
      parentWorkspaceId: AGENCY_A,
    });
  });

  it('REJECTS a location that belongs to a DIFFERENT agency (404, no leak)', async () => {
    const { prisma, svc } = makeSvc();
    // agency-B asks for agency-A's location: the parent-scoped findFirst
    // returns null (no row with parentWorkspaceId=agency-B), so it 404s.
    prisma.workspace.findFirst.mockResolvedValue(null as never);

    await expect(
      svc.assertAgencyOwns(AGENCY_B, LOCATION_A1),
    ).rejects.toBeInstanceOf(NotFoundException);

    const where = (prisma.workspace.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.parentWorkspaceId).toBe(AGENCY_B);
  });
});

describe('AgencyService — listLocations / suspendLocation scoping', () => {
  it('listLocations only returns the agency’s own children', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(agencyRow() as never);
    prisma.workspace.findMany.mockResolvedValue([locationRow()] as never);

    const list = await svc.listLocations(AGENCY_A);
    expect(list).toHaveLength(1);

    const where = (prisma.workspace.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ kind: 'LOCATION', parentWorkspaceId: AGENCY_A });
  });

  it('suspendLocation cannot touch another agency’s location (404 via guard)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(
      agencyRow({ id: AGENCY_B }) as never,
    );
    // assertAgencyOwns(agency-B, loc-a1) → null → 404 before any update.
    prisma.workspace.findFirst.mockResolvedValue(null as never);

    await expect(
      svc.suspendLocation(AGENCY_B, LOCATION_A1),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it('suspendLocation flips status to SUSPENDED, double-keyed on parent', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(agencyRow() as never);
    prisma.workspace.findFirst.mockResolvedValue(locationRow() as never);
    prisma.workspace.updateMany.mockResolvedValue({ count: 1 } as never);

    await svc.suspendLocation(AGENCY_A, LOCATION_A1, 'SUSPENDED');

    const updateArgs = (prisma.workspace.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({
      id: LOCATION_A1,
      kind: 'LOCATION',
      parentWorkspaceId: AGENCY_A,
    });
    expect(updateArgs.data).toEqual({ status: 'SUSPENDED' });
  });
});

describe('AgencyService — dashboard rollup', () => {
  it('counts only ACTIVE leads per location (excludes merged / soft-deleted)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(agencyRow() as never);
    prisma.workspace.findMany.mockResolvedValue([
      { id: 'loc-1', slug: 'l1', name: 'L1', status: 'ACTIVE', createdAt: new Date(0) },
    ] as never);
    (prisma.lead.count as jest.Mock).mockResolvedValue(5);
    (prisma.marketingUser.count as jest.Mock).mockResolvedValue(2);

    await svc.dashboard(AGENCY_A);

    // The per-location rollup must mirror each location's own list/dashboard,
    // which exclude consolidated duplicates (mergedIntoId) and bulk-deleted
    // (deletedAt) leads — otherwise the agency overcounts.
    expect(prisma.lead.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'loc-1',
          mergedIntoId: null,
          deletedAt: null,
        }),
      }),
    );
  });
});

describe('AgencyService — accessLocation (switch into a sub-account)', () => {
  const OWNER = {
    id: 'owner-1', workspaceId: LOCATION_A1, role: 'OWNER', email: 'o@l.com',
    firstName: 'O', lastName: 'L', phone: null, avatar: null, tokenVersion: 0,
  };
  const arm = (prisma: any, over: { location?: any; owner?: any } = {}) => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(agencyRow()); // assertIsAgency
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(over.location ?? locationRow()); // assertAgencyOwns
    (prisma.marketingUser.findFirst as jest.Mock).mockResolvedValue('owner' in over ? over.owner : OWNER);
  };

  it('mints a session for the location ACTIVE owner and returns it with the location', async () => {
    const { prisma, svc, authService } = makeSvc();
    arm(prisma);
    const out: any = await svc.accessLocation(AGENCY_A, LOCATION_A1, 'agency-owner-1');
    expect((prisma.marketingUser.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({
      workspaceId: LOCATION_A1, role: 'OWNER', status: 'ACTIVE',
    });
    // Issued FOR the owner → MarketingGuard's wsp===user.workspaceId invariant holds.
    expect(authService.issueSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner-1', workspaceId: LOCATION_A1 }),
      { workspaceId: LOCATION_A1, role: 'OWNER' },
    );
    expect(out).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(out.location.id).toBe(LOCATION_A1);
  });

  it('404s and mints NO session for a location the agency does not own', async () => {
    const { prisma, svc, authService } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(agencyRow());
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null); // assertAgencyOwns → 404
    await expect(svc.accessLocation(AGENCY_A, 'foreign', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(authService.issueSession).not.toHaveBeenCalled();
  });

  it('refuses to enter a SUSPENDED location', async () => {
    const { prisma, svc, authService } = makeSvc();
    arm(prisma, { location: locationRow({ status: 'SUSPENDED' }) });
    await expect(svc.accessLocation(AGENCY_A, LOCATION_A1, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(authService.issueSession).not.toHaveBeenCalled();
  });

  it('refuses when the location has no active owner to sign in as', async () => {
    const { prisma, svc, authService } = makeSvc();
    arm(prisma, { owner: null });
    await expect(svc.accessLocation(AGENCY_A, LOCATION_A1, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(authService.issueSession).not.toHaveBeenCalled();
  });
});
