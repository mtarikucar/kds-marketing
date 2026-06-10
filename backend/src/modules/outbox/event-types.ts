// Versioned domain-event names. Centralising them here prevents typos at the
// emit / subscribe boundary and gives us one place to track schema versions.
// New events are added as `.v1`; non-backwards-compatible payload changes
// MUST bump the version (e.g. `.v2`) so consumers can stay on the old shape
// until they migrate. Producers MAY emit multiple versions in parallel during
// a migration; the worker delivers each verbatim.

export const EventTypes = {
  // Subscription lifecycle — projector listens for these to refresh entitlements.
  SubscriptionActivated: "subscription.activated.v1",
  SubscriptionUpgraded: "subscription.upgraded.v1",
  SubscriptionDowngraded: "subscription.downgraded.v1",
  SubscriptionCancelled: "subscription.cancelled.v1",
  SubscriptionPaymentFailed: "subscription.payment_failed.v1",
  SubscriptionRenewalFailed: "subscription.renewal.failed.v1",
  SubscriptionUpgradeRequested: "subscription.upgrade.requested.v1",

  // Operational overrides set by super-admin.
  TenantOverridesChanged: "tenant.overrides_changed.v1",

  // Add-on lifecycle (marketplace).
  AddOnPurchased: "addon.purchased.v1",
  AddOnCancelled: "addon.cancelled.v1",

  // Entitlement-side fact: emitted by the projector AFTER it writes new rows.
  FeatureEntitlementChanged: "feature.entitlement.changed.v1",

  // Checkout (mixed cart provisioning).
  CheckoutCompleted: "checkout.completed.v1",

  // Order lifecycle — driven by orders.service, consumed by the POS routing screen.
  OrderCreated: "order.created.v1",
  OrderUpdated: "order.updated.v1",
  OrderCompleted: "order.completed.v1",
  OrderCancelled: "order.cancelled.v1",

  // Payment provider facade signals.
  PaymentIntentCreated: "payment.intent_created.v1",
  PaymentRefundCompleted: "payment.refund_completed.v1",
  // Settlement fact — emitted by PayTR settlement on payment success. The
  // marketing context consumes it to credit SIGNUP/RENEWAL/UPSELL commissions
  // (see SettlementCommissionConsumer); kept core-owned and self-contained so
  // non-marketing consumers can subscribe without coupling to marketing.
  PaymentSucceeded: "payment.succeeded.v1",

  // Device mesh + local-bridge provisioning.
  BridgeProvisioned: "bridge.provisioned.v1",
  DeviceSlotCreated: "device.slot_created.v1",
  DevicePaired: "device.paired.v1",
  DeviceCommandCreated: "device.command.created.v1",

  // Fulfillment lifecycle (installations, warranty, shipping).
  InstallationRequested: "installation.requested.v1",
  InstallationScheduled: "installation.scheduled.v1",
  InstallationCompleted: "installation.completed.v1",
  InstallationCancelled: "installation.cancelled.v1",
  WarrantyCreated: "warranty.created.v1",
  WarrantyClaimFiled: "warranty.claim.filed.v1",
  HardwareOrderPlaced: "hardware.order.placed.v1",
  HardwareOrderShipped: "hardware.order.shipped.v1",
  HardwareOrderDelivered: "hardware.order.delivered.v1",

  // Fiscal / e-Fatura.
  FiscalReceiptFailed: "fiscal.receipt.failed.v1",
  FiscalDayClosed: "fiscal.day.closed.v1",

  // Integration gateway (delivery platforms, payments, etc.).
  IntegrationConnected: "integration.connected.v1",
  IntegrationDisconnected: "integration.disconnected.v1",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// Stable Set view of known event-type strings, used by `OutboxService.append`
// to emit a warning when a producer passes a type that isn't registered —
// catches typos at the boundary without breaking dynamically-named events
// (the integration-gateway emits `integration.webhook.<providerId>.received.v1`
// where <providerId> is runtime, so blanket-rejecting unknowns would block
// it; we log + accept instead).
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventTypes),
);

/**
 * Some event-type families are dynamically named at runtime (the prefix is
 * stable but the suffix is data-derived). They're allowlisted so the
 * unknown-type warning doesn't fire for every webhook ingest.
 */
const DYNAMIC_EVENT_TYPE_PREFIXES: readonly string[] = [
  "integration.webhook.", // integration.webhook.<provider>.received.v1
  // Marketing bounded context owns its own event registry
  // (marketing/events/marketing-event-types.ts). Allowlisted here so the
  // unregistered-type warning doesn't fire for marketing's own producers;
  // the canonical names still live with the marketing service for the split.
  "marketing.",
];

export function isKnownEventType(type: string): boolean {
  if (KNOWN_EVENT_TYPES.has(type)) return true;
  return DYNAMIC_EVENT_TYPE_PREFIXES.some((p) => type.startsWith(p));
}

// Minimal payload contracts — Zod schemas land in packages/event-contracts
// when the monorepo split happens. Until then, this is the single source of
// truth for producer/consumer agreement.

export interface SubscriptionLifecyclePayload {
  tenantId: string;
  subscriptionId: string;
  planCode?: string; // PRO, BUSINESS, ...
  periodStart?: string;
  periodEnd?: string;
}

export interface TenantOverridesChangedPayload {
  tenantId: string;
  // Just a signal that overrides changed — the projector re-reads from DB to
  // pick up the new state, so the event itself doesn't need to carry the
  // whole payload. Keeps the contract tiny and avoids stale data races.
}

export interface AddOnLifecyclePayload {
  tenantId: string;
  addOnId: string;
  addOnCode: string;
  branchId?: string | null;
}

/**
 * v2.8.86 — emitted by CheckoutService once a HardwareOrder has been
 * minted (mixed-cart or hardware-only checkout). The consumer
 * (CheckoutNotificationsService) reads it to send the order-placed
 * email — payload is intentionally minimal so the consumer always
 * re-reads order/tenant rows at send time. Keeping it tiny means a
 * schema bump on HardwareOrder doesn't force an event-version bump
 * here.
 */
export interface HardwareOrderPlacedPayload {
  tenantId: string;
  hardwareOrderId: string;
  totalCents: number;
  currency: string;
  paymentRef: string | null;
}

/**
 * Emitted by PayTR settlement inside the settlement transaction once a payment
 * transitions PENDING → SUCCEEDED. Carries everything the marketing commission
 * consumer needs so it never has to read core payment/subscription rows. The
 * `kind` discriminator routes the consumer to the SIGNUP | RENEWAL | UPSELL
 * branch. `referral*` fields are populated only for self-serve referral
 * signups (snapshotted on the payment row at checkout).
 *
 * Idempotency: producers MUST pass `payment-succeeded:{paymentId}` so a
 * webhook retry + recovery sweeper settling the same payment yield one event.
 */
export interface PaymentSucceededPayload {
  tenantId: string;
  /** Carried so the marketing consumer can name an auto-created self-serve lead without reading the tenant row. */
  tenantName: string;
  subscriptionId: string;
  paymentId: string;
  kind: "signup" | "renewal" | "upsell";
  amount: number;
  currency: string;
  planId: string;
  planCode: string;
  /** Per-plan commission rate snapshot (defaulted by the producer when absent). */
  commissionRate: number;
  referralCode: string | null;
  referredByMarketingUserId: string | null;
  occurredAt: string; // ISO-8601
}
