import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentOrder, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { URLSearchParams } from 'url';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BillingPaymentProvider,
  CheckoutContext,
  CheckoutHandle,
} from './payment-provider.port';

/**
 * PayTR iFrame Token API adapter — protocol ported verbatim from the
 * monorepo's battle-tested `payments/adapters/paytr.adapter.ts` +
 * `payments/webhooks/paytr-hash.util.ts`. The crypto primitives are
 * exported as pure functions so the signature shapes can be unit-tested
 * against hand-computed fixtures without a Nest container or HTTP stubs.
 *
 * PayTR collects TRY only ("TL" in their wire format); USD checkout goes
 * through Stripe instead. supports() enforces that at the provider-picker
 * level so a USD-priced order can never silently collect the same numeric
 * amount in lira (the monorepo's "199 $ olan şey 199 TL olarak satın
 * alınıyor" incident).
 */

export const PAYTR_DEFAULT_BASE_URL = 'https://www.paytr.com';

export interface PaytrCredentials {
  merchantKey: string;
  merchantSalt: string;
}

export interface IframeTokenPayload {
  merchantId: string;
  userIp: string;
  merchantOid: string;
  email: string;
  paymentAmount: string; // kuruş, as string
  userBasketBase64: string;
  noInstallment: string; // "0" or "1"
  maxInstallment: string; // "0" = no limit
  currency: string; // "TL" for TRY
  testMode: string; // "0" or "1"
}

/** Decimal-safe TRY → kuruş (PayTR wants minor units as an integer string). */
export function amountToKurus(
  amount: number | string | Prisma.Decimal,
): string {
  const decimal = new Prisma.Decimal(amount);
  if (decimal.isNegative()) {
    throw new Error('PayTR amount must be non-negative');
  }
  return decimal
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(0);
}

/** PayTR's user_basket: base64 of JSON [[name, unitPrice, qty], ...]. */
export function encodeUserBasket(
  basket: Array<[string, string, number]>,
): string {
  return Buffer.from(JSON.stringify(basket), 'utf-8').toString('base64');
}

/**
 * get-token request signature, per PayTR's iFrame API docs:
 *   base64(HMAC-SHA256(merchantKey,
 *     merchant_id + user_ip + merchant_oid + email + payment_amount +
 *     user_basket + no_installment + max_installment + currency + test_mode
 *     + merchant_salt))
 * Field ORDER is load-bearing — PayTR rejects any permutation.
 */
export function buildIframeTokenSignature(
  payload: IframeTokenPayload,
  creds: PaytrCredentials,
): string {
  const concat =
    payload.merchantId +
    payload.userIp +
    payload.merchantOid +
    payload.email +
    payload.paymentAmount +
    payload.userBasketBase64 +
    payload.noInstallment +
    payload.maxInstallment +
    payload.currency +
    payload.testMode;
  return crypto
    .createHmac('sha256', creds.merchantKey)
    .update(concat + creds.merchantSalt)
    .digest('base64');
}

export interface CallbackHashInput {
  merchantOid: string;
  merchantSalt: string;
  status: string;
  totalAmount: string;
  merchantKey: string;
}

/**
 * Callback ("Bildirim URL") signature, per PayTR docs:
 *   base64(HMAC-SHA256(merchantKey,
 *     merchant_oid + merchant_salt + status + total_amount))
 * Note the salt sits INSIDE the hashed string here (second position),
 * unlike the get-token signature where it is appended last.
 */
export function computeCallbackHash(input: CallbackHashInput): string {
  const { merchantOid, merchantSalt, status, totalAmount, merchantKey } = input;
  return crypto
    .createHmac('sha256', merchantKey)
    .update(`${merchantOid}${merchantSalt}${status}${totalAmount}`)
    .digest('base64');
}

