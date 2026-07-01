import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('SubscriptionsService', () => {
  let prisma: MockPrismaClient;
  let invoices: { create: jest.Mock };
  let svc: SubscriptionsService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    invoices = { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) };
    svc = new SubscriptionsService(prisma as any, invoices as any);
  });

  describe('period math', () => {
    it('periodKeyFor is the UTC year-month for MONTH', () => {
      expect(svc.periodKeyFor('MONTH', new Date('2026-06-15T00:00:00Z'))).toBe('2026-06');
      expect(svc.periodKeyFor('YEAR', new Date('2026-06-15T00:00:00Z'))).toBe('2026');
    });

    it('addInterval CLAMPS month-end (Jan 31 + 1 month -> Feb 28, not Mar 3)', () => {
      const next = svc.addInterval(new Date('2026-01-31T00:00:00Z'), 'MONTH', 1);
      expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
    });

    it('addInterval clamps a leap-day year add (Feb 29 2024 + 1yr -> Feb 28 2025)', () => {
      const next = svc.addInterval(new Date('2024-02-29T00:00:00Z'), 'YEAR', 1);
      expect(next.toISOString().slice(0, 10)).toBe('2025-02-28');
    });

    it('addInterval respects intervalCount (quarterly)', () => {
      const next = svc.addInterval(new Date('2026-01-15T00:00:00Z'), 'MONTH', 3);
      expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
    });
  });

  describe('create', () => {
    it('computes the minor-unit amount and is workspace-scoped', async () => {
      prisma.customerSubscription.create.mockResolvedValue({ id: 's1' } as any);
      await svc.create(WS, {
        name: 'Gold',
        items: [{ description: 'Plan', qty: 2, unitPrice: 5000 }],
      } as any);
      const arg = prisma.customerSubscription.create.mock.calls[0][0] as any;
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.amount).toBe(10000);
      expect(arg.data.status).toBe('ACTIVE');
      expect(arg.data.nextBillingAt).toEqual(arg.data.anchorAt);
    });

    it('validates a linked lead in the workspace', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(WS, { name: 'x', items: [{ description: 'a', qty: 1, unitPrice: 1 }], leadId: 'l-x' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('lifecycle', () => {
    it('refuses to pause a non-active subscription', async () => {
      prisma.customerSubscription.findFirst.mockResolvedValue({ id: 's1', status: 'PAUSED' } as any);
      await expect(svc.pause(WS, 's1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resume rolls nextBillingAt forward past skipped periods', async () => {
      prisma.customerSubscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'PAUSED',
        nextBillingAt: new Date('2020-01-01T00:00:00Z'), // long in the past
        interval: 'MONTH',
        intervalCount: 1,
      } as any);
      prisma.customerSubscription.update.mockResolvedValue({ id: 's1' } as any);
      await svc.resume(WS, 's1');
      const arg = prisma.customerSubscription.update.mock.calls[0][0] as any;
      expect(arg.data.status).toBe('ACTIVE');
      expect(arg.data.nextBillingAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('billOne', () => {
    const sub = {
      id: 's1',
      workspaceId: WS,
      leadId: null,
      name: 'Gold',
      items: [{ description: 'Plan', qty: 1, unitPrice: 9900 }],
      currency: 'TRY',
      notes: null,
      dueDays: 14,
      interval: 'MONTH',
      intervalCount: 1,
      nextBillingAt: new Date('2026-06-01T00:00:00Z'),
    };

    beforeEach(() => {
      // billOne re-reads the CURRENT status (the scheduler's ACTIVE filter is a
      // snapshot) — default to ACTIVE for the happy-path tests.
      prisma.customerSubscription.findUnique.mockResolvedValue({ status: 'ACTIVE' } as any);
    });

    // A subscription cancelled/paused AFTER the scheduler's batch snapshot but
    // before this row is billed must not be charged for a post-change period.
    it('re-checks status and does NOT bill a subscription no longer ACTIVE', async () => {
      prisma.customerSubscription.findUnique.mockResolvedValue({ status: 'CANCELLED' } as any);

      const res = await svc.billOne(sub as any, new Date('2026-06-01T06:00:00Z'));

      expect(res).toBe('skipped');
      expect(invoices.create).not.toHaveBeenCalled();
      expect(prisma.customerSubscription.update).not.toHaveBeenCalled();
    });

    it('mints an invoice STAMPED at create-time (no orphan window) and advances', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null); // no prior invoice this period
      prisma.customerSubscription.update.mockResolvedValue({ id: 's1' } as any);

      const res = await svc.billOne(sub as any, new Date('2026-06-01T06:00:00Z'));

      expect(res).toBe('billed');
      // The invoice is born stamped — the partial-unique index guards the INSERT.
      expect(invoices.create).toHaveBeenCalledWith(
        WS,
        expect.objectContaining({
          currency: 'TRY',
          items: sub.items,
          subscriptionId: 's1',
          subscriptionPeriodKey: '2026-06',
        }),
      );
      // No separate stamp update on the invoice anymore.
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      const advance = prisma.customerSubscription.update.mock.calls[0][0] as any;
      expect(advance.data.nextBillingAt.toISOString().slice(0, 10)).toBe('2026-07-01');
      expect(advance.data.invoicesGenerated).toEqual({ increment: 1 });
      expect(advance.data.failedAttempts).toBe(0);
    });

    it('skips (no second invoice) when the period was already billed', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: 'inv-prev' } as any);
      prisma.customerSubscription.update.mockResolvedValue({ id: 's1' } as any);

      const res = await svc.billOne(sub as any, new Date('2026-06-01T06:00:00Z'));

      expect(res).toBe('skipped');
      expect(invoices.create).not.toHaveBeenCalled();
      expect(prisma.customerSubscription.update).toHaveBeenCalled();
    });

    it('treats a P2002 from the create (concurrent dup) as already-billed: skip + advance', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      invoices.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.customerSubscription.update.mockResolvedValue({ id: 's1' } as any);

      const res = await svc.billOne(sub as any, new Date('2026-06-01T06:00:00Z'));

      expect(res).toBe('skipped');
      expect(prisma.customerSubscription.update).toHaveBeenCalled(); // advanced
    });

    it('a NON-P2002 create error throws WITHOUT advancing and without an orphan (no double-bill)', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      invoices.create.mockRejectedValueOnce({ code: 'P1001' }); // transient DB error
      prisma.customerSubscription.update.mockResolvedValue({ id: 's1' } as any);

      await expect(svc.billOne(sub as any, new Date('2026-06-01T06:00:00Z'))).rejects.toBeDefined();
      // Schedule is NOT advanced (period stays due → bounded retry by the scheduler).
      expect(prisma.customerSubscription.update).not.toHaveBeenCalled();
      // No separate invoice write happened — nothing to orphan.
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.invoice.delete).not.toHaveBeenCalled();
    });
  });
});
