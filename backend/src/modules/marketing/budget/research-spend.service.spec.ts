import { Prisma } from '@prisma/client';
import { ResearchSpendService } from './research-spend.service';

const D = (n: string | number) => new Prisma.Decimal(n);
const FLAG = 'GROWTH_AUTOPILOT_AUTONOMY';

describe('ResearchSpendService', () => {
  function make(priced: unknown, opts: { autonomyLevel?: string } = {}) {
    const tariffs = { price: jest.fn().mockResolvedValue(priced) };
    const ledger = { debit: jest.fn().mockResolvedValue({ id: 'l1', balanceAfter: new Prisma.Decimal(0) }) };
    const prisma = {
      growthBudget: {
        findFirst: jest.fn(async () =>
          opts.autonomyLevel ? { autonomyLevel: opts.autonomyLevel } : null),
      },
    } as any;
    const wallet = {
      debitUpTo: jest.fn().mockResolvedValue({ wallet: {}, replayed: false, debited: D(0), shortfall: D(0) }),
    } as any;
    return { svc: new ResearchSpendService(prisma, tariffs as any, ledger as any, wallet), prisma, tariffs, ledger, wallet };
  }
  const priced = { unitCost: new Prisma.Decimal('0.05'), currency: 'TRY', tariffId: 't1', quantity: new Prisma.Decimal(10), amount: new Prisma.Decimal('0.5') };

  it('prices + debits a firecrawl page batch into the RESEARCH channel', async () => {
    const { svc, tariffs, ledger } = make(priced);
    const r = await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 10, ref: 'run1' });
    expect(tariffs.price).toHaveBeenCalledWith('ws1', 'RESEARCH', 'FIRECRAWL_PAGE', 10);
    expect(ledger.debit).toHaveBeenCalledWith('ws1', expect.objectContaining({ channel: 'RESEARCH', reason: 'RESEARCH', amount: priced.amount }));
    expect(r?.quantity).toBe(10);
  });

  it('is a no-op for zero quantity', async () => {
    const { svc, tariffs, ledger } = make(priced);
    expect(await svc.settle('ws1', { unit: 'APIFY_RUN', quantity: 0 })).toBeNull();
    expect(tariffs.price).not.toHaveBeenCalled();
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('is best-effort: no tariff → no debit, no throw', async () => {
    const { svc, ledger } = make(null);
    expect(await svc.settle('ws1', { unit: 'RESEARCH_LEAD', quantity: 3 })).toBeNull();
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('is best-effort: a debit failure is swallowed', async () => {
    const { svc, ledger } = make(priced);
    (ledger.debit as jest.Mock).mockRejectedValueOnce(new Error('ledger down'));
    await expect(svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 5 })).resolves.toBeNull();
  });

  describe('engine wallet drawdown (Growth Autopilot D4)', () => {
    let prevFlag: string | undefined;
    beforeEach(() => { prevFlag = process.env[FLAG]; process.env[FLAG] = '1'; });
    afterEach(() => {
      if (prevFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prevFlag;
    });

    it('debits the growth wallet (clamped debitUpTo, ref from the ledger entry) under an armed AUTONOMOUS budget', async () => {
      const { svc, wallet } = make(priced, { autonomyLevel: 'AUTONOMOUS' });
      const r = await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 10, ref: 'run1', budgetId: 'b1' });
      expect(r?.quantity).toBe(10);
      expect(wallet.debitUpTo).toHaveBeenCalledTimes(1);
      const [ws, movement] = wallet.debitUpTo.mock.calls[0];
      expect(ws).toBe('ws1');
      expect(movement.kind).toBe('ENGINE_SPEND');
      expect(movement.ref).toBe('spend:l1'); // unique ledger ENTRY id — runId repeats within a run
      expect(movement.amount.toString()).toBe('0.5');
    });

    it('scopes the budget lookup by workspace', async () => {
      const { svc, prisma } = make(priced, { autonomyLevel: 'AUTONOMOUS' });
      await svc.settle('ws1', { unit: 'APIFY_RUN', quantity: 1, ref: 'run1', budgetId: 'b1' });
      expect(prisma.growthBudget.findFirst).toHaveBeenCalledWith({
        where: { id: 'b1', workspaceId: 'ws1' },
        select: { autonomyLevel: true },
      });
    });

    it('does NOT touch the wallet when the budget is not AUTONOMOUS', async () => {
      const { svc, wallet } = make(priced, { autonomyLevel: 'ASSISTED' });
      await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 2, budgetId: 'b1' });
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('does NOT touch the wallet (or query the budget) when the env flag is off', async () => {
      delete process.env[FLAG];
      const { svc, prisma, wallet } = make(priced, { autonomyLevel: 'AUTONOMOUS' });
      await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 2, budgetId: 'b1' });
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('does NOT query the budget or touch the wallet without a budgetId (manual spend untouched)', async () => {
      const { svc, prisma, wallet } = make(priced, { autonomyLevel: 'AUTONOMOUS' });
      await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 2 });
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('is best-effort: a wallet drawdown failure does not lose the settlement result', async () => {
      const { svc, wallet } = make(priced, { autonomyLevel: 'AUTONOMOUS' });
      wallet.debitUpTo.mockRejectedValueOnce(new Error('wallet down'));
      const r = await svc.settle('ws1', { unit: 'FIRECRAWL_PAGE', quantity: 10, budgetId: 'b1' });
      expect(r?.amount.toString()).toBe('0.5');
    });
  });
});
