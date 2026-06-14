import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SettlementCommissionConsumer } from './settlement-commission.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { PaymentSucceededPayload } from '../../outbox/event-types';
import { DomainEvent } from '../../outbox/domain-event-bus.service';

function makeEvent(p: Partial<PaymentSucceededPayload>): DomainEvent<PaymentSucceededPayload> {
  const payload: PaymentSucceededPayload = {
    tenantId: 'tenant-1',
    tenantName: 'Test Restoran',
    subscriptionId: 'sub-1',
    paymentId: 'pay-1',
    kind: 'renewal',
    amount: 799,
    currency: 'TRY',
    planId: 'plan-pro',
    planCode: 'PRO',
    commissionRate: 0.15,
    referralCode: null,
    referredByMarketingUserId: null,
    occurredAt: '2026-06-02T10:00:00.000Z',
    ...p,
  };
  return {
    id: 'evt-1',
    type: 'payment.succeeded.v1',
    tenantId: payload.tenantId,
    idempotencyKey: `payment-succeeded:${payload.paymentId}`,
    createdAt: new Date('2026-06-02T10:00:00.000Z'),
    payload,
  };
}

describe('SettlementCommissionConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock };
  let consumer: SettlementCommissionConsumer;

  // The handler is private; call it directly to unit-test the credit logic.
  const handle = (e: DomainEvent<PaymentSucceededPayload>) => (consumer as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn() };
    consumer = new SettlementCommissionConsumer(prisma as any, bus as any);
    // Forward the Serializable signup tx callback onto the same mock surface.
    (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
    // Core events carry core tenant ids; the consumer resolves the single
    // core-integrated workspace via findCoreIntegratedWorkspaceId().
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws-core' } as any);
  });

  it('subscribes to payment.succeeded.v1 on module init', () => {
    consumer.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith('payment.succeeded.v1', expect.any(Function));
  });

  it('skips the event entirely when no core-integrated workspace exists', async () => {
    prisma.workspace.findFirst.mockResolvedValue(null);

    await expect(handle(makeEvent({ kind: 'renewal' }))).resolves.toBeUndefined();

    expect(prisma.commission.findFirst).not.toHaveBeenCalled();
    expect(prisma.commission.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('RENEWAL / UPSELL', () => {
    it('creates a RENEWAL commission with sourcePaymentId for the converting rep', async () => {
      prisma.commission.findFirst.mockResolvedValue(null); // not yet credited
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', assignedToId: 'rep-1' } as any);
      prisma.commission.create.mockResolvedValue({} as any);

      await handle(makeEvent({ kind: 'renewal' }));

      // Dedup probe + lead resolution are workspace-scoped.
      expect(prisma.commission.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: 'ws-core' }),
        }),
      );
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: 'ws-core',
            convertedTenantId: 'tenant-1',
          }),
        }),
      );
      expect(prisma.commission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-core',
            type: 'RENEWAL',
            status: 'PENDING',
            tenantId: 'tenant-1',
            leadId: 'lead-1',
            marketingUserId: 'rep-1',
            sourcePaymentId: 'pay-1',
            period: '2026-06',
          }),
        }),
      );
      // 799 * 0.15 = 119.85
      const amount = (prisma.commission.create as any).mock.calls[0][0].data.amount;
      expect(amount.toString()).toBe('119.85');
    });

    it('creates an UPSELL commission for kind=upsell', async () => {
      prisma.commission.findFirst.mockResolvedValue(null);
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', assignedToId: 'rep-1' } as any);
      prisma.commission.create.mockResolvedValue({} as any);

      await handle(makeEvent({ kind: 'upsell' }));

      expect(prisma.commission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-core',
            type: 'UPSELL',
            sourcePaymentId: 'pay-1',
          }),
        }),
      );
    });

    it('is idempotent: skips when this payment+type was already credited', async () => {
      prisma.commission.findFirst.mockResolvedValue({ id: 'existing' } as any);

      await handle(makeEvent({ kind: 'renewal' }));

      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(prisma.commission.create).not.toHaveBeenCalled();
    });

    it('skips when the tenant has no converting lead', async () => {
      prisma.commission.findFirst.mockResolvedValue(null);
      prisma.lead.findFirst.mockResolvedValue(null);

      await handle(makeEvent({ kind: 'renewal' }));

      expect(prisma.commission.create).not.toHaveBeenCalled();
    });

    it('treats a P2002 race as already-credited (no throw)', async () => {
      prisma.commission.findFirst.mockResolvedValue(null);
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', assignedToId: 'rep-1' } as any);
      const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      } as any);
      prisma.commission.create.mockRejectedValue(p2002);

      await expect(handle(makeEvent({ kind: 'upsell' }))).resolves.toBeUndefined();
    });
  });

  describe('SIGNUP (self-serve referral)', () => {
    it('auto-creates a WON REFERRAL lead + SIGNUP commission + marketer notification when no lead exists', async () => {
      prisma.commission.findFirst.mockResolvedValue(null); // no existing SIGNUP (inside tx)
      prisma.lead.findUnique.mockResolvedValue(null); // no existing lead
      prisma.lead.create.mockResolvedValue({ id: 'lead-new' } as any);
      prisma.commission.create.mockResolvedValue({} as any);
      prisma.marketingNotification.create.mockResolvedValue({} as any);

      await handle(makeEvent({ kind: 'signup', referredByMarketingUserId: 'rep-9', referralCode: 'AHMET42' }));

      expect(prisma.lead.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-core',
            source: 'REFERRAL',
            status: 'WON',
            assignedToId: 'rep-9',
            convertedTenantId: 'tenant-1',
            businessName: 'Test Restoran',
          }),
        }),
      );
      expect(prisma.commission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-core',
            type: 'SIGNUP',
            leadId: 'lead-new',
            marketingUserId: 'rep-9',
            sourcePaymentId: 'pay-1',
          }),
        }),
      );
      expect(prisma.marketingNotification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ workspaceId: 'ws-core', userId: 'rep-9' }),
        }),
      );
    });

    it("uses the existing lead's rep (admin attribution wins) and does not auto-create", async () => {
      prisma.commission.findFirst.mockResolvedValue(null);
      prisma.lead.findUnique.mockResolvedValue({ id: 'lead-admin', assignedToId: 'rep-admin' } as any);
      prisma.commission.create.mockResolvedValue({} as any);
      prisma.marketingNotification.create.mockResolvedValue({} as any);

      await handle(makeEvent({ kind: 'signup', referredByMarketingUserId: 'rep-9' }));

      expect(prisma.lead.create).not.toHaveBeenCalled();
      expect(prisma.commission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-core',
            type: 'SIGNUP',
            leadId: 'lead-admin',
            marketingUserId: 'rep-admin',
          }),
        }),
      );
    });

    it('is idempotent: skips when a SIGNUP commission already exists', async () => {
      prisma.commission.findFirst.mockResolvedValue({ id: 'existing-signup' } as any);

      await handle(makeEvent({ kind: 'signup', referredByMarketingUserId: 'rep-9' }));

      expect(prisma.lead.create).not.toHaveBeenCalled();
      expect(prisma.commission.create).not.toHaveBeenCalled();
    });

    it('treats a serialization conflict (P2034) as already-credited (no throw, no notify)', async () => {
      const p2034 = Object.assign(new Error('could not serialize'), { code: 'P2034' });
      (prisma.$transaction as any).mockRejectedValue(p2034);

      await expect(
        handle(makeEvent({ kind: 'signup', referredByMarketingUserId: 'rep-9' })),
      ).resolves.toBeUndefined();
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
    });

    it('treats a P2002 unique-violation on the SIGNUP insert as a quiet dedup (no rethrow, no error-log)', async () => {
      // SIGNUP rows set sourcePaymentId, so two deliveries that both clear the
      // pre-check race the (sourcePaymentId, type) partial-unique — the loser
      // surfaces as P2002 from inside the tx, not 40001.
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      } as any);
      (prisma.$transaction as any).mockRejectedValue(p2002);

      await expect(
        handle(makeEvent({ kind: 'signup', referredByMarketingUserId: 'rep-9' })),
      ).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled(); // quiet dedup, not an error
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dedup'));
      expect(prisma.marketingNotification.create).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('ignores a signup event that carries no referrer', async () => {
      await handle(makeEvent({ kind: 'signup', referredByMarketingUserId: null }));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
