import { LeadAutoAssignerService } from './lead-auto-assigner.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    marketingDistributionConfig: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    marketingUser: { findMany: jest.fn().mockResolvedValue([]) },
    lead: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, svc: new LeadAutoAssignerService(prisma as any) };
}

describe('LeadAutoAssignerService.pickAssignee', () => {
  it('returns null when the strategy is DISABLED', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'DISABLED' });
    expect(await svc.pickAssignee(WS)).toBeNull();
  });

  it('returns null when there are no active reps', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'ROUND_ROBIN' });
    prisma.marketingUser.findMany.mockResolvedValue([]);
    expect(await svc.pickAssignee(WS)).toBeNull();
  });

  it('ROUND_ROBIN advances the cursor to the rep after the last-assigned one', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'ROUND_ROBIN', lastAssignedToId: 'r1' });
    prisma.marketingUser.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    const picked = await svc.pickAssignee(WS);
    expect(picked).toBe('r2');
    expect(prisma.marketingDistributionConfig.update.mock.calls[0][0].data.lastAssignedToId).toBe('r2');
  });

  it('LEAST_LOADED counts only ACTIVE leads (excludes terminal, merged, soft-deleted)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'LEAST_LOADED' });
    prisma.marketingUser.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    // r1 looks busy by raw rows, but the open-load query must exclude hidden ones.
    prisma.lead.groupBy.mockResolvedValue([{ assignedToId: 'r1', _count: { _all: 1 } }]);
    const picked = await svc.pickAssignee(WS);
    // r2 has 0 open → least loaded.
    expect(picked).toBe('r2');
    const where = prisma.lead.groupBy.mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ['WON', 'LOST'] });
    expect(where.mergedIntoId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });
});
