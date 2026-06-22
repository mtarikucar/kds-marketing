import { NotFoundException } from '@nestjs/common';
import { TaxRatesService } from './tax-rates.service';

const WS = 'ws-1';

function makePrisma() {
  const prisma: any = {
    taxRate: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'tr1' }),
      update: jest.fn().mockResolvedValue({ id: 'tr1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // $transaction runs the callback with the same mock as the tx client.
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

describe('TaxRatesService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: TaxRatesService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new TaxRatesService(prisma as any);
  });

  describe('create', () => {
    it('clears any existing default before creating a new default (one default)', async () => {
      await svc.create(WS, { name: 'KDV', rate: 20, isDefault: true } as any);
      expect(prisma.taxRate.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: WS, isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.taxRate.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, rate: 20, isDefault: true });
    });

    it('does not touch the default when creating a non-default rate', async () => {
      await svc.create(WS, { name: 'Reduced', rate: 10 } as any);
      expect(prisma.taxRate.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('404s a rate in another workspace', async () => {
      prisma.taxRate.findFirst.mockResolvedValue(null);
      await expect(svc.archive(WS, 'tr1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resolveItemTaxes', () => {
    it('snapshots taxRatePct from the workspace rate (ignoring any client-supplied pct)', async () => {
      prisma.taxRate.findMany.mockResolvedValue([{ id: 'tr1', rate: 20 }]);
      const out = await svc.resolveItemTaxes(WS, [
        { qty: 1, unitPrice: 100, taxRateId: 'tr1', taxRatePct: 999 } as any, // forged pct
        { qty: 1, unitPrice: 50 } as any, // no tax
      ]);
      expect(out[0].taxRatePct).toBe(20); // re-snapshotted, not 999
      expect(out[0].taxRateId).toBe('tr1');
      expect(out[1].taxRatePct).toBe(0);
      expect(out[1].taxRateId).toBeNull();
      // the lookup is workspace-scoped
      expect(prisma.taxRate.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, id: { in: ['tr1'] }, archived: false });
    });

    it('maps an unknown/foreign taxRateId to pct 0 (no cross-workspace rate leak)', async () => {
      prisma.taxRate.findMany.mockResolvedValue([]); // id resolves to nothing in this workspace
      const out = await svc.resolveItemTaxes(WS, [{ qty: 1, unitPrice: 100, taxRateId: 'foreign' } as any]);
      expect(out[0].taxRatePct).toBe(0);
    });

    it('skips the rate lookup entirely when no line has a taxRateId', async () => {
      const out = await svc.resolveItemTaxes(WS, [{ qty: 1, unitPrice: 100 } as any]);
      expect(prisma.taxRate.findMany).not.toHaveBeenCalled();
      expect(out[0].taxRatePct).toBe(0);
    });
  });
});
