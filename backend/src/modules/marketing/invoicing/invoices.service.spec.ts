import { InvoicesService } from './invoices.service';

/**
 * Invoicing core: total is computed from items (minor units), markPaid settles
 * once + emits invoice.paid, and the workspace PSP secret is AES-256-GCM sealed
 * (never stored or returned in the clear).
 */
describe('InvoicesService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let walletMock: { debit: jest.Mock };
  let svc: InvoicesService;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  beforeEach(() => {
    prisma = {
      invoice: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'inv1', ...data })),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workspacePspConfig: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('e') };
    const config = { get: jest.fn().mockReturnValue('https://m.example') };
    // Default: no tax (pct 0) — totals equal the pre-tax subtotal, as before.
    const taxRates = { resolveItemTaxes: jest.fn((_ws: string, items: unknown[]) => Promise.resolve(items ?? [])) };
    walletMock = { debit: jest.fn().mockResolvedValue({}) };
    svc = new InvoicesService(prisma as any, config as any, outbox as any, taxRates as any, walletMock as any);
  });

  it('computes the total from line items (minor units)', async () => {
    await svc.create(WS, { items: [{ description: 'A', qty: 2, unitPrice: 1000 }, { description: 'B', qty: 1, unitPrice: 500 }] });
    expect(prisma.invoice.create.mock.calls[0][0].data.total).toBe(2500);
    expect(prisma.invoice.create.mock.calls[0][0].data.workspaceId).toBe(WS);
  });

  it('rejects a total that would overflow the int4 money column', async () => {
    const { BadRequestException } = require('@nestjs/common');
    await expect(
      svc.create(WS, { items: [{ description: 'X', qty: 1_000_000, unitPrice: 1_000_000 }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('re-applies the stored coupon discount when items are edited (no silent revert to full price)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', status: 'SENT', discount: 500 });
    await svc.update(WS, 'inv1', { items: [{ description: 'A', qty: 1, unitPrice: 2500 }] });
    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data.discount).toBe(500);
    expect(data.total).toBe(2000); // 2500 gross − 500 discount
  });

  describe('payWithWallet (atomic claim-then-charge)', () => {
    it('claims the invoice PAID then debits the wallet in one transaction', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', status: 'SENT', leadId: 'l1', total: 5000, number: 'INV-1', currency: 'TRY' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      await svc.payWithWallet(WS, 'inv1');
      // the conditional flip only matches an unpaid invoice
      expect(prisma.invoice.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'inv1', workspaceId: WS, status: { in: ['DRAFT', 'SENT'] } });
      // the debit runs inside the SAME tx (a tx client is threaded through)
      expect(walletMock.debit).toHaveBeenCalledWith(WS, 'l1', 5000, expect.any(String), expect.objectContaining({ invoiceId: 'inv1', tx: expect.anything() }));
      expect(outbox.append).toHaveBeenCalled();
    });

    it('does NOT debit again when a concurrent payer already settled it (claim matches 0 rows)', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', status: 'SENT', leadId: 'l1', total: 5000, number: 'INV-1', currency: 'TRY' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 }); // someone else won the claim
      await svc.payWithWallet(WS, 'inv1');
      expect(walletMock.debit).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('rejects a void invoice / one with no contact', async () => {
      const { BadRequestException } = require('@nestjs/common');
      prisma.invoice.findFirst.mockResolvedValueOnce({ id: 'inv1', status: 'VOID', leadId: 'l1', total: 5000 });
      await expect(svc.payWithWallet(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      prisma.invoice.findFirst.mockResolvedValueOnce({ id: 'inv1', status: 'SENT', leadId: null, total: 5000 });
      await expect(svc.payWithWallet(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('markPaid settles the invoice + emits invoice.paid', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: 'lead1', status: 'SENT', total: 2500, currency: 'TRY' });
    await svc.markPaid(WS, 'inv1');
    expect(prisma.invoice.update.mock.calls[0][0].data.status).toBe('PAID');
    expect(outbox.append.mock.calls[0][0].type).toBe('marketing.invoice.paid.v1');
  });

  it('markPaid is idempotent (already paid → no second event)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, status: 'PAID', total: 100, currency: 'TRY' });
    await svc.markPaid(WS, 'inv1');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('seals the workspace Stripe secret (never stored in clear)', async () => {
    await svc.setPspConfig(WS, { provider: 'STRIPE', secrets: { secretKey: 'sk_live_secret' } });
    const data = prisma.workspacePspConfig.upsert.mock.calls[0][0];
    const sealed = data.create.configSealed ?? data.update.configSealed;
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('sk_live_secret');
  });
});
