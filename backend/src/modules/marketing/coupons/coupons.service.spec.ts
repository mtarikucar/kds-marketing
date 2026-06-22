import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CouponsService } from './coupons.service';

const WS = 'ws-1';

function coupon(extra: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    workspaceId: WS,
    code: 'SAVE10',
    kind: 'PERCENT',
    value: 10,
    currency: null,
    minSubtotal: null,
    maxRedemptions: null,
    timesRedeemed: 0,
    startsAt: null,
    expiresAt: null,
    active: true,
    ...extra,
  };
}

function makePrisma() {
  const prisma: any = {
    coupon: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    couponRedemption: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

describe('CouponsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: CouponsService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new CouponsService(prisma as any);
  });

  describe('create', () => {
    it('rejects a PERCENT coupon out of 1–100', async () => {
      await expect(svc.create(WS, { code: 'X', kind: 'PERCENT', value: 200 } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects a FIXED coupon created without a currency', async () => {
      await expect(svc.create(WS, { code: 'X', kind: 'FIXED', value: 1000 } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('stores the code uppercased (matches the case-sensitive unique index)', async () => {
      prisma.coupon.create.mockResolvedValue({ id: 'c1' });
      await svc.create(WS, { code: 'save10', kind: 'PERCENT', value: 10 } as any);
      expect(prisma.coupon.create.mock.calls[0][0].data.code).toBe('SAVE10');
    });
    it('maps a duplicate code to a 409', async () => {
      const { Prisma } = require('@prisma/client');
      prisma.coupon.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
      await expect(svc.create(WS, { code: 'SAVE10', kind: 'PERCENT', value: 10 } as any)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('validate (no side effects)', () => {
    it('computes a PERCENT discount and never redeems', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon());
      const app = await svc.validate(WS, 'save10', 10000, 'TRY');
      expect(app.amountOff).toBe(1000); // 10% of 10000
      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
      expect(prisma.couponRedemption.create).not.toHaveBeenCalled();
    });

    it('clamps a FIXED discount to the subtotal', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ kind: 'FIXED', value: 50000, currency: 'TRY' }));
      const app = await svc.validate(WS, 'x', 3000, 'TRY');
      expect(app.amountOff).toBe(3000); // never more than the subtotal
    });

    it('rejects a FIXED coupon with NO currency (cross-currency hole)', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ kind: 'FIXED', value: 1000, currency: null }));
      await expect(svc.validate(WS, 'x', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an expired / inactive / below-min / unknown coupon', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(svc.validate(WS, 'x', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);

      prisma.coupon.findFirst.mockResolvedValue(coupon({ active: false }));
      await expect(svc.validate(WS, 'x', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);

      prisma.coupon.findFirst.mockResolvedValue(coupon({ minSubtotal: 20000 }));
      await expect(svc.validate(WS, 'x', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);

      prisma.coupon.findFirst.mockResolvedValue(null);
      await expect(svc.validate(WS, 'nope', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a FIXED coupon whose currency does not match', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ kind: 'FIXED', value: 1000, currency: 'USD' }));
      await expect(svc.validate(WS, 'x', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('redeem (atomic consume)', () => {
    it('increments under the max guard + logs the redemption (workspace-scoped)', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ maxRedemptions: 5, timesRedeemed: 2 }));
      const app = await svc.redeem(WS, 'save10', 10000, 'TRY', { invoiceId: 'inv1', leadId: 'l1' });
      expect(app.amountOff).toBe(1000);
      const upd = prisma.coupon.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ id: 'c1', workspaceId: WS, timesRedeemed: { lt: 5 } });
      expect(prisma.couponRedemption.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, couponId: 'c1', invoiceId: 'inv1', amountOff: 1000 });
    });

    it('throws when the limit was exhausted between validate and the atomic increment', async () => {
      prisma.coupon.findFirst.mockResolvedValue(coupon({ maxRedemptions: 5, timesRedeemed: 4 }));
      prisma.coupon.updateMany.mockResolvedValue({ count: 0 }); // someone else took the last slot
      await expect(svc.redeem(WS, 'save10', 10000, 'TRY')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.couponRedemption.create).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('404s a coupon in another workspace', async () => {
      prisma.coupon.findFirst.mockResolvedValue(null);
      await expect(svc.remove(WS, 'c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
