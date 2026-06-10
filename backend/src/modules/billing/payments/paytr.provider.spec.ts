import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PaymentOrder } from '@prisma/client';
import {
  PaytrProvider,
  amountToKurus,
  encodeUserBasket,
  buildIframeTokenSignature,
  computeCallbackHash,
  verifyCallbackHash,
} from './paytr.provider';

/**
 * The crypto fixtures below are HAND-COMPUTED (node -e with crypto directly,
 * not via the functions under test) so a regression in the concatenation
 * order or the keying can never self-verify. Inputs:
 *   merchantId 123456, ip 203.0.113.7, oid MKT0a1b…e8f9,
 *   email buyer@example.com, amount 19900 kuruş,
 *   basket [["Subscription (MONTHLY)","199.00",1]],
 *   key test-merchant-key, salt test-merchant-salt.
 */
const MERCHANT_ID = '123456';
const MERCHANT_KEY = 'test-merchant-key';
const MERCHANT_SALT = 'test-merchant-salt';
const ORDER_ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const MERCHANT_OID = 'MKT0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const BASKET_B64 = 'W1siU3Vic2NyaXB0aW9uIChNT05USExZKSIsIjE5OS4wMCIsMV1d';
const EXPECTED_TOKEN_SIG = 'dOJ+uLizS04JrP0WLnPW+dgHAK9rAYa4zGEFDLzHegU=';
const EXPECTED_CALLBACK_HASH = 'Q+JlUKWfs8bvl78OLSOCwWTBVX1THjiCVhCcdNkNJ30=';

const makeOrder = (overrides: Partial<PaymentOrder> = {}): PaymentOrder =>
  ({
    id: ORDER_ID,
    workspaceId: 'ws-1',
    type: 'SUBSCRIPTION',
    packageId: 'pkg-1',
    addOnCode: null,
    quantity: 1,
    billingCycle: 'MONTHLY',
    amount: new Prisma.Decimal('199.00'),
    currency: 'TRY',
    provider: 'paytr',
    providerRef: null,
    idempotencyKey: 'idem-1',
    status: 'PENDING',
    ...overrides,
  }) as unknown as PaymentOrder;

describe('paytr crypto primitives', () => {
  it('converts decimal TRY amounts to kuruş integer strings', () => {
    expect(amountToKurus(new Prisma.Decimal('199.00'))).toBe('19900');
    expect(amountToKurus('199.99')).toBe('19999');
    // ROUND_HALF_UP on sub-kuruş precision drift.
    expect(amountToKurus('129.985')).toBe('12999');
    expect(amountToKurus(0)).toBe('0');
    expect(() => amountToKurus('-1')).toThrow();
  });

  it('encodes the basket as base64 JSON (fixture)', () => {
    expect(encodeUserBasket([['Subscription (MONTHLY)', '199.00', 1]])).toBe(
      BASKET_B64,
    );
  });

  it('computes the get-token signature exactly as PayTR documents it (hand-computed fixture)', () => {
    const sig = buildIframeTokenSignature(
      {
        merchantId: MERCHANT_ID,
        userIp: '203.0.113.7',
        merchantOid: MERCHANT_OID,
        email: 'buyer@example.com',
        paymentAmount: '19900',
        userBasketBase64: BASKET_B64,
        noInstallment: '0',
        maxInstallment: '0',
        currency: 'TL',
        testMode: '1',
      },
      { merchantKey: MERCHANT_KEY, merchantSalt: MERCHANT_SALT },
    );
    expect(sig).toBe(EXPECTED_TOKEN_SIG);
  });

  it('computes the callback hash exactly as PayTR documents it (hand-computed fixture)', () => {
    expect(
      computeCallbackHash({
        merchantOid: MERCHANT_OID,
        merchantSalt: MERCHANT_SALT,
        status: 'success',
        totalAmount: '19900',
        merchantKey: MERCHANT_KEY,
      }),
    ).toBe(EXPECTED_CALLBACK_HASH);
  });

  it('verifyCallbackHash accepts the genuine hash and rejects tampering', () => {
    const base = {
      merchantOid: MERCHANT_OID,
      merchantSalt: MERCHANT_SALT,
      status: 'success',
      totalAmount: '19900',
      merchantKey: MERCHANT_KEY,
    };
    expect(
      verifyCallbackHash({ ...base, providedHash: EXPECTED_CALLBACK_HASH }),
    ).toBe(true);
    // Flipped status with the old hash (the classic forgery: re-post a
    // failed payment as success).
    expect(
      verifyCallbackHash({
        ...base,
        status: 'failed',
        providedHash: EXPECTED_CALLBACK_HASH,
      }),
    ).toBe(false);
    // Same-length garbage and wrong-length garbage (timingSafeEqual guard).
    expect(
      verifyCallbackHash({
        ...base,
        providedHash: 'A'.repeat(EXPECTED_CALLBACK_HASH.length),
      }),
    ).toBe(false);
    expect(verifyCallbackHash({ ...base, providedHash: 'short' })).toBe(false);
    expect(verifyCallbackHash({ ...base, providedHash: '' })).toBe(false);
  });
});

