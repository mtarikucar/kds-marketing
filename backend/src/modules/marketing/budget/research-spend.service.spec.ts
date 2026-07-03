import { Prisma } from '@prisma/client';
import { ResearchSpendService } from './research-spend.service';

describe('ResearchSpendService', () => {
  function make(priced: unknown) {
    const tariffs = { price: jest.fn().mockResolvedValue(priced) };
    const ledger = { debit: jest.fn().mockResolvedValue({ id: 'l1', balanceAfter: new Prisma.Decimal(0) }) };
    return { svc: new ResearchSpendService(tariffs as any, ledger as any), tariffs, ledger };
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
});
