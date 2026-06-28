import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OrderFormsService } from './order-forms.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('OrderFormsService', () => {
  let prisma: MockPrismaClient;
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let products: { get: jest.Mock };
  let invoices: { create: jest.Mock; send: jest.Mock };
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
    svc = new OrderFormsService(
      prisma as any,
      outbox as any,
      autoAssigner as any,
      products as any,
      invoices as any,
      coupons as any,
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
