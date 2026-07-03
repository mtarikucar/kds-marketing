import { Prisma } from '@prisma/client';
import { SpendLedgerService } from './spend-ledger.service';

const D = (n: string | number) => new Prisma.Decimal(n);

/** In-memory ledger prisma mock: keeps rows and serves the latest balance. */
function makePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
    spendLedger: {
      findFirst: jest.fn(async ({ where }: any) => {
        const match = rows
          .filter((r) => r.workspaceId === where.workspaceId && r.budgetId === where.budgetId)
          .sort((a, b) => b._seq - a._seq)[0];
        return match ? { balanceAfter: match.balanceAfter } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `row-${++seq}`, _seq: seq };
        rows.push(row);
        return { id: row.id, balanceAfter: row.balanceAfter };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    spendLedger: {
      findFirst: tx.spendLedger.findFirst,
    },
  } as any;
  return { prisma, tx, rows };
}

describe('SpendLedgerService', () => {
  it('debits as a negative delta and accumulates balanceAfter', async () => {
    const { prisma, tx } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    const r1 = await svc.debit('ws1', { channel: 'SMS', amount: 0.9, reason: 'SMS', ref: 'msg-1' });
    expect(r1.balanceAfter.toString()).toBe('-0.9');
    const r2 = await svc.debit('ws1', { channel: 'VOICE', amount: 1.1, reason: 'VOICE' });
    expect(r2.balanceAfter.toString()).toBe('-2');
    // advisory lock taken each time
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('credits (refund) as a positive delta', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    await svc.debit('ws1', { channel: 'SMS', amount: 5, reason: 'SMS' });
    const r = await svc.credit('ws1', { channel: 'SMS', amount: 2, reason: 'REFUND' });
    expect(r.balanceAfter.toString()).toBe('-3');
  });

  it('normalizes a negative input amount to a spend (abs then sign)', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    const r = await svc.debit('ws1', { channel: 'CONTENT', amount: -4, reason: 'CONTENT_GEN' });
    expect(r.balanceAfter.toString()).toBe('-4');
  });

  it('partitions balance by budgetId', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    await svc.debit('ws1', { channel: 'META', amount: 100, reason: 'AD_WRITE', budgetId: 'b1' });
    await svc.debit('ws1', { channel: 'META', amount: 10, reason: 'AD_WRITE' }); // budget null
    expect((await svc.netSpent('ws1', 'b1')).toString()).toBe('100');
    expect((await svc.netSpent('ws1')).toString()).toBe('10');
  });

  it('netSpent returns 0 for an untouched partition', async () => {
    const { prisma } = makePrisma();
    const svc = new SpendLedgerService(prisma);
    expect((await svc.netSpent('ws-empty')).toString()).toBe('0');
  });
});
