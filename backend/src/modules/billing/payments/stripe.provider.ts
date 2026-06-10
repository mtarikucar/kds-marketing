import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentOrder, Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BillingPaymentProvider,
  CheckoutContext,
  CheckoutHandle,
} from './payment-provider.port';

/**
 * Stripe Checkout adapter — the USD path. Subscription-shaped orders
 * (SUBSCRIPTION / UPGRADE / RENEWAL) open a `mode: 'subscription'` session
 * so Stripe owns the renewal billing; ADDON is a one-off
 * `mode: 'payment'` charge that rides the workspace's current period.
 *
 * Prices live in OUR database (PaymentOrder.amount), so sessions use
 * inline `price_data` instead of pre-provisioned Stripe Price objects —
 * no dashboard catalog to keep in sync with the packages table.
 */

// stripe-node v19+ stopped re-exporting the resource-type namespace from the
// package root (`Stripe.Checkout.Session` no longer resolves) — derive what
// we need from the instance type instead, which survives SDK upgrades.
type StripeClient = Stripe.Stripe;
type CheckoutSession = Awaited<
  ReturnType<StripeClient['checkout']['sessions']['create']>
>;

/** Decimal-safe USD → cents (Stripe wants minor units as an integer). */
function amountToCents(amount: number | string | Prisma.Decimal): number {
  const decimal = new Prisma.Decimal(amount);
  if (decimal.isNegative()) {
    throw new Error('Stripe amount must be non-negative');
  }
  return decimal
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** What the customer sees as the line item on Stripe's hosted page. */
function describeOrder(order: PaymentOrder): string {
  return order.type === 'ADDON'
    ? `Add-on: ${order.addOnCode ?? 'addon'}`
    : `Subscription (${order.billingCycle ?? 'MONTHLY'})`;
}

@Injectable()
export class StripeProvider implements BillingPaymentProvider {
  readonly id = 'stripe' as const;
  private readonly logger = new Logger(StripeProvider.name);

  // Lazy so a deploy without Stripe credentials boots cleanly: the SDK is
  // only instantiated on the first call that actually needs it (checkout
  // or webhook verification), never at module init.
  private stripeClient: StripeClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('STRIPE_SECRET_KEY') &&
        this.configService.get<string>('STRIPE_WEBHOOK_SECRET'),
    );
  }

  supports(currency: string): boolean {
    return currency === 'USD';
  }

  /**
   * Shared lazy client — the webhooks controller uses it too (for
   * `webhooks.constructEvent`), so there is exactly one place that decides
   * how the SDK is constructed.
   */
  getClient(): StripeClient {
    if (!this.stripeClient) {
      const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
      if (!secretKey) {
        throw new ServiceUnavailableException('Stripe is not configured');
      }
      this.stripeClient = new Stripe(secretKey);
    }
    return this.stripeClient;
  }

  async createCheckout(
    order: PaymentOrder,
    ctx: CheckoutContext,
  ): Promise<CheckoutHandle> {
    // BillingService already gates on isConfigured(); re-check so a direct
    // caller can never half-start a checkout with missing credentials.
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('Stripe is not configured');
    }
    const stripe = this.getClient();

    // RENEWAL/UPGRADE open a fresh Stripe subscription, same as a new
    // SUBSCRIPTION — settlement upserts the one workspace subscription row
    // either way. Only ADDON is a one-shot charge.
    const isRecurring = order.type !== 'ADDON';

    let session: CheckoutSession;
    try {
      session = await stripe.checkout.sessions.create({
        mode: isRecurring ? 'subscription' : 'payment',
        client_reference_id: order.id,
        customer_email: ctx.buyerEmail,
        // metadata is how the webhook finds its way back to OUR order —
        // checkout.session.completed carries it verbatim.
        metadata: { orderId: order.id, workspaceId: order.workspaceId },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              product_data: { name: describeOrder(order) },
              unit_amount: amountToCents(order.amount),
              ...(isRecurring
                ? {
                    recurring: {
                      interval:
                        order.billingCycle === 'YEARLY' ? 'year' : 'month',
                    },
                  }
                : {}),
            },
          },
        ],
        success_url: `${ctx.returnUrl}?checkout=success`,
        cancel_url: `${ctx.returnUrl}?checkout=cancelled`,
      });
    } catch (err) {
      this.logger.error(
        `Stripe session create failed for order ${order.id}: ${(err as Error)?.message}`,
      );
      throw new ServiceUnavailableException(
        (err as Error)?.message ?? 'Stripe rejected the checkout session',
      );
    }

    // Session id is only minted by Stripe, so unlike PayTR this write can't
    // happen pre-call. The webhook resolves orders via metadata.orderId, not
    // providerRef, so a crash right here cannot orphan the payment; the ref
    // is persisted for audits and the platform console.
    await this.prisma.paymentOrder.update({
      where: { id: order.id },
      data: { providerRef: session.id },
    });

    if (!session.url) {
      // Embedded-UI sessions have no URL — we always create hosted ones, so
      // a missing URL means Stripe changed behaviour under us. Fail loud.
      throw new ServiceUnavailableException(
        'Stripe did not return a redirect URL',
      );
    }
    return { kind: 'redirect', url: session.url };
  }
}