describe('PaytrProvider', () => {
  const fetchMock = jest.fn();
  let env: Record<string, string | undefined>;
  let prisma: { paymentOrder: { update: jest.Mock } };
  let provider: PaytrProvider;

  beforeEach(() => {
    fetchMock.mockReset();
    (global as Record<string, unknown>).fetch = fetchMock;
    env = {
      PAYTR_MERCHANT_ID: MERCHANT_ID,
      PAYTR_MERCHANT_KEY: MERCHANT_KEY,
      PAYTR_MERCHANT_SALT: MERCHANT_SALT,
      // PAYTR_TEST_MODE deliberately unset → must default to '1' (test mode).
    };
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    prisma = { paymentOrder: { update: jest.fn().mockResolvedValue({}) } };
    provider = new PaytrProvider(config, prisma as never);
  });

  it('is configured only when all three credentials are present', () => {
    expect(provider.isConfigured()).toBe(true);
    delete env.PAYTR_MERCHANT_SALT;
    expect(provider.isConfigured()).toBe(false);
  });

  it('charges TRY only', () => {
    expect(provider.supports('TRY')).toBe(true);
    expect(provider.supports('USD')).toBe(false);
  });

  describe('createCheckout', () => {
    const okResponse = {
      ok: true,
      json: () => Promise.resolve({ status: 'success', token: 'tok123' }),
    };

    it('returns an iframe handle from a successful get-token call', async () => {
      fetchMock.mockResolvedValue(okResponse);

      const handle = await provider.createCheckout(makeOrder(), {
        buyerEmail: 'buyer@example.com',
        buyerIp: '203.0.113.7',
        returnUrl: 'https://app.example.com/billing',
      });

      expect(handle).toEqual({
        kind: 'iframe',
        token: 'tok123',
        iframeUrl: 'https://www.paytr.com/odeme/guvenli/tok123',
      });
    });

    it('persists the alphanumeric merchant_oid to providerRef BEFORE calling PayTR', async () => {
      fetchMock.mockResolvedValue(okResponse);

      await provider.createCheckout(makeOrder(), {
        buyerEmail: 'buyer@example.com',
        buyerIp: '203.0.113.7',
        returnUrl: 'https://app.example.com/billing',
      });

      expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
        where: { id: ORDER_ID },
        data: { providerRef: MERCHANT_OID },
      });
      // The write must land before the HTTP call: if the process dies
      // mid-call the webhook can still resolve the order by providerRef.
      expect(prisma.paymentOrder.update.mock.invocationCallOrder[0]).toBeLessThan(
        fetchMock.mock.invocationCallOrder[0],
      );
      expect(MERCHANT_OID).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('posts the documented form fields with the fixture-pinned signature', async () => {
      fetchMock.mockResolvedValue(okResponse);

      await provider.createCheckout(makeOrder(), {
        buyerEmail: 'buyer@example.com',
        buyerIp: '203.0.113.7',
        returnUrl: 'https://app.example.com/billing',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://www.paytr.com/odeme/api/get-token');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      const form = new URLSearchParams(init.body as string);
      expect(form.get('merchant_id')).toBe(MERCHANT_ID);
      expect(form.get('merchant_oid')).toBe(MERCHANT_OID);
      expect(form.get('user_ip')).toBe('203.0.113.7');
      expect(form.get('email')).toBe('buyer@example.com');
      expect(form.get('payment_amount')).toBe('19900'); // kuruş, not lira
      expect(form.get('user_basket')).toBe(BASKET_B64);
      expect(form.get('currency')).toBe('TL');
      expect(form.get('test_mode')).toBe('1'); // unset env defaults to test
      expect(form.get('merchant_ok_url')).toBe('https://app.example.com/billing');
      expect(form.get('merchant_fail_url')).toBe(
        'https://app.example.com/billing',
      );
      // The whole point: the wire token matches the hand-computed HMAC.
      expect(form.get('paytr_token')).toBe(EXPECTED_TOKEN_SIG);
    });

    it('honours PAYTR_BASE_URL for both the API call and the iframe URL', async () => {
      env.PAYTR_BASE_URL = 'https://paytr.test/';
      fetchMock.mockResolvedValue(okResponse);

      const handle = await provider.createCheckout(makeOrder(), {
        buyerEmail: 'buyer@example.com',
        buyerIp: '203.0.113.7',
        returnUrl: 'https://app.example.com/billing',
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://paytr.test/odeme/api/get-token',
      );
      expect(handle).toMatchObject({
        iframeUrl: 'https://paytr.test/odeme/guvenli/tok123',
      });
    });

    it('surfaces a PayTR rejection as ServiceUnavailable with the reason', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'failed', reason: 'paytr_token invalid' }),
      });

      await expect(
        provider.createCheckout(makeOrder(), {
          buyerEmail: 'buyer@example.com',
          buyerIp: '203.0.113.7',
          returnUrl: 'https://app.example.com/billing',
        }),
      ).rejects.toThrow('paytr_token invalid');
    });

    it('maps network failures to ServiceUnavailable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        provider.createCheckout(makeOrder(), {
          buyerEmail: 'buyer@example.com',
          buyerIp: '203.0.113.7',
          returnUrl: 'https://app.example.com/billing',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('refuses to start a checkout without credentials (no write, no call)', async () => {
      delete env.PAYTR_MERCHANT_KEY;

      await expect(
        provider.createCheckout(makeOrder(), {
          buyerEmail: 'buyer@example.com',
          buyerIp: '203.0.113.7',
          returnUrl: 'https://app.example.com/billing',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.paymentOrder.update).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('labels add-on orders with their code on the basket line', async () => {
      fetchMock.mockResolvedValue(okResponse);

      await provider.createCheckout(
        makeOrder({
          type: 'ADDON',
          addOnCode: 'quota_boost_10',
          billingCycle: null,
          amount: new Prisma.Decimal('2690.00'),
        }),
        {
          buyerEmail: 'buyer@example.com',
          buyerIp: '203.0.113.7',
          returnUrl: 'https://app.example.com/billing',
        },
      );

      const form = new URLSearchParams(
        fetchMock.mock.calls[0][1].body as string,
      );
      const basket = JSON.parse(
        Buffer.from(form.get('user_basket')!, 'base64').toString('utf-8'),
      );
      expect(basket).toEqual([['Add-on: quota_boost_10', '2690.00', 1]]);
      expect(form.get('payment_amount')).toBe('269000');
    });
  });
});