export function verifyCallbackHash(
  input: CallbackHashInput & { providedHash: string },
): boolean {
  const expected = computeCallbackHash(input);
  const provided = input.providedHash;
  // timingSafeEqual throws on length mismatch — guard first.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** What the customer sees as the single basket line on PayTR's iframe. */
function describeOrder(order: PaymentOrder): string {
  return order.type === 'ADDON'
    ? `Add-on: ${order.addOnCode ?? 'addon'}`
    : `Subscription (${order.billingCycle ?? 'MONTHLY'})`;
}

@Injectable()
export class PaytrProvider implements BillingPaymentProvider {
  readonly id = 'paytr' as const;
  private readonly logger = new Logger(PaytrProvider.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('PAYTR_MERCHANT_ID') &&
        this.configService.get<string>('PAYTR_MERCHANT_KEY') &&
        this.configService.get<string>('PAYTR_MERCHANT_SALT'),
    );
  }

  supports(currency: string): boolean {
    return currency === 'TRY';
  }

  private get baseUrl(): string {
    return (
      this.configService.get<string>('PAYTR_BASE_URL') ??
      PAYTR_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
  }

  async createCheckout(
    order: PaymentOrder,
    ctx: CheckoutContext,
  ): Promise<CheckoutHandle> {
    // BillingService already gates on isConfigured(); re-check so a direct
    // caller can never half-start a checkout with missing credentials.
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('PayTR is not configured');
    }
    const merchantId = this.configService.get<string>('PAYTR_MERCHANT_ID')!;
    const merchantKey = this.configService.get<string>('PAYTR_MERCHANT_KEY')!;
    const merchantSalt =
      this.configService.get<string>('PAYTR_MERCHANT_SALT')!;
    // Same default as the monorepo adapter: an unset flag means TEST mode —
    // a forgotten env in a fresh deploy must never charge real cards.
    const testMode =
      this.configService.get<string>('PAYTR_TEST_MODE') === '0' ? '0' : '1';

    // merchant_oid MUST be alphanumeric (PayTR rejects dashes) — strip the
    // uuid's hyphens and prefix with MKT so the webhook side can recognise
    // marketing-billing OIDs at a glance in PayTR's panel/logs.
    const merchantOid = `MKT${order.id.replace(/-/g, '')}`;

    // Persist the OID as providerRef BEFORE calling PayTR: once get-token
    // succeeds the customer can pay, and the webhook resolves the order by
    // providerRef alone. If our process dies between the API call and a
    // late write, the payment would otherwise be unmatchable.
    //
    // Guard the write on status='PENDING' via updateMany: a re-issued checkout
    // on an order that's already moved on (SUCCEEDED/FAILED/another provider's
    // ref) must NOT silently repoint providerRef and steal a settled order's
    // webhook routing. count===0 means the order is no longer pending — fall
    // through without overwriting; the webhook still lands on whatever ref the
    // winning checkout wrote.
    await this.prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'PENDING' },
      data: { providerRef: merchantOid },
    });

    const paymentAmount = amountToKurus(order.amount);
    const userBasketBase64 = encodeUserBasket([
      [describeOrder(order), new Prisma.Decimal(order.amount).toFixed(2), 1],
    ]);

    const payload: IframeTokenPayload = {
      merchantId,
      userIp: ctx.buyerIp,
      merchantOid,
      email: ctx.buyerEmail,
      paymentAmount,
      userBasketBase64,
      noInstallment: '0',
      maxInstallment: '0',
      currency: 'TL', // PayTR's wire label for TRY
      testMode,
    };
    const paytrToken = buildIframeTokenSignature(payload, {
      merchantKey,
      merchantSalt,
    });

    const form = new URLSearchParams({
      merchant_id: merchantId,
      user_ip: ctx.buyerIp,
      merchant_oid: merchantOid,
      email: ctx.buyerEmail,
      payment_amount: paymentAmount,
      paytr_token: paytrToken,
      user_basket: userBasketBase64,
      // debug_on follows test_mode — verbose PayTR-side logging in test
      // mode, off in production so PayTR doesn't echo payload details back.
      debug_on: testMode === '1' ? '1' : '0',
      no_installment: '0',
      max_installment: '0',
      // Marketing checkout only collects email + IP (CheckoutContext);
      // name/address/phone are required form fields for PayTR, so send the
      // email as the display name and explicit N/A markers rather than
      // fabricating plausible-looking junk for the fraud model.
      user_name: ctx.buyerEmail,
      user_address: 'N/A',
      user_phone: 'N/A',
      merchant_ok_url: ctx.returnUrl,
      merchant_fail_url: ctx.returnUrl,
      timeout_limit: '30',
      currency: 'TL',
      test_mode: testMode,
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/odeme/api/get-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.logger.error(
        `PayTR get-token HTTP failure for order ${order.id}: ${(err as Error)?.message}`,
      );
      throw new ServiceUnavailableException('PayTR is currently unreachable');
    }

    const body = await response.json().catch(() => null as unknown);
    if (
      !response.ok ||
      (body as { status?: string })?.status !== 'success' ||
      !(body as { token?: string })?.token
    ) {
      this.logger.error(
        `PayTR get-token rejected for order ${order.id}: ${JSON.stringify(body)}`,
      );
      // PayTR is inconsistent about the error field — sometimes `reason`,
      // sometimes `err_msg`, sometimes `errors`. Fall through all of them.
      const b = (body ?? {}) as Record<string, unknown>;
      const msg =
        b.reason ?? b.err_msg ?? b.errors ?? 'PayTR rejected the payment intent';
      throw new ServiceUnavailableException(String(msg));
    }

    const token = (body as { token: string }).token;
    return {
      kind: 'iframe',
      token,
      iframeUrl: `${this.baseUrl}/odeme/guvenli/${token}`,
    };
  }
}
