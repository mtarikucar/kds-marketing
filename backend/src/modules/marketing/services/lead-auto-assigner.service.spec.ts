import { LeadAutoAssignerService } from './lead-auto-assigner.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    marketingDistributionConfig: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    // Eligibility comes from the MEMBERSHIP (the only place role/status are updated).
    workspaceMembership: { findMany: jest.fn().mockResolvedValue([]) },
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
    prisma.workspaceMembership.findMany.mockResolvedValue([]);
    expect(await svc.pickAssignee(WS)).toBeNull();
  });

  it('ROUND_ROBIN advances the cursor to the rep after the last-assigned one', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'ROUND_ROBIN', lastAssignedToId: 'r1' });
    prisma.workspaceMembership.findMany.mockResolvedValue([{ userId: 'r1' }, { userId: 'r2' }, { userId: 'r3' }]);
    const picked = await svc.pickAssignee(WS);
    expect(picked).toBe('r2');
    expect(prisma.marketingDistributionConfig.update.mock.calls[0][0].data.lastAssignedToId).toBe('r2');
  });

  it('LEAST_LOADED counts only ACTIVE leads (excludes terminal, merged, soft-deleted)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ id: 'c1', strategy: 'LEAST_LOADED' });
    prisma.workspaceMembership.findMany.mockResolvedValue([{ userId: 'r1' }, { userId: 'r2' }]);
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

/**
 * Role/status are written ONLY to WorkspaceMembership; the MarketingUser
 * columns are frozen at creation. Reading those meant a promoted REP never
 * entered the round-robin and a demoted one never left it.
 */
describe('LeadAutoAssignerService — eligibility source of truth', () => {
  it('queries memberships, never the frozen MarketingUser columns', async () => {
    const { svc, prisma } = makeSvc();
    prisma.marketingDistributionConfig.findFirst.mockResolvedValue({ strategy: 'ROUND_ROBIN', lastAssignedToId: null });
    prisma.workspaceMembership.findMany.mockResolvedValue([{ userId: 'promoted-rep' }]);

    const picked = await svc.pickAssignee(WS);

    expect(picked).toBe('promoted-rep');
    expect(prisma.workspaceMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, role: 'REP', status: 'ACTIVE' } }),
    );
    expect(prisma.marketingUser?.findMany).toBeUndefined();
  });
});
