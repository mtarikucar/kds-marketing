import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalRequestService } from './approval-request.service';

function makePrisma(found: any = { id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null }) {
  const update = jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    approvalRequest: {
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(found),
      update,
      updateMany,
    },
  } as any;
  return { prisma, update, updateMany };
}

describe('ApprovalRequestService', () => {
  it('enqueues a request with kind/summary/payload', async () => {
    const { prisma } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.enqueue('ws1', { kind: 'BUDGET_REALLOCATION', summary: 'move 200 to META', payload: { after: [] } });
    expect(prisma.approvalRequest.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: 'ws1', kind: 'BUDGET_REALLOCATION', summary: 'move 200 to META',
    });
  });

  it('approves a pending request via an ATOMIC conditional claim (single winner)', async () => {
    const { prisma, updateMany } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.approve('ws1', 'a1', 'user-9');
    // The decision write itself carries the PENDING predicate — two concurrent
    // decisions can never both land (the old read-check-then-update could).
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'PENDING' });
    expect(call.data).toMatchObject({ status: 'APPROVED', decidedById: 'user-9' });
    expect(call.data.decidedAt).toBeInstanceOf(Date);
  });

  it('rejects double-decision (claim matches 0 rows → already decided, never overwritten)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 }); // the PENDING predicate matches nothing
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toThrow(/already APPROVED/);
  });

  it('a CONCURRENT loser (read PENDING, lost the claim race) gets already-decided instead of overwriting', async () => {
    // The read still sees PENDING, but the conditional write finds the row
    // already claimed by the racer — the exact TOCTOU the old code lost:
    // a late REJECTED could overwrite an APPROVED (and even APPLIED) request
    // whose budget change had already been pushed live to the ad platform.
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.reject('ws1', 'a1', 'u')).rejects.toBeInstanceOf(BadRequestException);
    // And the only write attempted was the guarded claim — no unconditional update.
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
  });

  it('expires a past-due request instead of approving it (guarded flip, PENDING-only)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: new Date(Date.now() - 1000) });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toThrow(/expired/);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'PENDING' });
    expect(call.data).toEqual({ status: 'EXPIRED' });
  });

  it('404s a request from another workspace', async () => {
    const { prisma } = makePrisma(null);
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.reject('ws1', 'a-other', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only applies an APPROVED request (conditional claim on APPROVED)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 }); // APPROVED predicate matches nothing
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.markApplied('ws1', 'a1')).rejects.toThrow(/cannot apply a PENDING/);
  });

  it('markApplied claims APPROVED→APPLIED atomically', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
    const svc = new ApprovalRequestService(prisma);
    await svc.markApplied('ws1', 'a1');
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED' });
    expect(call.data).toMatchObject({ status: 'APPLIED' });
    expect(call.data.appliedAt).toBeInstanceOf(Date);
  });
});
