import { PublicInvoiceController } from './public-invoice.controller';

/**
 * Public, token-gated invoice surface (Epic 13 money flow). Controller-level
 * coverage of the response shaping the services don't own: the pay page HTML
 * (with XSS escaping of invoice content), the iyzico Checkout-Form callback
 * result page, and the PayTR notification's literal "OK"/"FAIL" contract.
 */
describe('PublicInvoiceController (public token-gated)', () => {
  let invoices: {
    publicInvoice: jest.Mock;
    iyzicoCallback: jest.Mock;
    paytrCallback: jest.Mock;
    pay: jest.Mock;
    stripeReturn: jest.Mock;
  };
  let ctrl: PublicInvoiceController;

  const res = () => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.type = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    return r;
  };

  beforeEach(() => {
    invoices = {
      publicInvoice: jest.fn(),
      iyzicoCallback: jest.fn(),
      paytrCallback: jest.fn(),
      pay: jest.fn(),
      stripeReturn: jest.fn(),
    };
    ctrl = new PublicInvoiceController(invoices as any);
  });

  describe('pay page', () => {
    it('404s an unknown/forged token (no leak)', async () => {
      invoices.publicInvoice.mockRejectedValue(new Error('not found'));
      const r = res();
      await ctrl.page('bogus', r);
      expect(r.status).toHaveBeenCalledWith(404);
      expect(r.send.mock.calls[0][0]).toContain('not found');
    });

    it('renders the invoice with a Pay button when unpaid', async () => {
      invoices.publicInvoice.mockResolvedValue({
        number: 'INV-1', currency: 'USD', total: 19900, status: 'SENT', notes: null,
        items: [{ description: 'Consulting', qty: 2, unitPrice: 9950 }],
      });
      const r = res();
      await ctrl.page('tok', r);
      const html = r.send.mock.calls[0][0] as string;
      expect(html).toContain('INV-1');
      expect(html).toContain('Consulting');
      expect(html).toContain('id="pay"'); // pay button present
    });

    it('shows the Paid badge and NO pay button when already paid', async () => {
      invoices.publicInvoice.mockResolvedValue({
        number: 'INV-2', currency: 'USD', total: 5000, status: 'PAID', notes: null, items: [],
      });
      const r = res();
      await ctrl.page('tok', r);
      const html = r.send.mock.calls[0][0] as string;
      expect(html).toContain('Paid');
      expect(html).not.toContain('id="pay"');
    });

    it('escapes hostile invoice content (no stored XSS via item description)', async () => {
      invoices.publicInvoice.mockResolvedValue({
        number: 'INV-3', currency: 'USD', total: 100, status: 'SENT',
        notes: '<script>alert(1)</script>',
        items: [{ description: '<img onerror=x>', qty: 1, unitPrice: 100 }],
      });
      const r = res();
      await ctrl.page('tok', r);
      const html = r.send.mock.calls[0][0] as string;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img onerror=');
      expect(html).toContain('&lt;');
    });
  });

  describe('iyzico callback', () => {
    it('renders "Payment received" when the callback settles the invoice', async () => {
      invoices.iyzicoCallback.mockResolvedValue(true);
      const r = res();
      await ctrl.iyzicoCallback('tok', { token: 'iyz-token' }, r);
      expect(invoices.iyzicoCallback).toHaveBeenCalledWith('tok', 'iyz-token');
      expect(r.send.mock.calls[0][0]).toContain('Payment received');
    });

    it('renders "Payment pending" when settlement is not confirmed (and never throws)', async () => {
      invoices.iyzicoCallback.mockRejectedValue(new Error('boom'));
      const r = res();
      await ctrl.iyzicoCallback('tok', { token: 'x' }, r);
      expect(r.send.mock.calls[0][0]).toContain('Payment pending');
    });
  });

  describe('paytr callback (literal OK/FAIL contract)', () => {
    it('replies the literal "OK" once verified+settled', async () => {
      invoices.paytrCallback.mockResolvedValue(true);
      const r = res();
      await ctrl.paytrCallback({ merchant_oid: 'INV1', status: 'success', total_amount: '19900', hash: 'h' }, r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.send).toHaveBeenCalledWith('OK');
    });

    it('replies "FAIL" on an unmatched/forged hit (and never throws)', async () => {
      invoices.paytrCallback.mockRejectedValue(new Error('forged'));
      const r = res();
      await ctrl.paytrCallback({ merchant_oid: 'x', status: 'success', total_amount: '1', hash: 'bad' }, r);
      expect(r.send).toHaveBeenCalledWith('FAIL');
    });
  });
});
