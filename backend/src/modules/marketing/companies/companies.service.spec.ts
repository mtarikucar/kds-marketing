import { NotFoundException } from '@nestjs/common';
import { CompaniesService } from './companies.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    company: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'c1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    lead: { findMany: jest.fn(), groupBy: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    opportunity: { aggregate: jest.fn() },
    conversation: { count: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (arr: any[]) => Promise.all(arr)),
  };
  const svc = new CompaniesService(prisma as any);
  return { svc, prisma };
}

describe('CompaniesService', () => {
  it('lists active companies with contact counts (one grouped read)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.findMany.mockResolvedValue([{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }]);
    prisma.lead.groupBy.mockResolvedValue([{ companyId: 'c1', _count: { _all: 3 } }]);
    const res = await svc.list(WS);
    expect(prisma.company.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, archived: false });
    expect(res.find((c: any) => c.id === 'c1').contactCount).toBe(3);
    expect(res.find((c: any) => c.id === 'c2').contactCount).toBe(0);
  });

  it('get returns the company with an opportunity/conversation rollup', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, name: 'Acme' });
    prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
    prisma.opportunity.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { value: 1500.5 } });
    prisma.conversation.count.mockResolvedValue(4);
    const res = await svc.get(WS, 'c1');
    expect(res).toMatchObject({ contactCount: 2, openOpportunities: 2, openValue: 1500.5, conversationCount: 4 });
    // rollup queries are workspace-scoped.
    expect(prisma.opportunity.aggregate.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: 'OPEN' });
  });

  it('get 404s an unknown company', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.findFirst.mockResolvedValue(null);
    await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get rolls up zero cleanly when the company has no contacts', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', workspaceId: WS, name: 'Acme' });
    prisma.lead.findMany.mockResolvedValue([]);
    const res = await svc.get(WS, 'c1');
    expect(res).toMatchObject({ contactCount: 0, openOpportunities: 0, openValue: 0, conversationCount: 0 });
    expect(prisma.opportunity.aggregate).not.toHaveBeenCalled();
  });

  it('delete detaches contacts (nulls companyId) then deletes, in one transaction', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1' });
    await svc.remove(WS, 'c1');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { workspaceId: WS, companyId: 'c1' }, data: { companyId: null } });
    expect(prisma.company.deleteMany).toHaveBeenCalledWith({ where: { id: 'c1', workspaceId: WS } });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('update 404s when the row is not in the workspace', async () => {
    const { svc, prisma } = makeSvc();
    prisma.company.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.update(WS, 'c1', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
