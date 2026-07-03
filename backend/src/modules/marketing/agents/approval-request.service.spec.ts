import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalRequestService } from './approval-request.service';

function makePrisma(found: any = { id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null }) {
  const update = jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
  const prisma = {
    approvalRequest: {
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(found),
      update,
    },
  } as any;
  return { prisma, update };
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

  it('approves a pending request and stamps the decider', async () => {
    const { prisma, update } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.approve('ws1', 'a1', 'user-9');
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'APPROVED', decidedById: 'user-9' });
    expect(update.mock.calls[0][0].data.decidedAt).toBeInstanceOf(Date);
  });

  it('rejects double-decision', async () => {
    const { prisma } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('expires a past-due request instead of approving it', async () => {
    const { prisma, update } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: new Date(Date.now() - 1000) });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toThrow(/expired/);
    expect(update.mock.calls[0][0].data).toEqual({ status: 'EXPIRED' });
  });

  it('404s a request from another workspace', async () => {
    const { prisma } = makePrisma(null);
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.reject('ws1', 'a-other', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only applies an APPROVED request', async () => {
    const { prisma } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.markApplied('ws1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
