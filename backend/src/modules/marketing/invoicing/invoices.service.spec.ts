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
      customerWallet: { findUnique: jest.fn().mockResolvedValue({ currency: 'TRY' }) },
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

  describe('voidInvoice', () => {
    // A PAID invoice is terminal — voiding it would drop collected revenue from
    // reporting while the wallet debit / PSP charge stands (no refund). Mirror
    // update()'s PAID-immutability guard (paid→void must be refused like paid→edit).
    it('refuses to void a PAID invoice', async () => {
      const { BadRequestException } = require('@nestjs/common');
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', status: 'PAID' });
      await expect(svc.voidInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('voids a non-terminal (SENT) invoice', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', status: 'SENT' });
      await svc.voidInvoice(WS, 'inv1');
      expect(prisma.invoice.update).toHaveBeenCalledWith({ where: { id: 'inv1' }, data: { status: 'VOID' } });
    });
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

    // The wallet is single-currency (TRY). Paying a non-TRY invoice from it would
    // debit the invoice's minor units as if they were the wallet's — draining store
    // credit at the wrong (unconverted) amount and marking it PAID. Refuse it.
    it('refuses to pay a non-TRY invoice from a TRY wallet (no cross-currency debit)', async () => {
      const { BadRequestException } = require('@nestjs/common');
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, status: 'SENT', leadId: 'l1', total: 10000, number: 'INV-1', currency: 'USD' });
      prisma.customerWallet.findUnique.mockResolvedValue({ currency: 'TRY' });
      await expect(svc.payWithWallet(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      expect(walletMock.debit).not.toHaveBeenCalled();
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });
  });

  it('markPaid settles the invoice + emits invoice.paid (conditional claim)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: 'lead1', status: 'SENT', total: 2500, currency: 'TRY' });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    await svc.markPaid(WS, 'inv1');
    // the flip is a conditional claim — only an unpaid (DRAFT/SENT) row matches
    expect(prisma.invoice.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'inv1', workspaceId: WS, status: { in: ['DRAFT', 'SENT'] } });
    expect(prisma.invoice.updateMany.mock.calls[0][0].data.status).toBe('PAID');
    expect(outbox.append.mock.calls[0][0].type).toBe('marketing.invoice.paid.v1');
  });

  it('markPaid is idempotent (already paid → no claim, no second event)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, status: 'PAID', total: 100, currency: 'TRY' });
    await svc.markPaid(WS, 'inv1');
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('settle never re-emits when the conditional claim matches 0 rows (VOID / concurrent retry)', async () => {
    // a token minted just before a void: status flips out of DRAFT/SENT → claim is empty
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, status: 'SENT', total: 2500, currency: 'TRY' });
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
    await svc.markPaid(WS, 'inv1');
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('seals the workspace Stripe secret (never stored in clear)', async () => {
    await svc.setPspConfig(WS, { provider: 'STRIPE', secrets: { secretKey: 'sk_live_secret' } });
    const data = prisma.workspacePspConfig.upsert.mock.calls[0][0];
    const sealed = data.create.configSealed ?? data.update.configSealed;
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('sk_live_secret');
  });

  describe('PayTR (Epic 13, inert)', () => {
    const { sealSecret } = require('../../../common/crypto/secret-box.helper');
    const { computeCallbackHash } = require('../../billing/payments/paytr.provider');
    const PAYTR_SECRETS = { merchantId: 'mid', merchantKey: 'mkey', merchantSalt: 'msalt' };
    const sealedPaytr = () => sealSecret(JSON.stringify(PAYTR_SECRETS));

    it('refuses a non-TRY invoice (avoids the TL/$ footgun)', async () => {
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, total: 10000, currency: 'USD', number: 'INV-1', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealedPaytr() });
      await expect(svc.pay('tok', '1.2.3.4')).rejects.toThrow(/PayTR collects TRY only/);
    });

    it('builds a PayTR get-token call and returns the hosted-iframe redirect URL', async () => {
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'a1b2c3d4-0000-0000-0000-000000000000', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', number: 'INV-7', status: 'SENT', publicToken: 'in_pub7' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealedPaytr() });
      prisma.lead = { findFirst: jest.fn().mockResolvedValue(null) };
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success', token: 'PTK1' }) });
      (global as any).fetch = fetchMock;
      const out = await svc.pay('tok', '5.6.7.8');
      expect(out.redirectUrl).toMatch(/\/odeme\/guvenli\/PTK1$/);
      // sends the merchant_oid derived from the invoice id (alphanumeric)
      const form = String(fetchMock.mock.calls[0][1].body);
      expect(form).toContain('merchant_oid=INVa1b2c3d40000000000000000000000');
      expect(form).toContain('currency=TL');
      // the PayTR return URL points at the PUBLIC pay page (token), never the internal id (would 404)
      expect(form).toContain('merchant_ok_url=');
      expect(form).toContain(encodeURIComponent('/api/public/i/in_pub7'));
      expect(form).not.toContain('a1b2c3d4-0000-0000-0000-000000000000');
    });

    it('callback: a valid hash with status=success settles the invoice + emits InvoicePaid', async () => {
      const invoiceId = 'a1b2c3d4-0000-0000-0000-000000000000';
      const oid = 'INV' + invoiceId.replace(/-/g, '');
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: invoiceId, workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealedPaytr() });
      const hash = computeCallbackHash({ merchantOid: oid, merchantSalt: 'msalt', status: 'success', totalAmount: '19900', merchantKey: 'mkey' });
      const ok = await svc.paytrCallback({ merchant_oid: oid, status: 'success', total_amount: '19900', hash });
      expect(ok).toBe(true);
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', paidVia: 'paytr' }) }));
      expect(outbox.append.mock.calls.some((c: any) => c[0].type === 'marketing.invoice.paid.v1')).toBe(true);
    });

    it('callback: a VALID hash but a MISMATCHED amount is ACKed but NOT settled (199$/199TL footgun)', async () => {
      const invoiceId = 'a1b2c3d4-0000-0000-0000-000000000000';
      const oid = 'INV' + invoiceId.replace(/-/g, '');
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: invoiceId, workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealedPaytr() });
      // PayTR reports a smaller collected amount than the invoice demands — hash is valid over THAT amount
      const hash = computeCallbackHash({ merchantOid: oid, merchantSalt: 'msalt', status: 'success', totalAmount: '10000', merchantKey: 'mkey' });
      const ok = await svc.paytrCallback({ merchant_oid: oid, status: 'success', total_amount: '10000', hash });
      expect(ok).toBe(true); // ACK so PayTR stops retrying
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled(); // but the invoice is NOT flipped to PAID
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('callback: a forged hash is rejected and does NOT settle', async () => {
      const oid = 'INVa1b2c3d40000000000000000000000';
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'a1b2c3d4-0000-0000-0000-000000000000', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealedPaytr() });
      const ok = await svc.paytrCallback({ merchant_oid: oid, status: 'success', total_amount: '19900', hash: 'forged-hash' });
      expect(ok).toBe(false);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('callback: an unknown/garbage merchant_oid is ignored', async () => {
      const ok = await svc.paytrCallback({ merchant_oid: 'BOGUS', status: 'success', total_amount: '1', hash: 'x' });
      expect(ok).toBe(false);
    });
  });

  describe('Iyzico (Epic 13, inert)', () => {
    const { sealSecret } = require('../../../common/crypto/secret-box.helper');
    const sealedIyzico = () => sealSecret(JSON.stringify({ apiKey: 'ak', secretKey: 'sk' }));

    it('callback: a SUCCESS retrieve with a matching amount + invoice binding settles the invoice', async () => {
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'IYZICO', configSealed: sealedIyzico() });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success', paymentStatus: 'SUCCESS', paidPrice: '199.00', conversationId: 'inv1', basketId: 'inv1' }) });
      const ok = await svc.iyzicoCallback('tok', 'iyz-token');
      expect(ok).toBe(true);
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', paidVia: 'iyzico' }) }));
    });

    it('callback: a SUCCESS retrieve with a MISMATCHED amount does NOT settle', async () => {
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'IYZICO', configSealed: sealedIyzico() });
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success', paymentStatus: 'SUCCESS', paidPrice: '100.00', conversationId: 'inv1', basketId: 'inv1' }) });
      const ok = await svc.iyzicoCallback('tok', 'iyz-token');
      expect(ok).toBe(false);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('callback: a retrieve bound to ANOTHER invoice (same amount) does NOT settle — cross-invoice token replay', async () => {
      // Invoice A (this callback's token) has the same total as a paid invoice B
      // whose Iyzico token is replayed here. The retrieve returns B's payment
      // (conversationId/basketId = 'invB'), which must NOT settle invoice A.
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'invA', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'IYZICO', configSealed: sealedIyzico() });
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success', paymentStatus: 'SUCCESS', paidPrice: '199.00', conversationId: 'invB', basketId: 'invB' }) });
      const ok = await svc.iyzicoCallback('tok', 'iyz-token-of-invoice-B');
      expect(ok).toBe(false);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('callback: a non-success retrieve is rejected', async () => {
      prisma.invoice.findUnique = jest.fn().mockResolvedValue({ id: 'inv1', workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT' });
      prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'IYZICO', configSealed: sealedIyzico() });
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success', paymentStatus: 'FAILURE' }) });
      expect(await svc.iyzicoCallback('tok', 'iyz-token')).toBe(false);
    });
  });
});
