jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: (_p: any, _n: string, fn: () => any) => fn(),
}));

import { MarketingSchedulerService } from './marketing-scheduler.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    workspace: { findMany: jest.fn().mockResolvedValue([{ id: WS }]) },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
    marketingNotification: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  // `leads` (MarketingLeadsService) is only used by the orphan-reconcile cron.
  const svc = new MarketingSchedulerService(prisma, {} as any);
  return { prisma, svc };
}

describe('MarketingSchedulerService.fireFollowUpReminders', () => {
  // Deferred-action-on-hidden-lead class: the daily 09:00 reminder cron loads
  // leads with a due nextFollowUp. A lead that was bulk-deleted (deletedAt) or
  // merged away (mergedIntoId) keeps its nextFollowUp/status/assignedToId, so
  // without the active-lead predicate the cron fires a FOLLOW_UP_REMINDER for a
  // lead that's gone from the rep's list — a phantom reminder linking to a
  // deleted/merged tombstone.
  it('excludes soft-deleted and merged leads from the due-lead query', async () => {
    const { prisma, svc } = makeSvc();
    await svc.fireFollowUpReminders();
    expect(prisma.lead.findMany).toHaveBeenCalledTimes(1);
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.mergedIntoId).toBeNull();
  });

  it('still reminds the owner of an active due lead', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([
      { id: 'l1', businessName: 'Acme', contactPerson: 'Joe', assignedToId: 'u1', nextFollowUp: new Date() },
    ]);
    await svc.fireFollowUpReminders();
    expect(prisma.marketingNotification.create).toHaveBeenCalledTimes(1);
    expect(prisma.marketingNotification.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: WS,
      userId: 'u1',
      type: 'FOLLOW_UP_REMINDER',
    });
  });
});
