import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import type Stripe from 'stripe';
import { PrismaService } from '../../../prisma/prisma.service';
import { BillingSettlementService } from '../billing-settlement.service';
import { amountToKurus, verifyCallbackHash } from './paytr.provider';
import { StripeProvider } from './stripe.provider';

// stripe-node v19+ stopped re-exporting the resource-type namespace from the
// package root (`Stripe.Event` no longer resolves) — derive the event union
// from the instance type; Extract<> recovers the per-event narrowing.
type StripeEvent = ReturnType<Stripe.Stripe['webhooks']['constructEvent']>;
type CheckoutSessionCompletedEvent = Extract<
  StripeEvent,
  { type: 'checkout.session.completed' }
>;
type InvoicePaidEvent = Extract<StripeEvent, { type: 'invoice.paid' }>;

interface PaytrCallbackBody {
  merchant_oid?: string;
  status?: string;
  total_amount?: string;
  hash?: string;
  failed_reason_code?: string;
  failed_reason_msg?: string;
  payment_type?: string;
  currency?: string;
  test_mode?: string;
}

/**
 * Stripe moved `invoice.subscription` under `parent.subscription_details`
 * (API 2025-03+), and the webhook payload shape follows the ACCOUNT's
 * pinned API version — not this library's. Accept both shapes so a key
 * rotation / version bump never silently breaks renewals.
 */
interface InvoiceSubscriptionCarrier {
  billing_reason?: string | null;
  subscription?: string | { id: string } | null;
  parent?: {
    subscription_details?: {
      subscription?: string | { id: string } | null;
    } | null;
  } | null;
  lines?: {
    data?: Array<{ period?: { end?: number | null } | null }> | null;
  } | null;
}

/**
 * The PSP-facing surface of the billing module. These routes authenticate
 * by provider signature (PayTR HMAC / Stripe webhook signature), never by
 * user token — they are deliberately outside every auth guard. All state
 * changes flow through BillingSettlementService; this controller only
 * verifies, resolves the order/subscription, and dispatches.
 *
 * Routes (global 'api' prefix): POST /api/billing/webhooks/paytr,
 * POST /api/billing/webhooks/stripe. main.ts mounts a raw body parser on
 * the stripe path specifically — its signature is computed over the exact
 * payload bytes, so `req.body` arrives here as a Buffer.
 */
@Controller('billing/webhooks')
export class BillingWebhooksController {
  private readonly logger = new Logger(BillingWebhooksController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly settlement: BillingSettlementService,
    private readonly stripeProvider: StripeProvider,
  ) {}

