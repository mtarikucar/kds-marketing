import { Prisma } from '@prisma/client';
import { MediaSpendService } from './media-spend.service';
import { ChannelTariffService } from '../wallet/channel-tariff.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';

function make(priced: { unitCost: string; amount: string } | null) {
  const price = jest.fn().mockResolvedValue(
    priced
      ? {
          unitCost: new Prisma.Decimal(priced.unitCost),
          amount: new Prisma.Decimal(priced.amount),
          currency: 'TRY',
          tariffId: 't1',
          quantity: new Prisma.Decimal(1),
        }
      : null,
  );
  const debitOnce = jest.fn().mockResolvedValue({ id: 'l1', deduped: false });
  const service = new MediaSpendService(
    { price } as unknown as ChannelTariffService,
    { debitOnce } as unknown as SpendLedgerService,
  );
  return { service, price, debitOnce };
}

describe('MediaSpendService', () => {
  it('prices the trued-up credit count and debits the CONTENT channel', async () => {
    const { service, price, debitOnce } = make({ unitCost: '0.4000', amount: '6.0000' });

    const result = await service.settle('ws-1', { assetId: 'a-1', credits: 15 });

    expect(price).toHaveBeenCalledWith('ws-1', 'CONTENT', 'FAL_CREDIT', 15);
    expect(Number(result!.amount)).toBe(6);
    expect(debitOnce).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        channel: 'CONTENT',
        reason: 'CONTENT_GEN',
        // Webhook and poller both finalize; the ref is what stops a double bill.
        ref: 'mediagen:a-1',
        quantity: 15,
      }),
    );
  });

  it('records nothing when no tariff resolves, instead of a free generation', async () => {
    const { service, debitOnce } = make(null);
    expect(await service.settle('ws-1', { assetId: 'a-1', credits: 3 })).toBeNull();
    expect(debitOnce).not.toHaveBeenCalled();
  });

  it('never throws into the finalize path when the ledger fails', async () => {
    const { service, debitOnce } = make({ unitCost: '0.4000', amount: '1.2000' });
    debitOnce.mockRejectedValueOnce(new Error('ledger down'));

    // An asset that already reached the customer must not be failed by
    // bookkeeping.
    await expect(service.settle('ws-1', { assetId: 'a-1', credits: 3 })).resolves.toBeNull();
  });

  it('ignores a zero-credit settle rather than writing an empty row', async () => {
    const { service, price } = make({ unitCost: '0.4000', amount: '0' });
    expect(await service.settle('ws-1', { assetId: 'a-1', credits: 0 })).toBeNull();
    expect(price).not.toHaveBeenCalled();
  });
});
