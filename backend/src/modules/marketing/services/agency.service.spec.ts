import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
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
  const svc = new AgencyService(prisma as any, config);
  return { prisma, svc };
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