  /**
   * PayTR "Bildirim URL" callback (form-urlencoded). Contract, ported from
   * the monorepo's PaytrWebhookController:
   *   - Verify HMAC-SHA256 over `${merchant_oid}${salt}${status}${total_amount}`.
   *   - On a verified callback ALWAYS answer the literal text "OK" — PayTR
   *     retries until it sees it, including for replays of already-settled
   *     payments and unknown OIDs (settlement's guarded flip makes replays
   *     no-ops; answering non-OK for unknowns would both retry forever and
   *     leak which OIDs exist).
   *   - A bad/missing hash is the one case that must NOT be acknowledged:
   *     400, so a forged callback can never look delivered.
   */
  @Post('paytr')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  async paytr(@Body() body: PaytrCallbackBody): Promise<string> {
    const merchantOid = body.merchant_oid ?? '';
    const status = body.status ?? '';
    const totalAmount = body.total_amount ?? '';
    const providedHash = body.hash ?? '';

    const merchantKey = this.configService.get<string>('PAYTR_MERCHANT_KEY');
    const merchantSalt = this.configService.get<string>('PAYTR_MERCHANT_SALT');
    if (!merchantKey || !merchantSalt) {
      // Without credentials we cannot verify anything, and acknowledging
      // unverified callbacks would silently swallow real payments. A non-OK
      // answer keeps PayTR retrying — the loudest possible ops alert.
      this.logger.error(
        'PayTR callback received but credentials are missing — refusing to acknowledge; restore env before the retry window expires',
      );
      throw new ServiceUnavailableException(
        'PayTR webhook verification unavailable',
      );
    }

    if (
      !verifyCallbackHash({
        merchantOid,
        merchantSalt,
        status,
        totalAmount,
        merchantKey,
        providedHash,
      })
    ) {
      this.logger.warn(
        `Rejected PayTR callback with bad hash for oid=${merchantOid || '<empty>'}`,
      );
      throw new BadRequestException('PayTR callback hash mismatch');
    }

    // createCheckout persisted merchant_oid as providerRef BEFORE calling
    // PayTR, so a verified callback always has a row to land on — unless
    // the OID belongs to another environment (test/prod sharing a merchant
    // account). Acknowledge those so PayTR stops retrying.
    const order = await this.prisma.paymentOrder.findUnique({
      where: { providerRef: merchantOid },
    });
    if (!order) {
      this.logger.warn(
        `PayTR callback for unknown merchant_oid=${merchantOid} — acknowledging without settling`,
      );
      return 'OK';
    }

    try {
      if (status === 'success') {
        // Amount tamper guard: the hash only covers merchant_oid+salt+status+
        // total_amount, so a verified callback proves PayTR sent THIS amount —
        // but not that it equals what we asked to charge. Compare the paid
        // kuruş against the order's expected kuruş before settling, so a
        // mismatched-amount callback (replayed from another order, or a
        // gateway/pricing drift like the "199$ collected as 199TL" incident)
        // can never silently grant entitlements. parseInt over the kuruş
        // strings normalises any zero-padding/formatting differences.
        const expectedKurus = amountToKurus(order.amount);
        const paidKurus = Number.parseInt(totalAmount, 10);
        if (paidKurus !== Number.parseInt(expectedKurus, 10)) {
          this.logger.error(
            `PayTR amount mismatch for order ${order.id} (oid=${merchantOid}): paid ${totalAmount} kuruş, expected ${expectedKurus} kuruş — NOT settling; flagged for review`,
          );
          // Persist a review marker on the still-unsettled order; guard the
          // where on the pre-settlement statuses so we never clobber a row
          // some other path has already legitimately settled.
          await this.prisma.paymentOrder
            .updateMany({
              where: {
                id: order.id,
                status: { in: ['PENDING', 'AWAITING_TRANSFER'] },
              },
              data: {
                raw: {
                  needsReview: true,
                  reason: 'paytr_amount_mismatch',
                  paidKurus: totalAmount,
                  expectedKurus,
                  callback: body as object,
                },
              },
            })
            .catch((err) =>
              this.logger.error(
                `failed to persist amount-mismatch review marker for order ${order.id}: ${(err as Error)?.message}`,
              ),
            );
          // Still answer OK at the end — a non-OK only makes PayTR retry the
          // same bad amount; ops triages the flagged order instead.
        } else {
          // Replays return { settled: false, reason: 'already settled' } —
          // by design; PayTR still gets its OK below.
          await this.settlement.settleSuccess(order.id, { raw: body });
        }
      } else {
        await this.settlement.settleFailure(
          order.id,
          body.failed_reason_msg ?? body.failed_reason_code ?? 'payment failed',
          body,
        );
      }
    } catch (err) {
      // The settlement layer is idempotent but not infallible (DB hiccup).
      // Still answer OK: a non-OK makes PayTR retry up to 4× and each retry
      // re-attempts settlement — better one loud log + the recovery sweep
      // than a feedback loop with the gateway.
      this.logger.error(
        `PayTR settlement raised for order ${order.id}: ${(err as Error)?.message}`,
      );
    }

    return 'OK';
  }

