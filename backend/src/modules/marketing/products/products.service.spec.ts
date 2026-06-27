import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('ProductsService', () => {
  let prisma: MockPrismaClient;
  let svc: ProductsService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new ProductsService(prisma as any);
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  describe('create', () => {
    it('creates a one-time product scoped to the workspace', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p1' } as any);
      await svc.create(WS, { name: 'Setup fee', price: 500 } as any);
      const arg = prisma.product.create.mock.calls[0][0] as any;
      expect(arg.data).toMatchObject({
        workspaceId: WS,
        name: 'Setup fee',
        price: 500,
        billingType: 'ONE_TIME',
        interval: null,
      });
    });

    it('defaults a recurring product to a MONTH interval', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p2' } as any);
      await svc.create(WS, { name: 'Pro plan', billingType: 'RECURRING' } as any);
      const arg = prisma.product.create.mock.calls[0][0] as any;
      expect(arg.data.billingType).toBe('RECURRING');
      expect(arg.data.interval).toBe('MONTH');
    });

    it('keeps an explicit recurring interval', async () => {
      prisma.product.create.mockResolvedValue({ id: 'p3' } as any);
      await svc.create(WS, { name: 'Annual', billingType: 'RECURRING', interval: 'YEAR' } as any);
      expect((prisma.product.create.mock.calls[0][0] as any).data.interval).toBe('YEAR');
    });
  });

  describe('list', () => {
    it('scopes to the workspace and applies the active filter', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0 as any);
      await svc.list(WS, { active: true } as any);
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, active: true }),
        }),
      );
    });
  });

  describe('get / update', () => {
    it('404s a product from another workspace', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(svc.get(WS, 'p-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('defaults the interval to MONTH when switching a product to RECURRING', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1',
        billingType: 'ONE_TIME',
        interval: null,
      } as any);
      prisma.product.update.mockResolvedValue({ id: 'p1' } as any);
      await svc.update(WS, 'p1', { billingType: 'RECURRING' } as any);
      const arg = prisma.product.update.mock.calls[0][0] as any;
      expect(arg.data.billingType).toBe('RECURRING');
      expect(arg.data.interval).toBe('MONTH');
    });
  });

  describe('archive', () => {
    it('soft-retires the product (active=false) rather than deleting', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' } as any);
      prisma.product.update.mockResolvedValue({ id: 'p1', active: false } as any);
      await svc.archive(WS, 'p1');
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { active: false },
      });
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('refuses to hard-delete a product an order form still references', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' } as any); // get()
      (prisma.orderForm.count as jest.Mock).mockResolvedValue(2);
      // OrderForm.productId is a soft ref the public checkout resolves live, so a
      // hard delete leaves a dangling ref that 404s the buyer-facing form forever.
      await expect(svc.remove(WS, 'p1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.orderForm.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, productId: 'p1' } }),
      );
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });

    it('deletes a product no order form references', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1' } as any);
      (prisma.orderForm.count as jest.Mock).mockResolvedValue(0);
      prisma.product.delete.mockResolvedValue({ id: 'p1' } as any);
      await svc.remove(WS, 'p1');
      expect(prisma.product.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });
  });
});
