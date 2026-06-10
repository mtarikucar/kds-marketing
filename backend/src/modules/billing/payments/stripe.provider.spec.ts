import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PaymentOrder } from '@prisma/client';

// jest.mock is hoisted above imports; only `mock`-prefixed bindings may be
// referenced from the factory. The mocked module is the Stripe constructor
// itself (stripe-node is a callable-class CJS export).
const mockSessionsCreate = jest.fn();
const mockConstructEvent = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockConstructEvent },
  })),
);

import Stripe from 'stripe';
import { StripeProvider } from './stripe.provider';

const StripeCtor = Stripe as unknown as jest.Mock;

const makeOrder = (overrides: Partial<PaymentOrder> = {}): PaymentOrder =>
  ({
    id: 'order-usd-1',
    workspaceId: 'ws-1',
    type: 'SUBSCRIPTION',
    packageId: 'pkg-1',
    addOnCode: null,
    quantity: 1,
    billingCycle: 'MONTHLY',
    amount: new Prisma.Decimal('49.00'),
    currency: 'USD',
    provider: 'stripe',
    providerRef: null,
    idempotencyKey: 'idem-usd-1',
    status: 'PENDING',
    ...overrides,
  }) as unknown as PaymentOrder;

const ctx = {
  buyerEmail: 'buyer@example.com',
  buyerIp: '203.0.113.7',
  returnUrl: 'https://app.example.com/billing',
};

describe('StripeProvider', () => {
  let env: Record<string, string | undefined>;
  let prisma: { paymentOrder: { update: jest.Mock } };
  let provider: StripeProvider;

  beforeEach(() => {
    StripeCtor.mockClear();
    mockSessionsCreate.mockReset();
    env = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
    };
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    prisma = { paymentOrder: { update: jest.fn().mockResolvedValue({}) } };
    provider = new StripeProvider(config, prisma as never);
  });

  it('is configured only with BOTH secret key and webhook secret', () => {
    expect(provider.isConfigured()).toBe(true);
    delete env.STRIPE_WEBHOOK_SECRET;
    expect(provider.isConfigured()).toBe(false);
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
    delete env.STRIPE_SECRET_KEY;
    expect(provider.isConfigured()).toBe(false);
  });

  it('charges USD only', () => {
    expect(provider.supports('USD')).toBe(true);
    expect(provider.supports('TRY')).toBe(false);
  });

  it('instantiates the SDK lazily and only once (creds-less deploys must boot)', async () => {
    // Construction + config checks never touch the SDK.
    expect(StripeCtor).not.toHaveBeenCalled();
    provider.isConfigured();
    expect(StripeCtor).not.toHaveBeenCalled();

    mockSessionsCreate.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      subscription: null,
    });
    await provider.createCheckout(makeOrder(), ctx);
    await provider.createCheckout(makeOrder({ id: 'order-usd-2' }), ctx);

    expect(StripeCtor).toHaveBeenCalledTimes(1);
    expect(StripeCtor).toHaveBeenCalledWith('sk_test_123');
  });

  describe('createCheckout', () => {
    beforeEach(() => {
      mockSessionsCreate.mockResolvedValue({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
      });
    });

    it('opens a subscription-mode session for SUBSCRIPTION orders', async () => {
      const handle = await provider.createCheckout(makeOrder(), ctx);

      expect(mockSessionsCreate).toHaveBeenCalledWith({
        mode: 'subscription',
        client_reference_id: 'order-usd-1',
        customer_email: 'buyer@example.com',
        metadata: { orderId: 'order-usd-1', workspaceId: 'ws-1' },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              product_data: { name: 'Subscription (MONTHLY)' },
              unit_amount: 4900, // cents, integer
              recurring: { interval: 'month' },
            },
          },
        ],
        success_url: 'https://app.example.com/billing?checkout=success',
        cancel_url: 'https://app.example.com/billing?checkout=cancelled',
      });
      expect(handle).toEqual({
        kind: 'redirect',
        url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
      });
    });

    it('persists the session id to providerRef', async () => {
      await provider.createCheckout(makeOrder(), ctx);
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
        where: { id: 'order-usd-1' },
        data: { providerRef: 'cs_test_abc' },
      });
    });

    it('bills YEARLY cycles with a yearly recurring interval', async () => {
      await provider.createCheckout(
        makeOrder({ billingCycle: 'YEARLY', amount: new Prisma.Decimal('490') }),
        ctx,
      );
      const params = mockSessionsCreate.mock.calls[0][0];
      expect(params.line_items[0].price_data.recurring).toEqual({
        interval: 'year',
      });
      expect(params.line_items[0].price_data.unit_amount).toBe(49000);
    });

    it('treats UPGRADE and RENEWAL as subscription-mode too', async () => {
      await provider.createCheckout(makeOrder({ type: 'UPGRADE' }), ctx);
      await provider.createCheckout(makeOrder({ type: 'RENEWAL' }), ctx);
      expect(mockSessionsCreate.mock.calls[0][0].mode).toBe('subscription');
      expect(mockSessionsCreate.mock.calls[1][0].mode).toBe('subscription');
    });

    it('charges ADDON orders as a one-off payment (no recurring)', async () => {
      await provider.createCheckout(
        makeOrder({
          type: 'ADDON',
          addOnCode: 'extra_profile',
          billingCycle: null,
          amount: new Prisma.Decimal('49.00'),
        }),
        ctx,
      );
      const params = mockSessionsCreate.mock.calls[0][0];
      expect(params.mode).toBe('payment');
      expect(params.line_items[0].price_data.recurring).toBeUndefined();
      expect(params.line_items[0].price_data.product_data.name).toBe(
        'Add-on: extra_profile',
      );
    });

    it('fails loud when Stripe returns a session without a URL', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_no_url', url: null });
      await expect(provider.createCheckout(makeOrder(), ctx)).rejects.toThrow(
        'Stripe did not return a redirect URL',
      );
    });

    it('maps Stripe API failures to ServiceUnavailable', async () => {
      mockSessionsCreate.mockRejectedValue(new Error('rate_limited'));
      await expect(
        provider.createCheckout(makeOrder(), ctx),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.paymentOrder.update).not.toHaveBeenCalled();
    });

    it('refuses to start a checkout without credentials (SDK never touched)', async () => {
      delete env.STRIPE_WEBHOOK_SECRET;
      await expect(
        provider.createCheckout(makeOrder(), ctx),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(StripeCtor).not.toHaveBeenCalled();
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });
  });

  describe('getClient', () => {
    it('throws ServiceUnavailable without a secret key', () => {
      delete env.STRIPE_SECRET_KEY;
      expect(() => provider.getClient()).toThrow(ServiceUnavailableException);
    });

    it('caches the instance across calls', () => {
      const a = provider.getClient();
      const b = provider.getClient();
      expect(a).toBe(b);
      expect(StripeCtor).toHaveBeenCalledTimes(1);
    });
  });
});
