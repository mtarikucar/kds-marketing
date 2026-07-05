import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BudgetActivityService } from './budget-activity.service';

const D = (n: number) => new Prisma.Decimal(n);

/**
 * Activity Log (spec D14): the trust surface that REPLACES the approval queue
 * for autonomous budgets — a merged, time-desc feed of what the engine did.
 */
function make(over: { budget?: any; runs?: any[]; ledger?: any[]; wallet?: any[] } = {}) {
  const prisma = {
    growthBudget: { findFirst: jest.fn().mockResolvedValue(over.budget === undefined ? { id: 'b1' } : over.budget) },
    autopilotRun: { findMany: jest.fn().mockResolvedValue(over.runs ?? []) },
    spendLedger: { findMany: jest.fn().mockResolvedValue(over.ledger ?? []) },
    growthWalletLedgerEntry: { findMany: jest.fn().mockResolvedValue(over.wallet ?? []) },
  } as any;
  const svc = new BudgetActivityService(prisma);
  return { prisma, svc };
}

describe('BudgetActivityService', () => {
  it('404s for a budget outside the workspace (scoping)', async () => {
    const { svc, prisma } = make({ budget: null });
    await expect(svc.activity('ws1', 'b-other')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.growthBudget.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'b-other', workspaceId: 'ws1' }) }),
    );
  });

  it('merges runs + spend + wallet movements into one time-desc feed', async () => {
    const { svc } = make({
      runs: [{ id: 'r1', kind: 'REALLOCATION', autonomy: 'AUTO', ok: true, createdAt: new Date('2026-07-05T10:00:00Z'), before: null, after: null, objective: null }],
      ledger: [{ id: 's1', channel: 'META', reason: 'AD_SPEND', delta: D(-40), balanceAfter: D(-40), ref: 'admetric:c1:2026-07-05', createdAt: new Date('2026-07-05T11:00:00Z') }],
      wallet: [{ id: 'w1', kind: 'TOPUP', delta: D(500), balanceAfter: D(500), ref: 'order:o1', note: null, createdAt: new Date('2026-07-05T09:00:00Z') }],
    });

    const feed = await svc.activity('ws1', 'b1');

    expect(feed.map((f) => f.type)).toEqual(['SPEND', 'RUN', 'WALLET']); // 11:00, 10:00, 09:00
    expect(feed[0]).toMatchObject({ type: 'SPEND', ts: new Date('2026-07-05T11:00:00Z') });
    expect(feed[1].data).toMatchObject({ autonomy: 'AUTO', kind: 'REALLOCATION' });
    expect(feed[2].data).toMatchObject({ kind: 'TOPUP' });
  });

  it('respects the limit after merging', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, kind: 'REALLOCATION', autonomy: 'SHADOW', ok: true,
      createdAt: new Date(Date.UTC(2026, 6, 1 + i)), before: null, after: null, objective: null,
    }));
    const { svc } = make({ runs });
    const feed = await svc.activity('ws1', 'b1', 3);
    expect(feed).toHaveLength(3);
    // newest first
    expect(feed[0].ts.getTime()).toBeGreaterThan(feed[2].ts.getTime());
  });

  it('scopes every sub-query to the workspace (and budget where applicable)', async () => {
    const { svc, prisma } = make({});
    await svc.activity('ws1', 'b1');
    expect(prisma.autopilotRun.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 'ws1', budgetId: 'b1' });
    expect(prisma.spendLedger.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 'ws1', budgetId: 'b1' });
    expect(prisma.growthWalletLedgerEntry.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: 'ws1' });
  });
});
