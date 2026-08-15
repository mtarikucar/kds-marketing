import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * The pipeline is forward-only by design — ALLOWED_TRANSITIONS has no edge
 * back to NEW from anywhere. That stops a rep walking a deal up and down the
 * stages, but it also means a stage entered by mistake can never be undone:
 * a demo that was never held, an offer that was never sent, stays in the
 * funnel forever and every metric derived from it is wrong.
 *
 * `reopen` is the one deliberate exception. It jumps straight to NEW rather
 * than opening backwards edges, and it costs a reason and a manager to do it.
 */
describe('MarketingLeadsService.reopen', () => {
  const WS = 'ws-1';
  const MGR = 'mgr-1';
  const REASON = 'demo was never held — the stage was entered by mistake';
  let prisma: MockPrismaClient;
  let outbox: { append: jest.Mock };
  let svc: MarketingLeadsService;

  const LEAD = {
    id: 'lead-1',
    workspaceId: WS,
    status: 'DEMO_SCHEDULED',
    assignedToId: 'rep-9',
    businessName: 'Acme',
    convertedTenantId: null,
    lostReason: null,
  } as any;

  const withLead = (patch: Record<string, unknown>) => {
    prisma.lead.findFirst.mockResolvedValue({ ...LEAD, ...patch });
    prisma.lead.findUniqueOrThrow.mockResolvedValue({ ...LEAD, ...patch, status: 'NEW' });
  };

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
    prisma.lead.findFirst.mockResolvedValue(LEAD);
    prisma.lead.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.lead.findUniqueOrThrow.mockResolvedValue({ ...LEAD, status: 'NEW' } as any);
    prisma.leadActivity.create.mockResolvedValue({} as any);
    prisma.marketingNotification.create.mockResolvedValue({} as any);
  });

  it('moves a mid-pipeline lead to NEW, which no ALLOWED_TRANSITIONS edge permits', async () => {
    const out = await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'NEW', lostReason: null } }),
    );
    expect(out.status).toBe('NEW');
  });

  it('guards the write with the original status, so a concurrent stage move is not clobbered', async () => {
    await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-1', workspaceId: WS, status: 'DEMO_SCHEDULED' },
      }),
    );

    prisma.lead.updateMany.mockResolvedValue({ count: 0 } as any);
    await expect(svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('records the rewind and its reason on the timeline — it must never be silent', async () => {
    await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(prisma.leadActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'STATUS_CHANGE',
        title: 'Reopened: DEMO_SCHEDULED → NEW',
        description: `Reason: ${REASON}`,
        leadId: 'lead-1',
        createdById: MGR,
      }),
    });
  });

  it('clears lostReason when reopening a lead that was written off', async () => {
    withLead({ status: 'LOST', lostReason: 'no budget' });
    await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'NEW', lostReason: null } }),
    );
  });

  it('refuses a rep — recycling your own dead deal as fresh work is the whole risk', async () => {
    await expect(svc.reopen(WS, 'lead-1', REASON, 'rep-9', 'REP')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a converted lead, which owns a live tenant and commission', async () => {
    withLead({ status: 'WON', convertedTenantId: 't-1' });
    await expect(svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op on a lead already at NEW, so it can be applied to a set', async () => {
    withLead({ status: 'NEW' });
    const out = await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(out.status).toBe('NEW');
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('emits lead.status_changed so automations stop treating it as late-stage', async () => {
    await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          leadId: 'lead-1',
          fromStatus: 'DEMO_SCHEDULED',
          toStatus: 'NEW',
        }),
      }),
    );
  });

  it('survives an outbox failure — the rewind is the point, the event is best-effort', async () => {
    outbox.append.mockRejectedValue(new Error('broker down'));
    await expect(svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER')).resolves.toMatchObject({
      status: 'NEW',
    });
  });

  it('notifies the owner, but not a manager acting on their own lead', async () => {
    await svc.reopen(WS, 'lead-1', REASON, MGR, 'MANAGER');
    expect(prisma.marketingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'rep-9', title: 'Lead reopened' }),
      }),
    );

    prisma.marketingNotification.create.mockClear();
    await svc.reopen(WS, 'lead-1', REASON, 'rep-9', 'MANAGER');
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });
});
