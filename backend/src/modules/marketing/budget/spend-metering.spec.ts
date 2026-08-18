import { Prisma } from '@prisma/client';
import { ResearchSpendService } from './research-spend.service';

/**
 * Both spend services were complete and correctly wired — and both were
 * no-ops, because ChannelTariffService.resolve() returns null when no tariff
 * row matches and nothing in the repo ever inserted one. The skip was logged
 * at DEBUG, which production does not print, so every firecrawl page and apify
 * run since the feature shipped was silently free.
 *
 * The plumbing is not what needed fixing. What needed fixing is that "we spent
 * money and could not price it" was indistinguishable from "nothing happened".
 */
describe('ResearchSpendService — unpriced spend is never silent', () => {
  const WS = 'ws-1';
  let tariffs: any;
  let ledger: any;
  let wallet: any;
  let svc: ResearchSpendService;

  beforeEach(() => {
    tariffs = { price: jest.fn() };
    ledger = { debit: jest.fn().mockResolvedValue({ id: 'entry-1' }) };
    wallet = { debitUpTo: jest.fn(), credit: jest.fn() };
    svc = new ResearchSpendService({} as any, tariffs, ledger, wallet);
  });

  it('settles against the ledger when a tariff exists', async () => {
    tariffs.price.mockResolvedValue({
      amount: new Prisma.Decimal('0.50'),
      unitCost: new Prisma.Decimal('0.05'),
      currency: 'TRY',
      tariffId: 't1',
      quantity: new Prisma.Decimal(10),
    });

    const out = await svc.settle(WS, { unit: 'FIRECRAWL_PAGE', quantity: 10, ref: 'run-1' });

    expect(ledger.debit).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ channel: 'RESEARCH', reason: 'RESEARCH', quantity: 10 }),
    );
    expect(out?.quantity).toBe(10);
  });

  it('WARNS when the unit has no tariff — vendor money left with no record', async () => {
    tariffs.price.mockResolvedValue(null);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    const out = await svc.settle(WS, { unit: 'APIFY_RUN', quantity: 3 });

    expect(out).toBeNull();
    expect(ledger.debit).not.toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    // The three things an operator needs to act: that it happened, what, and
    // how much of it.
    expect(msg).toContain('UNPRICED SPEND');
    expect(msg).toContain('APIFY_RUN');
    expect(msg).toContain('3');
  });

  it('does nothing at all for a zero-quantity settlement', async () => {
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(svc.settle(WS, { unit: 'FIRECRAWL_PAGE', quantity: 0 })).resolves.toBeNull();
    // No work, no cost, no alarm — the warning has to stay meaningful.
    expect(warn).not.toHaveBeenCalled();
    expect(tariffs.price).not.toHaveBeenCalled();
  });

  it('never throws into the caller — research must not fail on a billing blip', async () => {
    tariffs.price.mockRejectedValue(new Error('tariff table down'));
    await expect(svc.settle(WS, { unit: 'FIRECRAWL_PAGE', quantity: 1 })).resolves.toBeNull();
  });
});