  /**
   * Stripe webhook. Signature is verified over the RAW request bytes
   * (constructEvent re-computes the HMAC from the exact payload), which is
   * why main.ts mounts bodyParser.raw on this route. Three events matter:
   *
   *   checkout.session.completed   → first purchase paid; settle the order
   *   invoice.paid (cycle)         → Stripe auto-renewal; extend the period
   *   customer.subscription.deleted → stop at period end
   *
   * Everything else is acknowledged untouched so the endpoint can be
   * subscribed to broad event sets without 4xx noise in the dashboard.
   */
  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() req: Request): Promise<{ received: boolean }> {
    const webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
    if (!webhookSecret) {
      this.logger.error(
        'Stripe webhook received but STRIPE_WEBHOOK_SECRET is missing — cannot verify',
      );
      throw new ServiceUnavailableException(
        'Stripe webhook verification unavailable',
      );
    }
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      throw new BadRequestException('Missing stripe-signature header');
    }

    let event: StripeEvent;
    try {
      // req.body is the raw Buffer (see main.ts) — passing anything
      // re-serialized would never verify.
      event = this.stripeProvider
        .getClient()
        .webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      this.logger.warn(
        `Stripe webhook signature verification failed: ${(err as Error)?.message}`,
      );
      throw new BadRequestException('Stripe webhook signature mismatch');
    }

    // Settlement errors deliberately propagate (→ 500): Stripe retries with
    // backoff and the guarded settlement flip makes the retry idempotent —
    // the opposite trade-off to PayTR's always-OK contract above.
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutSessionCompleted(event);
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event);
        break;
      case 'customer.subscription.deleted':
        await this.settlement.cancelSubscriptionByProviderRef(
          event.data.object.id,
        );
        break;
      default:
        this.logger.debug(`Ignoring unhandled Stripe event ${event.type}`);
    }

    return { received: true };
  }

  private async onCheckoutSessionCompleted(
    event: CheckoutSessionCompletedEvent,
  ): Promise<void> {
    const session = event.data.object;
    const orderId =
      session.metadata?.orderId ?? session.client_reference_id ?? null;
    if (!orderId) {
      this.logger.warn(
        `checkout.session.completed ${session.id} carries no orderId — acknowledging without settling`,
      );
      return;
    }

    // Subscription-mode sessions mint a Stripe subscription. Repoint the
    // order's providerRef from the session id to the subscription id BEFORE
    // settling: settlement copies order.providerRef onto the workspace
    // subscription row, and that ref is how invoice.paid renewals and
    // subscription.deleted cancellations find their way back later.
    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription?.id ?? null);
    if (subscriptionId) {
      try {
        await this.prisma.paymentOrder.update({
          where: { id: orderId },
          data: { providerRef: subscriptionId },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2025') {
          // Order id from metadata doesn't exist here (other environment
          // sharing the webhook endpoint?) — a 500 would make Stripe retry
          // a permanently unresolvable event forever.
          this.logger.warn(
            `checkout.session.completed for unknown order ${orderId} — acknowledging without settling`,
          );
          return;
        }
        throw err; // transient DB failure: let Stripe retry
      }
    }

    await this.settlement.settleSuccess(orderId, { raw: event });
  }

  private async onInvoicePaid(event: InvoicePaidEvent): Promise<void> {
    const invoice = event.data.object as unknown as InvoiceSubscriptionCarrier;
    // The FIRST invoice of a subscription (billing_reason
    // 'subscription_create') is settled via checkout.session.completed —
    // extending here too would double-shift the period. Only true renewals.
    if (invoice.billing_reason !== 'subscription_cycle') {
      return;
    }

    const subRef =
      invoice.subscription ??
      invoice.parent?.subscription_details?.subscription ??
      null;
    const subscriptionId =
      typeof subRef === 'string' ? subRef : (subRef?.id ?? null);
    // Stripe bills the period UP FRONT: the line's period.end is the end of
    // the period this invoice just paid for — exactly the new period end.
    const periodEnd = invoice.lines?.data?.[0]?.period?.end;
    if (!subscriptionId || !periodEnd) {
      this.logger.warn(
        `invoice.paid (cycle) missing subscription or period end — skipping`,
      );
      return;
    }

    const extended = await this.settlement.extendSubscriptionByProviderRef(
      subscriptionId,
      new Date(periodEnd * 1000),
    );
    if (!extended) {
      this.logger.warn(
        `invoice.paid for ${subscriptionId} matched no workspace subscription`,
      );
    }
  }
}
