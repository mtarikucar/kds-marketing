import { BadRequestException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Archiving a lead IS a LOST transition — it just used to be written by hand.
 *
 * `delete()` wrote `status: 'LOST'` straight to the row, skipping every side
 * effect `updateStatus` owns for that same transition: the timeline entry, the
 * assignee notification, the `lead.status_changed` automation trigger, and the
 * one with a daily cost — cancelling the lead's OPEN TASKS. `updateStatus`
 * cancels them because "the rep would never act on them"; archiving reached the
 * identical LOST state and left the follow-ups sitting in the rep's list for a
 * lead that had vanished from every view.
 */
describe('MarketingLeadsService.delete — archive runs the full LOST transition', () => {
  const WS = 'ws-1';
  const ACTOR = 'mgr-1';
  let prisma: MockPrismaClient;
  let outbox: { append: jest.Mock };
  let svc: MarketingLeadsService;

  const OPEN_LEAD = {
    id: 'lead-1',
    workspaceId: WS,
    status: 'CONTACTED',
    assignedToId: 'rep-9',
    businessName: 'Acme',
    convertedTenantId: null,
  } as any;

  beforeEach(() => {
    prisma = mockPrismaClient();
    outbox = { append: jest.fn().mockResolvedValue(undefined) };
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      outbox as any,
      { validateAndNormalize: jest.fn().mockResolvedValue({}) } as any,
      { verify: jest.fn().mockResolvedValue('UNKNOWN') } as any,
      {} as any,
    );
    prisma.lead.findFirst.mockResolvedValue(OPEN_LEAD);
    prisma.lead.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.lead.update.mockResolvedValue({ ...OPEN_LEAD, status: 'LOST' } as any);
    prisma.lead.findUniqueOrThrow.mockResolvedValue({ ...OPEN_LEAD, status: 'LOST' } as any);
    prisma.leadActivity.create.mockResolvedValue({} as any);
    prisma.marketingTask.updateMany.mockResolvedValue({ count: 2 } as any);
    prisma.marketingNotification.create.mockResolvedValue({} as any);
  });

  it('cancels the archived lead’s open tasks — the rep would never act on them', async () => {
    await svc.delete(WS, 'lead-1', ACTOR, 'MANAGER');
    expect(prisma.marketingTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WS,
          leadId: 'lead-1',
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        }),
        data: { status: 'CANCELLED' },
      }),
    );
  });

  it('records the archive on the lead timeline, attributed to the manager', async () => {
    await svc.delete(WS, 'lead-1', ACTOR, 'MANAGER');
    expect(prisma.leadActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'STATUS_CHANGE',
          leadId: 'lead-1',
          createdById: ACTOR,
          description: 'Reason: archived_by_manager',
        }),
      }),
    );
  });

  it('fires the lead.status_changed trigger so automations see the archive', async () => {
    await svc.delete(WS, 'lead-1', ACTOR, 'MANAGER');
    const call = outbox.append.mock.calls.find((c) =>
      String(c[0]?.type ?? '').includes('lead.status_changed'),
    );
    expect(call).toBeDefined();
    expect(call![0].payload).toMatchObject({ leadId: 'lead-1', fromStatus: 'CONTACTED', toStatus: 'LOST' });
  });

  it('tells the assignee their lead was archived by someone else', async () => {
    await svc.delete(WS, 'lead-1', ACTOR, 'MANAGER');
    expect(prisma.marketingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'rep-9' }) }),
    );
  });

  /**
   * The guard that must survive the delegation: a converted lead's tenant and
   * commission would dangle against a "lost" record.
   */
  it('still refuses to archive a converted lead, before touching anything', async () => {
    prisma.lead.findFirst.mockResolvedValue({ ...OPEN_LEAD, convertedTenantId: 'tenant-1' } as any);
    await expect(svc.delete(WS, 'lead-1', ACTOR, 'MANAGER')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.marketingTask.updateMany).not.toHaveBeenCalled();
  });

  it('still refuses a WON lead', async () => {
    prisma.lead.findFirst.mockResolvedValue({ ...OPEN_LEAD, status: 'WON' } as any);
    await expect(svc.delete(WS, 'lead-1', ACTOR, 'MANAGER')).rejects.toBeInstanceOf(BadRequestException);
  });
});
