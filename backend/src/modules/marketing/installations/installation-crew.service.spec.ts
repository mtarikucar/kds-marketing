import { NotFoundException } from '@nestjs/common';
import { InstallationCrewService } from './installation-crew.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

describe('InstallationCrewService', () => {
  let prisma: MockPrismaClient;
  let svc: InstallationCrewService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new InstallationCrewService(prisma as any);
  });

  it('creates a crew in the workspace with a default daily capacity of 1', async () => {
    prisma.installationCrew.create.mockResolvedValue({ id: 'c1' } as any);
    await svc.create(WS, { name: 'Crew A' } as any);
    expect(prisma.installationCrew.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: WS, name: 'Crew A', dailyCapacity: 1 }),
      }),
    );
  });

  it('lists only the workspace crews', async () => {
    prisma.installationCrew.findMany.mockResolvedValue([] as any);
    await svc.list(WS, true);
    expect(prisma.installationCrew.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, active: true } }),
    );
  });

  it('404s an update against a crew from another workspace (scoped lookup misses)', async () => {
    prisma.installationCrew.findFirst.mockResolvedValue(null);
    await expect(svc.update(WS, 'foreign-crew', { name: 'X' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.installationCrew.update).not.toHaveBeenCalled();
  });

  it('computes per-crew availability on a date (booked < capacity)', async () => {
    prisma.installationCrew.findMany.mockResolvedValue([
      { id: 'c1', name: 'A', dailyCapacity: 2 },
      { id: 'c2', name: 'B', dailyCapacity: 1 },
    ] as any);
    // Cast — DeepMockProxy's groupBy signature materialises Prisma's circular
    // `having` type (TS2615) on access.
    (prisma.installationJob.groupBy as any).mockResolvedValue([
      { crewId: 'c1', _count: 1 },
      { crewId: 'c2', _count: 1 },
    ]);

    const avail = await svc.availabilityOn(WS, new Date('2026-06-10'));

    // Both the crew list and the booked-count aggregation are scoped.
    expect(prisma.installationCrew.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, active: true } }),
    );
    expect(prisma.installationJob.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
    expect(avail).toEqual([
      { crew: { id: 'c1', name: 'A', dailyCapacity: 2 }, booked: 1, available: true },
      { crew: { id: 'c2', name: 'B', dailyCapacity: 1 }, booked: 1, available: false },
    ]);
  });

  it('reports a crew with no bookings as fully available', async () => {
    prisma.installationCrew.findMany.mockResolvedValue([
      { id: 'c1', name: 'A', dailyCapacity: 1 },
    ] as any);
    (prisma.installationJob.groupBy as any).mockResolvedValue([]);

    const avail = await svc.availabilityOn(WS, new Date('2026-06-10'));

    expect(avail).toEqual([
      { crew: { id: 'c1', name: 'A', dailyCapacity: 1 }, booked: 0, available: true },
    ]);
  });
});
