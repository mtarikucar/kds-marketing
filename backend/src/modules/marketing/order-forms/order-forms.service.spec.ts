import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OrderFormsService } from './order-forms.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('OrderFormsService', () => {
  let prisma: MockPrismaClient;
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let products: { get: jest.Mock };
  let invoices: { create: jest.Mock; send: jest.Mock };
  let leadAttribution: { capture: jest.Mock };
  let svc: OrderFormsService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    products = { get: jest.fn() };
    invoices = {
      create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
      send: jest.fn().mockResolvedValue({ payUrl: 'https://x/api/public/i/in_tok' }),
    };
    const coupons = {
      validate: jest.fn().mockResolvedValue({ couponId: 'c1', code: 'X', amountOff: 0 }),
      redeem: jest.fn().mockResolvedValue({ couponId: 'c1', code: 'X', amountOff: 0 }),
    };
    leadAttribution = { capture: jest.fn().mockResolvedValue(undefined) };
    svc = new OrderFormsService(
      prisma as any,
      outbox as any,
      autoAssigner as any,
      products as any,
      invoices as any,
      coupons as any,
      leadAttribution as any,
    );
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  describe('create / validatePricing', () => {
    it('rejects providing BOTH productId and items', async () => {
      await expect(
        svc.create(WS, { name: 'x', productId: 'p1', items: [{ description: 'a', qty: 1, unitPrice: 1 }] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects providing NEITHER productId nor items', async () => {
      await expect(svc.create(WS, { name: 'x' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('creates a product-mode form (scoped, token minted)', async () => {
      products.get.mockResolvedValue({ id: 'p1', active: true });
      prisma.orderForm.create.mockResolvedValue({ id: 'of1' } as any);
      await svc.create(WS, { name: 'Pro signup', productId: 'p1' } as any);
      const arg = prisma.orderForm.create.mock.calls[0][0] as any;
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.productId).toBe('p1');
      expect(arg.data.publicToken).toMatch(/^of_/);
    });
  });

  describe('update / pricing XOR', () => {
    const productForm = { id: 'f1', workspaceId: WS, productId: 'p1', items: null, currency: 'TRY' };

    it('rejects clearing productId with no items — would leave the form with NEITHER source', async () => {
      prisma.orderForm.findFirst.mockResolvedValue(productForm as any);
      // The STALE product still resolves active — the old code validated against it
      // and then wrote productId=null + items=null (a dud form). Validation must see
      // the effective (empty) post-write state, not the stale product.
      products.get.mockResolvedValue({ id: 'p1', active: true });
      await expect(
        svc.update(WS, 'f1', { productId: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.orderForm.update).not.toHaveBeenCalled();
    });

    it('allows switching a product-mode form to items mode', async () => {
      prisma.orderForm.findFirst.mockResolvedValue(productForm as any);
      prisma.orderForm.update.mockResolvedValue({ id: 'f1' } as any);
      await svc.update(WS, 'f1', { items: [{ description: 'a', qty: 1, unitPrice: 100 }] } as any);
      const arg = prisma.orderForm.update.mock.calls[0][0] as any;
      expect(arg.data.productId).toBeNull();
      expect(arg.data.items).toEqual([{ description: 'a', qty: 1, unitPrice: 100 }]);
    });

    it('allows switching to a different active product', async () => {
      prisma.orderForm.findFirst.mockResolvedValue(productForm as any);
      products.get.mockResolvedValue({ id: 'p2', active: true });
      prisma.orderForm.update.mockResolvedValue({ id: 'f1' } as any);
      await svc.update(WS, 'f1', { productId: 'p2' } as any);
      expect(prisma.orderForm.update).toHaveBeenCalled();
    });

    it('does not re-validate pricing for a non-pricing edit', async () => {
      prisma.orderForm.findFirst.mockResolvedValue(productForm as any);
      prisma.orderForm.update.mockResolvedValue({ id: 'f1' } as any);
      await svc.update(WS, 'f1', { name: 'Renamed' } as any);
      expect(products.get).not.toHaveBeenCalled();
      expect(prisma.orderForm.update).toHaveBeenCalled();
    });
  });

  describe('publicView (price binding)', () => {
    it('resolves the price SERVER-SIDE from the live product (major→minor)', async () => {
      prisma.orderForm.findUnique.mockResolvedValue({
        workspaceId: WS, productId: 'p1', items: null, currency: 'TRY', active: true, name: 'F', notes: null,
        collectPhone: true, phoneRequired: false,
      } as any);
      products.get.mockResolvedValue({ name: 'Pro plan', price: '99.90', currency: 'USD', active: true });
      const res = await svc.publicView('of_tok');
      expect(res.items).toEqual([{ description: 'Pro plan', qty: 1, unitPrice: 9990 }]);
      expect(res.currency).toBe('USD');
      expect(res.total).toBe(9990);
    });
    it('404s an inactive form', async () => {
      prisma.orderForm.findUnique.mockResolvedValue({ active: false } as any);
      await expect(svc.publicView('of_tok')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('submit', () => {
    const FORM = {
      id: 'of1', workspaceId: WS, productId: 'p1', items: null, currency: 'TRY',
      active: true, name: 'Pro signup', phoneRequired: false,
    };

    it('binds the amount to the product (not the buyer) and returns the pay URL', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro plan', price: '50.00', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue(null);
      prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);

      const res = await svc.submit(
        'of_tok',
        { fullName: 'Jane', email: 'jane@x.com' } as any,
        { ip: '203.0.113.1' },
      );

      // The invoice amount comes from the resolved product price, never the body.
      expect(invoices.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({
          leadId: 'lead-1',
          currency: 'TRY',
          items: [{ description: 'Pro plan', qty: 1, unitPrice: 5000 }],
        }),
      );
      expect(res).toEqual({ redirectUrl: 'https://x/api/public/i/in_tok' });
    });

    it('reuses an existing (non-tombstoned) lead instead of creating a duplicate', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-existing', status: 'NEW' } as any);

      await svc.submit('of_tok', { fullName: 'Jane', email: 'jane@x.com' } as any, {});

      expect(prisma.lead.create).not.toHaveBeenCalled();
      expect(invoices.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({ leadId: 'lead-existing' }),
      );
    });

    it('dedup excludes merged AND soft-deleted leads (a deleted buyer stays visible)', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue(null);
      prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);

      await svc.submit('of_tok', { fullName: 'Jane', email: 'jane@x.com' } as any, {});

      const where = prisma.lead.findFirst.mock.calls[0][0].where;
      expect(where.mergedIntoId).toBeNull();
      expect(where.deletedAt).toBeNull();
    });

    it('reuses a recent open invoice on a double-submit (no duplicate invoice)', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', status: 'NEW' } as any);
      // A still-open invoice already exists for this (lead, form) within the window.
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv-prev' } as any);

      const res = await svc.submit('of_tok', { fullName: 'Jane', email: 'jane@x.com' } as any, {});

      expect(invoices.create).not.toHaveBeenCalled(); // reused, not re-minted
      expect(invoices.send).toHaveBeenCalledWith(WS, 'inv-prev');
      expect(res.redirectUrl).toBe('https://x/api/public/i/in_tok');
    });

    it('captures first-touch attribution for a NEW lead in the SAME tx (url + referrer)', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue(null);
      prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);

      await svc.submit('of_tok', { fullName: 'Jane', email: 'jane@x.com' } as any, {
        ip: '203.0.113.1',
        url: 'https://shop.co/o/x?utm_campaign=c1',
        referrer: 'https://facebook.com',
      });

      expect(leadAttribution.capture).toHaveBeenCalledTimes(1);
      const [ws, leadId, input, , tx] = leadAttribution.capture.mock.calls[0];
      expect(ws).toBe(WS);
      expect(leadId).toBe('lead-1');
      expect(input).toMatchObject({ url: 'https://shop.co/o/x?utm_campaign=c1', referrer: 'https://facebook.com' });
      expect(tx).toBe(prisma); // same tx client as the lead create
    });

    it('does NOT capture attribution for a deduped existing lead (first-touch preserved)', async () => {
      prisma.orderForm.findUnique.mockResolvedValue(FORM as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-existing', status: 'NEW' } as any);

      await svc.submit('of_tok', { fullName: 'Jane', email: 'jane@x.com' } as any, {
        url: 'https://shop.co/o/x?utm_campaign=c1',
      });

      expect(leadAttribution.capture).not.toHaveBeenCalled();
    });

    it('enforces a required phone', async () => {
      prisma.orderForm.findUnique.mockResolvedValue({ ...FORM, phoneRequired: true } as any);
      products.get.mockResolvedValue({ name: 'Pro', price: '10', currency: 'TRY', active: true });
      await expect(
        svc.submit('of_tok', { fullName: 'Jane' } as any, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a form whose resolved amount is zero', async () => {
      prisma.orderForm.findUnique.mockResolvedValue({ ...FORM, productId: null, items: [{ description: 'free', qty: 1, unitPrice: 0 }] } as any);
      await expect(
        svc.submit('of_tok', { fullName: 'Jane' } as any, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
