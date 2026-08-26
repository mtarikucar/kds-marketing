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

/**
 * Approvals whose window has closed.
 *
 * PENDING -> EXPIRED happened in exactly one place: inside decide(), when a
 * human clicked approve or reject on a card that had already lapsed. So an
 * expired request nobody touched stayed PENDING for good — the queue offered
 * it as actionable, the morning brief counted it every day, and clicking it
 * only ever answered "request has expired".
 *
 * A count that can never reach zero is the line that teaches the owner to skip
 * the section — and that section now carries "a customer is waiting".
 */
describe('MarketingSchedulerService.expireStaleApprovals', () => {
  const WS = 'ws-1';

  const build = (count = 2) => {
    const prisma: any = {
      workspace: { findMany: jest.fn().mockResolvedValue([{ id: WS }]) },
      approvalRequest: { updateMany: jest.fn().mockResolvedValue({ count }) },
    };
    return { prisma, svc: new MarketingSchedulerService(prisma, {} as any) };
  };

  it('retires only lapsed requests that are still PENDING', async () => {
    const { prisma, svc } = build();

    const res = await svc.expireStaleApprovals();

    const call = prisma.approvalRequest.updateMany.mock.calls[0][0];
    expect(call.where.status).toBe('PENDING');
    expect(call.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(call.data).toEqual({ status: 'EXPIRED' });
    expect(res).toEqual({ expired: 2 });
  });

  it('never clobbers a decision made in the same tick', async () => {
    const { prisma, svc } = build();

    await svc.expireStaleApprovals();

    // Same guard decide() writes under: an APPROVED or REJECTED row is not
    // PENDING, so it cannot be swept out from under the person who decided it.
    expect(prisma.approvalRequest.updateMany.mock.calls[0][0].where.status).toBe('PENDING');
  });

  it('scopes the sweep per workspace', async () => {
    const { prisma, svc } = build();

    await svc.expireStaleApprovals();

    expect(prisma.approvalRequest.updateMany.mock.calls[0][0].where.workspaceId).toBe(WS);
  });

  it('reports zero without failing when nothing has lapsed', async () => {
    const { svc } = build(0);
    await expect(svc.expireStaleApprovals()).resolves.toEqual({ expired: 0 });
  });
});

/**
 * Calls abandoned in INITIATED.
 *
 * The lazy cleanup inside SalesCallService.dial() was never wrong — it just
 * only runs when someone places the NEXT call. On the live workspace one row
 * has been sitting in INITIATED since 15 August because nobody dialled again,
 * and every reader that treats INITIATED as "in progress" has been believing
 * it since.
 */
describe('MarketingSchedulerService.cancelAbandonedCalls', () => {
  const make = (updated: number) => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      workspace: { findMany: jest.fn().mockResolvedValue([{ id: 'ws1' }, { id: 'ws2' }]) },
      salesCall: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    };
    return { prisma, svc: new MarketingSchedulerService(prisma as never, {} as never) };
  };

  it('only ever touches rows that are still INITIATED', async () => {
    const { prisma, svc } = make(1);
    await svc.cancelAbandonedCalls();

    for (const call of prisma.salesCall.updateMany.mock.calls) {
      // Without this guard the write races the CDR reconciler and can regress a
      // row it has already moved to CONNECTED — losing that call's duration and
      // recording for good.
      expect(call[0].where.status).toBe('INITIATED');
      expect(call[0].data.status).toBe('CANCELLED');
    }
  });

  it('scopes every write to one workspace', async () => {
    const { prisma, svc } = make(1);
    await svc.cancelAbandonedCalls();

    const scopes = prisma.salesCall.updateMany.mock.calls.map((c) => c[0].where.workspaceId);
    expect(scopes).toEqual(['ws1', 'ws2']);
  });

  it('uses a far longer cutoff than the dial path, and reports the total', async () => {
    const { prisma, svc } = make(2);
    const before = Date.now();
    const out = await svc.cancelAbandonedCalls();

    // dial() sweeps at 30 minutes because a rep is standing there; this one runs
    // unattended, so it waits long enough that a live call or an in-flight CDR
    // cannot be caught by it.
    const cutoff = prisma.salesCall.updateMany.mock.calls[0][0].where.startedAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 5_000);
    expect(out).toEqual({ cancelled: 4 });
  });
});
