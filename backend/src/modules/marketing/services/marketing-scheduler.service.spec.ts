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

/**
 * Abandoned OAuth hand-offs.
 *
 * A PendingSocialConnection holds a SEALED provider access token between the
 * OAuth callback and the moment the user picks which assets to connect. The
 * happy path deletes it, and each read rejects-and-deletes an expired row — but
 * a flow the user abandons (closes the tab after the callback) is never read
 * again, so nothing removed it. The row, and the token inside it, stayed for
 * good. There was no sweeper anywhere in the repo.
 */
describe('MarketingSchedulerService.sweepExpiredPendingConnections', () => {
  const build = (count = 3) => {
    const prisma: any = {
      pendingSocialConnection: { deleteMany: jest.fn().mockResolvedValue({ count }) },
    };
    return { prisma, svc: new MarketingSchedulerService(prisma, {} as any) };
  };

  it('deletes only rows whose expiry has passed', async () => {
    const { prisma, svc } = build();

    const res = await svc.sweepExpiredPendingConnections();

    const where = prisma.pendingSocialConnection.deleteMany.mock.calls[0][0].where;
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(Object.keys(where)).toEqual(['expiresAt']);
    expect(res).toEqual({ deleted: 3 });
  });

  it('does NOT scope the sweep per workspace', async () => {
    const { prisma, svc } = build();

    await svc.sweepExpiredPendingConnections();

    // Every other sweep here loops ACTIVE workspaces, which is right for their
    // data. A secret abandoned by a suspended or deleted workspace is exactly
    // the one that must not be kept, and a per-workspace loop would skip it.
    const where = prisma.pendingSocialConnection.deleteMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBeUndefined();
  });

  it('reports zero without failing when there is nothing to sweep', async () => {
    const { svc } = build(0);
    await expect(svc.sweepExpiredPendingConnections()).resolves.toEqual({ deleted: 0 });
  });
});
