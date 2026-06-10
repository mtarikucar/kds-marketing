import { PaymentOrder } from '@prisma/client';

/** What the SPA renders after checkout: an embedded iframe (PayTR), a
 * redirect (Stripe Checkout), or bank-transfer instructions (manual). */
export type CheckoutHandle =
  | { kind: 'iframe'; token: string; iframeUrl: string }
  | { kind: 'redirect'; url: string }
  | {
      kind: 'bank_transfer';
      instructions: {
        iban: string;
        accountName: string;
        amountFormatted: string;
        reference: string;
      };
    };

export interface CheckoutContext {
  buyerEmail: string;
  buyerIp: string;
  /** Where the provider should land the user after pay/cancel. */
  returnUrl: string;
}

/**
 * One adapter per payment path. Providers ONLY initiate checkout — webhook
 * verification lives in the webhooks controller and settlement (the
 * subscription flip) is shared in BillingSettlementService, so a provider
 * can never invent its own activation semantics.
 */
export interface BillingPaymentProvider {
  readonly id: 'paytr' | 'stripe' | 'manual';
  /** False when the deploy lacks this provider's credentials. */
  isConfigured(): boolean;
  /** Currencies this provider can charge. */
  supports(currency: string): boolean;
  createCheckout(
    order: PaymentOrder,
    ctx: CheckoutContext,
  ): Promise<CheckoutHandle>;
}

export const BILLING_PAYMENT_PROVIDERS = Symbol('BILLING_PAYMENT_PROVIDERS');
