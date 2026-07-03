import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { BudgetPacerService } from './budget-pacer.service';

const D = (n: number) => new Prisma.Decimal(n);

function makeDeps(budget: any, prevPacing: any, netSpent: number) {
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = {
    growthBudget: { findFirst: jest.fn().mockResolvedValue(budget) },
    pacingState: { findUnique: jest.fn().mockResolvedValue(prevPacing), upsert },
  } as any;
  const ledger = { netSpent: jest.fn().mockResolvedValue(D(netSpent)) } as any;
  return { prisma, ledger, upsert };
}

describe('BudgetPacerService', () => {
  it('throws when the budget is missing', async () => {
    const { prisma, ledger } = makeDeps(null, null, 0);
    const svc = new BudgetPacerService(prisma, ledger);
    await expect(svc.tick('ws1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('computes and persists pacing from ledger spend + budget period', async () => {
    const { prisma, ledger, upsert } = makeDeps(
      { totalAmount: D(3000), periodKey: '2026-07' },
      null,
      1500,
    );
    const svc = new BudgetPacerService(prisma, ledger);
    const out = await svc.tick('ws1', 'b1', new Date('2026-07-16T00:00:00Z'));
    expect(ledger.netSpent).toHaveBeenCalledWith('ws1', 'b1');
    expect(out.status).toBe('ON_PACE'); // ~half spent at ~half month
    const data = upsert.mock.calls[0][0];
    expect(data.where).toEqual({ budgetId_channel: { budgetId: 'b1', channel: '' } });
    expect(data.create.spentToDate.toString()).toBe('1500');
    expect(data.create.status).toBe('ON_PACE');
  });

  it('carries the PID integral forward from persisted state', async () => {
    const { prisma, ledger } = makeDeps(
      { totalAmount: D(3000), periodKey: '2026-07' },
      { pidIntegral: D(200), pidLastError: D(50) },
      500,
    );
    const svc = new BudgetPacerService(prisma, ledger);
    const out = await svc.tick('ws1', 'b1', new Date('2026-07-16T00:00:00Z'));
    // integral = prev(200) + error; error = ideal - spent > 0 (underspending)
    expect(out.status).toBe('UNDERSPENDING');
    expect(out.integral).toBeGreaterThan(200);
  });
});
