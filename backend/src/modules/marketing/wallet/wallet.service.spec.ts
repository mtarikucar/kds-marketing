import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService } from './wallet.service';

const WS = 'ws-1';
const LEAD = 'lead-1';

function makePrisma() {
  const prisma: any = {
    lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD }) },
    customerWallet: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({ id: 'w1', balance: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    walletLedgerEntry: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

describe('WalletService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: WalletService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new WalletService(prisma as any);
  });

  it('getWallet returns a 0 shell when the lead has no wallet (lead scoped)', async () => {
    prisma.customerWallet.findUnique.mockResolvedValue(null);
    const w = await svc.getWallet(WS, LEAD);
    expect(w).toMatchObject({ balance: 0, ledger: [] });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: LEAD, workspaceId: WS });
  });

  it('404s a lead in another workspace', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(svc.getWallet(WS, LEAD)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('credit increments the balance and logs a positive ledger entry', async () => {
    prisma.customerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 0 });
    prisma.customerWallet.findUnique.mockResolvedValue({ id: 'w1', balance: 5000 });
    await svc.credit(WS, LEAD, 5000, 'gift');
    expect(prisma.customerWallet.update.mock.calls[0][0].data).toEqual({ balance: { increment: 5000 } });
    const entry = prisma.walletLedgerEntry.create.mock.calls[0][0].data;
    expect(entry).toMatchObject({ workspaceId: WS, walletId: 'w1', delta: 5000 });
  });

  it('debit uses a balance-guarded conditional update (race-safe, never negative)', async () => {
    prisma.customerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 5000 });
    prisma.customerWallet.updateMany.mockResolvedValue({ count: 1 });
    prisma.customerWallet.findUnique.mockResolvedValue({ id: 'w1', balance: 2000 });
    await svc.debit(WS, LEAD, 3000);
    const upd = prisma.customerWallet.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'w1', workspaceId: WS, balance: { gte: 3000 } });
    expect(upd.data).toEqual({ balance: { increment: -3000 } });
  });

  it('debit throws Insufficient when the guarded update matches no row', async () => {
    prisma.customerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 1000 });
    prisma.customerWallet.updateMany.mockResolvedValue({ count: 0 }); // balance < amount
    await expect(svc.debit(WS, LEAD, 3000)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.walletLedgerEntry.create).not.toHaveBeenCalled();
  });
});
