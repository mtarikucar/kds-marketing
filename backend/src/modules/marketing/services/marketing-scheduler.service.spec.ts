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
  const svc = new MarketingSchedulerService(prisma, {} as any, {} as any, {} as any);
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
    return { prisma, svc: new MarketingSchedulerService(prisma, {} as any, {} as any, {} as any) };
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
    return { prisma, svc: new MarketingSchedulerService(prisma, {} as any, {} as any, {} as any) };
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
    return { prisma, svc: new MarketingSchedulerService(prisma as never, {} as never, {} as never, {} as never) };
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

/**
 * `no-retention` — the periodic destruction job.
 *
 * Per-subject erasure already works (compliance.service.ts) and recordings
 * already age out; what did not exist was a TIME-based sweep, so email bodies,
 * inbound ledger rows, tracked clicks, AI tool logs and finished workflow
 * contexts were kept for good against a privacy notice that promises deletion.
 *
 * The knob is per workspace and ABSENT by default: an existing tenant keeps
 * every row until an operator chooses a period (G3). The two sibling paths a
 * naive purge would break are asserted below — the campaign stats recomputed
 * from recipient rows, and the Message row whose `externalMessageId` is the
 * IMAP dedupe token.
 */
describe('MarketingSchedulerService.purgeExpiredData', () => {
  const WS = 'ws-1';

  const build = (retention: unknown, counts: Record<string, number> = {}) => {
    const n = (k: string) => ({ count: counts[k] ?? 0 });
    const prisma: any = {
      workspace: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: WS, settings: retention === undefined ? null : { retention } }]),
      },
      triggerLinkClick: {
        updateMany: jest.fn().mockResolvedValue(n('triggerLinkClick')),
        count: jest.fn().mockResolvedValue(counts.triggerLinkClick ?? 0),
      },
      toolCallLog: {
        deleteMany: jest.fn().mockResolvedValue(n('toolCallLog')),
        count: jest.fn().mockResolvedValue(counts.toolCallLog ?? 0),
      },
      workflowRun: {
        findMany: jest.fn().mockResolvedValue(counts.workflowRun ? [{ id: 'run-1' }] : []),
        deleteMany: jest.fn().mockResolvedValue(n('workflowRun')),
      },
      workflowStepRun: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      mailLog: {
        deleteMany: jest.fn().mockResolvedValue(n('mailLog')),
        count: jest.fn().mockResolvedValue(counts.mailLog ?? 0),
      },
      emailInboundItem: {
        deleteMany: jest.fn().mockResolvedValue(n('emailInboundItem')),
        count: jest.fn().mockResolvedValue(counts.emailInboundItem ?? 0),
      },
      message: {
        updateMany: jest.fn().mockResolvedValue(n('message')),
        count: jest.fn().mockResolvedValue(counts.message ?? 0),
      },
      netgsmWebhookEvent: {
        deleteMany: jest.fn().mockResolvedValue(n('netgsmWebhookEvent')),
        count: jest.fn().mockResolvedValue(counts.netgsmWebhookEvent ?? 0),
      },
      campaignRecipient: { deleteMany: jest.fn() },
    };
    return { prisma, svc: new MarketingSchedulerService(prisma, {} as any, {} as any, {} as any) };
  };

  const FULL = {
    triggerClickDays: 90,
    toolCallDays: 30,
    workflowRunDays: 60,
    mailLogDays: 180,
    inboundItemDays: 90,
    messageBodyDays: 365,
  };

  it('does nothing at all for a workspace that never set a period', async () => {
    const { prisma, svc } = build(undefined);

    const out = await svc.purgeExpiredData();

    expect(prisma.toolCallLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mailLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(prisma.triggerLinkClick.updateMany).not.toHaveBeenCalled();
    expect(out.toolCallLogsDeleted).toBe(0);
  });

  it('scopes every single write to the workspace and to rows past that category cutoff', async () => {
    const { prisma, svc } = build(FULL, { toolCallLog: 3, mailLog: 5 });
    const before = Date.now();

    await svc.purgeExpiredData();

    const tool = prisma.toolCallLog.deleteMany.mock.calls[0][0].where;
    expect(tool.workspaceId).toBe(WS);
    expect(before - tool.createdAt.lt.getTime()).toBeGreaterThanOrEqual(
      30 * 24 * 60 * 60 * 1000 - 5_000,
    );
    const mail = prisma.mailLog.deleteMany.mock.calls[0][0].where;
    expect(mail.workspaceId).toBe(WS);
    expect(before - mail.createdAt.lt.getTime()).toBeGreaterThanOrEqual(
      180 * 24 * 60 * 60 * 1000 - 5_000,
    );
  });

  it('ignores a period below the category floor instead of destroying live data', async () => {
    const { prisma, svc } = build({ messageBodyDays: 3, toolCallDays: 0, mailLogDays: -1 });

    await svc.purgeExpiredData();

    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(prisma.toolCallLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mailLog.deleteMany).not.toHaveBeenCalled();
  });

  it('SCRUBS message bodies in place — the row and its dedupe token survive', async () => {
    const { prisma, svc } = build(FULL, { message: 7 });

    const out = await svc.purgeExpiredData();

    // Deleting the row would drop `externalMessageId`, the only thing stopping
    // the IMAP poller re-ingesting the same mail as a duplicate inbox item.
    expect(prisma.message.deleteMany).toBeUndefined();
    const call = prisma.message.updateMany.mock.calls[0][0];
    expect(call.where.workspaceId).toBe(WS);
    expect(call.data).toEqual({ body: '[Silinmiş]' });
    // Idempotent: an already-scrubbed row is not rewritten every night.
    expect(call.where.body).toEqual({ not: '[Silinmiş]' });
    expect(out.messageBodiesScrubbed).toBe(7);
  });

  it('ANONYMISES tracked clicks instead of deleting them — the click count is a tenant-visible stat', async () => {
    const { prisma, svc } = build(FULL, { triggerLinkClick: 4 });

    const out = await svc.purgeExpiredData();

    const call = prisma.triggerLinkClick.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ ip: null, userAgent: null, leadId: null });
    expect(call.where.workspaceId).toBe(WS);
    expect(out.triggerClicksAnonymised).toBe(4);
  });

  it('never purges campaign recipients (their rows ARE the campaign report)', async () => {
    const { prisma, svc } = build(FULL);

    await svc.purgeExpiredData();

    // recomputeStats() derives sent/failed/opened/clicked FROM these rows and is
    // re-triggered long after the send, so purging them silently zeroes a
    // historic campaign report.
    expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
  });

  it('purges only finished workflow runs, step rows first', async () => {
    const { prisma, svc } = build(FULL, { workflowRun: 1 });

    await svc.purgeExpiredData();

    const where = prisma.workflowRun.findMany.mock.calls[0][0].where;
    // RUNNING / WAITING carry live execution state in cursor + context.
    expect(where.status).toEqual({ in: ['DONE', 'FAILED', 'STOPPED'] });
    expect(where.workspaceId).toBe(WS);
    // WorkflowStepRun has no FK to its run, so deleting the run first orphans them.
    const stepOrder = prisma.workflowStepRun.deleteMany.mock.invocationCallOrder[0];
    const runOrder = prisma.workflowRun.deleteMany.mock.invocationCallOrder[0];
    expect(stepOrder).toBeLessThan(runOrder);
    expect(prisma.workflowStepRun.deleteMany.mock.calls[0][0].where).toEqual({
      workspaceId: WS,
      runId: { in: ['run-1'] },
    });
  });

  it('keeps inbound ledger rows a human still needs — only DONE and SKIPPED age out', async () => {
    const { prisma, svc } = build(FULL, { emailInboundItem: 2 });

    await svc.purgeExpiredData();

    const where = prisma.emailInboundItem.deleteMany.mock.calls[0][0].where;
    // NEW / FAILED are still retryable and QUARANTINED is the one the channel
    // card offers a "Tekrar dene" button for.
    expect(where.state).toEqual({ in: ['DONE', 'SKIPPED'] });
    expect(where.workspaceId).toBe(WS);
  });

  it('drops archived provider payloads only once they have been processed', async () => {
    const { prisma, svc } = build({ webhookEventDays: 60 }, { netgsmWebhookEvent: 9 });

    const out = await svc.purgeExpiredData();

    const where = prisma.netgsmWebhookEvent.deleteMany.mock.calls[0][0].where;
    // An unprocessed archive row is still work in hand, and its (workspace,
    // purpose, externalId) key is what stops a provider redelivery running twice.
    expect(where.processedAt).toEqual({ not: null });
    expect(where.workspaceId).toBe(WS);
    expect(out.webhookEventsDeleted).toBe(9);
  });

  it('keeps sweeping the other workspaces when one of them fails', async () => {
    const prisma: any = {
      workspace: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'ws-a', settings: { retention: { toolCallDays: 30 } } },
          { id: 'ws-b', settings: { retention: { toolCallDays: 30 } } },
        ]),
      },
      toolCallLog: {
        deleteMany: jest
          .fn()
          .mockRejectedValueOnce(new Error('deadlock detected'))
          .mockResolvedValueOnce({ count: 2 }),
      },
    };
    const svc = new MarketingSchedulerService(prisma, {} as any, {} as any, {} as any);

    const out = await svc.purgeExpiredData();

    expect(prisma.toolCallLog.deleteMany).toHaveBeenCalledTimes(2);
    expect(out.toolCallLogsDeleted).toBe(2);
  });

  it('a dry run reports the same counts and writes nothing', async () => {
    const { prisma, svc } = build(FULL, {
      toolCallLog: 3,
      mailLog: 5,
      emailInboundItem: 2,
      message: 7,
      triggerLinkClick: 4,
    });

    const out = await svc.purgeExpiredData({ dryRun: true });

    expect(out).toEqual(
      expect.objectContaining({
        dryRun: true,
        toolCallLogsDeleted: 3,
        mailLogsDeleted: 5,
        inboundItemsDeleted: 2,
        messageBodiesScrubbed: 7,
        triggerClicksAnonymised: 4,
      }),
    );
    expect(prisma.toolCallLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mailLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(prisma.triggerLinkClick.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowRun.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * `erasure-calendar` — the sweep that carries an erasure onto the mirrored
 * Google / Outlook events.
 *
 * `fulfillErasure` scrubs the Booking row inside one transaction and emits
 * nothing, and neither sync service subscribes to anything but BookingCreated /
 * BookingCancelled — so the host's calendar kept the erased person's name,
 * notes and address. The sweep reads the scrub the erasure already wrote
 * (`deletedAt` + the erased marker on the lead) and re-issues it against the
 * provider copies, which also makes it self-healing: a mailbox that was
 * disconnected when the erasure ran is scrubbed on the next pass.
 */
describe('MarketingSchedulerService.scrubErasedCalendarCopies', () => {
  const WS = 'ws-1';

  const build = (leads: any[], bookings: any[]) => {
    const prisma: any = {
      workspace: { findMany: jest.fn().mockResolvedValue([{ id: WS }]) },
      lead: { findMany: jest.fn().mockResolvedValue(leads) },
      booking: { findMany: jest.fn().mockResolvedValue(bookings) },
    };
    const google = { scrubBooking: jest.fn().mockResolvedValue(true) };
    const outlook = { scrubBooking: jest.fn().mockResolvedValue(true) };
    return {
      prisma,
      google,
      outlook,
      svc: new MarketingSchedulerService(prisma, {} as any, google as any, outlook as any),
    };
  };

  it('scrubs both provider copies of an erased person’s booking', async () => {
    const { google, outlook, svc } = build(
      [{ id: 'lead-1' }],
      [{ id: 'b-1', googleEventId: 'g1', outlookEventId: 'o1' }],
    );

    const out = await svc.scrubErasedCalendarCopies();

    expect(google.scrubBooking).toHaveBeenCalledWith(WS, 'b-1');
    expect(outlook.scrubBooking).toHaveBeenCalledWith(WS, 'b-1');
    expect(out).toEqual({ scanned: 1, scrubbed: 2 });
  });

  it('only looks at leads the ERASURE scrubbed, not every soft-deleted lead', async () => {
    const { prisma, svc } = build([], []);

    await svc.scrubErasedCalendarCopies();

    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
    expect(where.contactPerson).toBe('[Silinmiş]');
    expect(where.deletedAt.gte).toBeInstanceOf(Date);
  });

  it('asks the provider only for the mirror the booking actually has', async () => {
    const { google, outlook, svc } = build(
      [{ id: 'lead-1' }],
      [{ id: 'b-1', googleEventId: null, outlookEventId: 'o1' }],
    );

    await svc.scrubErasedCalendarCopies();

    expect(google.scrubBooking).not.toHaveBeenCalled();
    expect(outlook.scrubBooking).toHaveBeenCalledWith(WS, 'b-1');
  });

  it('never queries bookings when the workspace has no erased lead in the window', async () => {
    const { prisma, google, svc } = build([], []);

    await svc.scrubErasedCalendarCopies();

    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(google.scrubBooking).not.toHaveBeenCalled();
  });

  it('keeps going when one provider call fails', async () => {
    const { google, outlook, svc } = build(
      [{ id: 'lead-1' }],
      [
        { id: 'b-1', googleEventId: 'g1', outlookEventId: null },
        { id: 'b-2', googleEventId: 'g2', outlookEventId: null },
      ],
    );
    google.scrubBooking
      .mockRejectedValueOnce(new Error('token revoked'))
      .mockResolvedValueOnce(true);

    const out = await svc.scrubErasedCalendarCopies();

    expect(google.scrubBooking).toHaveBeenCalledTimes(2);
    expect(outlook.scrubBooking).not.toHaveBeenCalled();
    expect(out).toEqual({ scanned: 2, scrubbed: 1 });
  });
});
