import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';

// jest.mock is hoisted above imports; only `mock`-prefixed bindings may be
// referenced from the factory. The controller reaches constructEvent through
// the REAL StripeProvider, so mocking the SDK module exercises the actual
// provider → controller wiring.
const mockConstructEvent = jest.fn();
const mockSessionsCreate = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockConstructEvent },
  })),
);

import { BillingWebhooksController } from './webhooks.controller';
import { StripeProvider } from './stripe.provider';

const MERCHANT_KEY = 'test-merchant-key';
const MERCHANT_SALT = 'test-merchant-salt';
const MERCHANT_OID = 'MKT0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const ORDER_ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

/** Independent re-derivation of PayTR's documented callback formula —
 * deliberately NOT calling the implementation's helper. */
const callbackHash = (oid: string, status: string, total: string): string =>
  crypto
    .createHmac('sha256', MERCHANT_KEY)
    .update(`${oid}${MERCHANT_SALT}${status}${total}`)
    .digest('base64');

describe('BillingWebhooksController', () => {
  let env: Record<string, string | undefined>;
  let prisma: {
    paymentOrder: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let settlement: {
    settleSuccess: jest.Mock;
    settleFailure: jest.Mock;
    extendSubscriptionByProviderRef: jest.Mock;
    cancelSubscriptionByProviderRef: jest.Mock;
  };
  let controller: BillingWebhooksController;

  beforeEach(() => {
    mockConstructEvent.mockReset();
    env = {
      PAYTR_MERCHANT_ID: '123456',
      PAYTR_MERCHANT_KEY: MERCHANT_KEY,
      PAYTR_MERCHANT_SALT: MERCHANT_SALT,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
    };
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    prisma = {
      paymentOrder: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    settlement = {
      settleSuccess: jest.fn().mockResolvedValue({ settled: true }),
      settleFailure: jest.fn().mockResolvedValue({ settled: true }),
      extendSubscriptionByProviderRef: jest.fn().mockResolvedValue(true),
      cancelSubscriptionByProviderRef: jest.fn().mockResolvedValue(true),
    };
    controller = new BillingWebhooksController(
      config,
      prisma as never,
      settlement as never,
      new StripeProvider(config, prisma as never),
    );
  });

  describe('POST paytr', () => {
    const successBody = () => ({
      merchant_oid: MERCHANT_OID,
      status: 'success',
      total_amount: '19900',
      hash: callbackHash(MERCHANT_OID, 'success', '19900'),
    });

    beforeEach(() => {
      prisma.paymentOrder.findUnique.mockResolvedValue({
        id: ORDER_ID,
        status: 'PENDING',
        // amountToKurus('199.00') === '19900' — matches successBody()'s
        // total_amount so the happy-path callbacks still pass the amount guard.
        amount: '199.00',
      });
    });

    it('settles success and answers the literal OK on a verified callback', async () => {
      const body = successBody();
      await expect(controller.paytr(body)).resolves.toBe('OK');

      expect(prisma.paymentOrder.findUnique).toHaveBeenCalledWith({
        where: { providerRef: MERCHANT_OID },
      });
      expect(settlement.settleSuccess).toHaveBeenCalledWith(ORDER_ID, {
        raw: body,
      });
      expect(settlement.settleFailure).not.toHaveBeenCalled();
    });

    it('settles when the verified total_amount matches the order amount', async () => {
      // order.amount '199.00' → 19900 kuruş == total_amount '19900'.
      const body = successBody();
      await expect(controller.paytr(body)).resolves.toBe('OK');
      expect(settlement.settleSuccess).toHaveBeenCalledWith(ORDER_ID, {
        raw: body,
      });
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT settle on an amount mismatch — flags for review, still answers OK', async () => {
      // Hash is valid over the (tampered) 18000, so verification passes but the
      // paid amount (180.00) is below the order's 199.00 → must not settle.
      const body = {
        merchant_oid: MERCHANT_OID,
        status: 'success',
        total_amount: '18000',
        hash: callbackHash(MERCHANT_OID, 'success', '18000'),
      };
      await expect(controller.paytr(body)).resolves.toBe('OK');

      expect(settlement.settleSuccess).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: ORDER_ID,
          status: { in: ['PENDING', 'AWAITING_TRANSFER'] },
        },
        data: expect.objectContaining({
          raw: expect.objectContaining({
            needsReview: true,
            reason: 'paytr_amount_mismatch',
            paidKurus: '18000',
            expectedKurus: '19900',
          }),
        }),
      });
    });

    it('settles failure with the PayTR reason on status!=success', async () => {
      const body = {
        merchant_oid: MERCHANT_OID,
        status: 'failed',
        total_amount: '19900',
        hash: callbackHash(MERCHANT_OID, 'failed', '19900'),
        failed_reason_code: '6',
        failed_reason_msg: 'Yetersiz bakiye',
      };
      await expect(controller.paytr(body)).resolves.toBe('OK');
      expect(settlement.settleFailure).toHaveBeenCalledWith(
        ORDER_ID,
        'Yetersiz bakiye',
        body,
      );
      expect(settlement.settleSuccess).not.toHaveBeenCalled();
    });

    it('falls back to failed_reason_code, then a generic reason', async () => {
      await controller.paytr({
        merchant_oid: MERCHANT_OID,
        status: 'failed',
        total_amount: '19900',
        hash: callbackHash(MERCHANT_OID, 'failed', '19900'),
        failed_reason_code: '9',
      });
      expect(settlement.settleFailure).toHaveBeenCalledWith(
        ORDER_ID,
        '9',
        expect.anything(),
      );

      settlement.settleFailure.mockClear();
      await controller.paytr({
        merchant_oid: MERCHANT_OID,
        status: 'failed',
        total_amount: '19900',
        hash: callbackHash(MERCHANT_OID, 'failed', '19900'),
      });
      expect(settlement.settleFailure).toHaveBeenCalledWith(
        ORDER_ID,
        'payment failed',
        expect.anything(),
      );
    });

    it('rejects a bad hash with 400 and never touches settlement', async () => {
      await expect(
        controller.paytr({ ...successBody(), hash: 'forged-hash' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // status flipped to success but hash signed over 'failed' — the
      // classic replay-forgery shape.
      await expect(
        controller.paytr({
          ...successBody(),
          hash: callbackHash(MERCHANT_OID, 'failed', '19900'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(settlement.settleSuccess).not.toHaveBeenCalled();
      expect(settlement.settleFailure).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.findUnique).not.toHaveBeenCalled();
    });

    it('still answers OK for an already-settled replay', async () => {
      settlement.settleSuccess.mockResolvedValue({
        settled: false,
        reason: 'already settled',
      });
      await expect(controller.paytr(successBody())).resolves.toBe('OK');
    });

    it('answers OK for an unknown merchant_oid without settling', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(null);
      await expect(controller.paytr(successBody())).resolves.toBe('OK');
      expect(settlement.settleSuccess).not.toHaveBeenCalled();
    });

    it('still answers OK when settlement raises (no PayTR retry feedback loop)', async () => {
      settlement.settleSuccess.mockRejectedValue(new Error('db down'));
      await expect(controller.paytr(successBody())).resolves.toBe('OK');
    });

    it('refuses to acknowledge anything when credentials are missing', async () => {
      delete env.PAYTR_MERCHANT_KEY;
      await expect(controller.paytr(successBody())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('POST stripe', () => {
    const RAW_BODY = Buffer.from('{"raw":"payload"}');
    const makeReq = (
      headers: Record<string, unknown> = { 'stripe-signature': 'sig_test' },
    ): Request => ({ headers, body: RAW_BODY }) as unknown as Request;

    it('verifies the signature over the raw Buffer with the webhook secret', async () => {
      mockConstructEvent.mockReturnValue({ type: 'ping', data: { object: {} } });
      await expect(controller.stripe(makeReq())).resolves.toEqual({
        received: true,
      });
      expect(mockConstructEvent).toHaveBeenCalledWith(
        RAW_BODY,
        'sig_test',
        'whsec_test_123',
      );
    });

    it('rejects a bad signature with 400', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });
      await expect(controller.stripe(makeReq())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(settlement.settleSuccess).not.toHaveBeenCalled();
    });

    it('rejects a missing stripe-signature header with 400', async () => {
      await expect(controller.stripe(makeReq({}))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockConstructEvent).not.toHaveBeenCalled();
    });

    it('refuses to verify without STRIPE_WEBHOOK_SECRET', async () => {
      delete env.STRIPE_WEBHOOK_SECRET;
      await expect(controller.stripe(makeReq())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    describe('checkout.session.completed', () => {
      const event = (sessionOverrides: Record<string, unknown> = {}) => ({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_abc',
            metadata: { orderId: ORDER_ID, workspaceId: 'ws-1' },
            client_reference_id: ORDER_ID,
            subscription: 'sub_123',
            ...sessionOverrides,
          },
        },
      });

      it('repoints providerRef to the subscription id BEFORE settling', async () => {
        const evt = event();
        mockConstructEvent.mockReturnValue(evt);

        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });

        expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
          where: { id: ORDER_ID },
          data: { providerRef: 'sub_123' },
        });
        expect(settlement.settleSuccess).toHaveBeenCalledWith(ORDER_ID, {
          raw: evt,
        });
        // Order matters: settlement copies order.providerRef onto the
        // subscription row — renewals resolve through that ref.
        expect(
          prisma.paymentOrder.update.mock.invocationCallOrder[0],
        ).toBeLessThan(settlement.settleSuccess.mock.invocationCallOrder[0]);
      });

      it('falls back to client_reference_id when metadata is missing', async () => {
        mockConstructEvent.mockReturnValue(event({ metadata: null }));
        await controller.stripe(makeReq());
        expect(settlement.settleSuccess).toHaveBeenCalledWith(
          ORDER_ID,
          expect.anything(),
        );
      });

      it('settles payment-mode sessions (no subscription) without touching providerRef', async () => {
        mockConstructEvent.mockReturnValue(event({ subscription: null }));
        await controller.stripe(makeReq());
        expect(prisma.paymentOrder.update).not.toHaveBeenCalled();
        expect(settlement.settleSuccess).toHaveBeenCalledWith(
          ORDER_ID,
          expect.anything(),
        );
      });

      it('unwraps an expanded subscription object to its id', async () => {
        mockConstructEvent.mockReturnValue(
          event({ subscription: { id: 'sub_expanded' } }),
        );
        await controller.stripe(makeReq());
        expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
          where: { id: ORDER_ID },
          data: { providerRef: 'sub_expanded' },
        });
      });

      it('acknowledges without settling when no orderId can be resolved', async () => {
        mockConstructEvent.mockReturnValue(
          event({ metadata: null, client_reference_id: null }),
        );
        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });
        expect(settlement.settleSuccess).not.toHaveBeenCalled();
      });

      it('acknowledges an unknown order id instead of making Stripe retry forever', async () => {
        prisma.paymentOrder.update.mockRejectedValue({ code: 'P2025' });
        mockConstructEvent.mockReturnValue(event());
        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });
        expect(settlement.settleSuccess).not.toHaveBeenCalled();
      });
    });

    describe('invoice.paid', () => {
      const invoiceEvent = (invoice: Record<string, unknown>) => ({
        type: 'invoice.paid',
        data: { object: invoice },
      });
      const PERIOD_END = 1781136000; // 2026-06-11T00:00:00Z

      it('extends the subscription period on a renewal cycle (legacy payload shape)', async () => {
        mockConstructEvent.mockReturnValue(
          invoiceEvent({
            billing_reason: 'subscription_cycle',
            subscription: 'sub_123',
            lines: { data: [{ period: { end: PERIOD_END } }] },
          }),
        );
        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });
        expect(
          settlement.extendSubscriptionByProviderRef,
        ).toHaveBeenCalledWith('sub_123', new Date(PERIOD_END * 1000));
      });

      it('extends on the new (parent.subscription_details) payload shape too', async () => {
        mockConstructEvent.mockReturnValue(
          invoiceEvent({
            billing_reason: 'subscription_cycle',
            parent: { subscription_details: { subscription: 'sub_456' } },
            lines: { data: [{ period: { end: PERIOD_END } }] },
          }),
        );
        await controller.stripe(makeReq());
        expect(
          settlement.extendSubscriptionByProviderRef,
        ).toHaveBeenCalledWith('sub_456', new Date(PERIOD_END * 1000));
      });

      it('ignores the first invoice of a subscription (settled via checkout.session.completed)', async () => {
        mockConstructEvent.mockReturnValue(
          invoiceEvent({
            billing_reason: 'subscription_create',
            subscription: 'sub_123',
            lines: { data: [{ period: { end: PERIOD_END } }] },
          }),
        );
        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });
        expect(
          settlement.extendSubscriptionByProviderRef,
        ).not.toHaveBeenCalled();
      });

      it('skips (still 200) when the cycle invoice carries no subscription/period', async () => {
        mockConstructEvent.mockReturnValue(
          invoiceEvent({ billing_reason: 'subscription_cycle', lines: { data: [] } }),
        );
        await expect(controller.stripe(makeReq())).resolves.toEqual({
          received: true,
        });
        expect(
          settlement.extendSubscriptionByProviderRef,
        ).not.toHaveBeenCalled();
      });
    });

    it('cancels at period end on customer.subscription.deleted', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_123' } },
      });
      await expect(controller.stripe(makeReq())).resolves.toEqual({
        received: true,
      });
      expect(settlement.cancelSubscriptionByProviderRef).toHaveBeenCalledWith(
        'sub_123',
      );
    });

    it('acknowledges unhandled event types without side effects', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1' } },
      });
      await expect(controller.stripe(makeReq())).resolves.toEqual({
        received: true,
      });
      expect(settlement.settleSuccess).not.toHaveBeenCalled();
      expect(settlement.settleFailure).not.toHaveBeenCalled();
      expect(settlement.extendSubscriptionByProviderRef).not.toHaveBeenCalled();
      expect(settlement.cancelSubscriptionByProviderRef).not.toHaveBeenCalled();
    });
  });
});
