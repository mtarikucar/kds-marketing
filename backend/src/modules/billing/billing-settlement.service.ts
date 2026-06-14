import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';

const ADDON_GRANTS: Record<string, Record<string, number>> = {
  quota_boost_10: { 'limit.dailyLeadQuota': 10 },
  extra_profile: { 'limit.maxResearchProfiles': 1 },
  // Phase F P1 — AI metering boosts. The `limit.*` grants fold generically
  // into the monthly meters (entitlements.service.ts), -1 packages absorb them.
  ai_credit_boost_500: { 'limit.aiCreditsMonthly': 500 },
  messages_boost_1000: { 'limit.messagesMonthly': 1000 },
};

/**
 * The ONE place a payment outcome mutates billing state. Two-layer
 * idempotency, ported from the monorepo's checkout settlement:
 *   1. status pre-check (cheap early exit on replayed webhooks)
 *   2. guarded updateMany flip (the actual race-safe arbiter — only ONE
 *      caller wins the PENDING/AWAITING_TRANSFER → SUCCEEDED transition)
 * Success-after-failure is refused: a FAILED order stays failed; the
 * customer retries with a fresh checkout instead of resurrecting a dead one.
 */
@Injectable()
export class BillingSettlementService {
  private readonly logger = new Logger(BillingSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async settleSuccess(
    orderId: string,
    opts: { approvedById?: string; raw?: unknown } = {},
  ): Promise<{ settled: boolean; reason?: string }> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) return { settled: false, reason: 'order not found' };
    if (order.status === 'SUCCEEDED') {
      return { settled: false, reason: 'already settled' };
    }
    if (order.status === 'FAILED' || order.status === 'CANCELLED') {
      this.logger.warn(
        `refusing success-after-${order.status.toLowerCase()} for order ${order.id}`,
      );
      return { settled: false, reason: `order is ${order.status}` };
    }

    // Race-safe flip: only the caller that actually transitions the row
    // proceeds to grant entitlements.
    const flip = await this.prisma.paymentOrder.updateMany({
      where: {
        id: order.id,
        status: { in: ['PENDING', 'AWAITING_TRANSFER'] },
      },
      data: {
        status: 'SUCCEEDED',
        succeededAt: new Date(),
        approvedById: opts.approvedById ?? null,
        ...(opts.raw !== undefined ? { raw: opts.raw as object } : {}),
      },
    });
    if (flip.count === 0) {
      return { settled: false, reason: 'lost the settlement race' };
    }

    try {
      await this.grantEntitlement(order);
    } catch (e) {
      // The order IS paid — never roll the flip back. Log loudly; the
      // platform console shows succeeded-but-ungranted orders for ops, and
      // reconcileUngrantedOrders() re-grants them out of band.
      this.logger.error(
        `entitlement grant failed for paid order ${order.id}: ${(e as Error)?.message}`,
      );
    }

    this.entitlements.invalidate(order.workspaceId);
    return { settled: true };
  }

  /**
   * Dispatch a SUCCEEDED order to its grant. Extracted from settleSuccess so
   * the out-of-band reconciliation sweep can re-run the exact same grant logic
   * for an order whose grant failed after the flip. Deliberately NOT wrapped
   * in the status-flip transaction: the flip must commit even if the grant
   * later throws (the money is real), and re-granting must be possible without
   * re-flipping an already-SUCCEEDED order.
   */
  private async grantEntitlement(order: {
    type: string;
    workspaceId: string;
    packageId: string | null;
    billingCycle: string | null;
    currency: string;
    provider: string;
    providerRef: string | null;
    addOnCode: string | null;
    quantity: number;
  }) {
    if (order.type === 'ADDON') {
      await this.grantAddOn(order);
    } else {
      await this.activateSubscription(order);
    }
  }

  async settleFailure(
    orderId: string,
    reason: string,
    raw?: unknown,
  ): Promise<{ settled: boolean }> {
    const flip = await this.prisma.paymentOrder.updateMany({
      where: {
        id: orderId,
        status: { in: ['PENDING', 'AWAITING_TRANSFER'] },
      },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        failureReason: reason.slice(0, 500),
        ...(raw !== undefined ? { raw: raw as object } : {}),
      },
    });
    return { settled: flip.count > 0 };
  }

  /**
   * Out-of-band recovery sweep for SUCCEEDED orders whose entitlement grant
   * failed AFTER the status flip (settleSuccess never rolls the flip back, so
   * a transient grant failure leaves a paid-but-ungranted order). Re-grants
   * idempotently: the subscription upsert is keyed on workspaceId, so re-running
   * it is safe. ADDON is EXCLUDED — grantAddOn does an unconditional create and
   * is NOT idempotent, so an auto-sweep would double-grant the boost; addon
   * misgrants stay operator-triaged.
   *
   * Two-step lookup (no JOIN): we can't express "orders whose workspace has no
   * subscription" cleanly in one Prisma query without a relation, so load the
   * oldest SUCCEEDED subscription-family orders, then probe each workspace's
   * subscription and skip the ones that already have one. Workspaces that DO
   * have a subscription are assumed granted (the common case); the sweep only
   * spends an upsert on the genuinely-ungranted tail.
   *
   * TODO(ops): wire a scheduler to call this every ~5min AND once at boot — a
   * grant that failed during a deploy must not wait for the next manual run.
   * Intentionally not cron-wired here (no scheduler dep added to this module).
   */
  async reconcileUngrantedOrders(limit = 100): Promise<number> {
    const candidates = await this.prisma.paymentOrder.findMany({
      where: {
        status: 'SUCCEEDED',
        type: { in: ['SUBSCRIPTION', 'UPGRADE', 'RENEWAL'] },
      },
      orderBy: { succeededAt: 'asc' },
      take: limit,
    });

    let regranted = 0;
    for (const order of candidates) {
      const existing = await this.prisma.workspaceSubscription.findUnique({
        where: { workspaceId: order.workspaceId },
        select: { id: true },
      });
      if (existing) continue; // already granted — nothing to recover

      try {
        await this.grantEntitlement(order);
        this.entitlements.invalidate(order.workspaceId);
        regranted++;
        this.logger.warn(
          `reconcile: re-granted ungranted SUCCEEDED order ${order.id} (${order.type}) for workspace ${order.workspaceId}`,
        );
      } catch (e) {
        // One bad order must not abort the rest of the sweep.
        this.logger.error(
          `reconcile: re-grant failed for order ${order.id}: ${(e as Error)?.message}`,
        );
      }
    }
    return regranted;
  }

  /** New subscription, upgrade or renewal — same upsert. */
  private async activateSubscription(order: {
    workspaceId: string;
    packageId: string | null;
    billingCycle: string | null;
    currency: string;
    provider: string;
    providerRef: string | null;
  }) {
    if (!order.packageId) {
      throw new Error('subscription order without packageId');
    }
    const cycle = order.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const now = new Date();
    const end = new Date(now);
    if (cycle === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);

    await this.prisma.workspaceSubscription.upsert({
      where: { workspaceId: order.workspaceId },
      create: {
        workspaceId: order.workspaceId,
        packageId: order.packageId,
        status: 'ACTIVE',
        billingCycle: cycle,
        currency: order.currency,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        provider: order.provider,
        providerRef: order.providerRef,
      },
      update: {
        packageId: order.packageId,
        status: 'ACTIVE',
        billingCycle: cycle,
        currency: order.currency,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        provider: order.provider,
        providerRef: order.providerRef,
      },
    });
  }

  /** Stripe renewal (invoice.paid): extend the period it already paid for. */
  async extendSubscriptionByProviderRef(
    providerRef: string,
    newPeriodEnd: Date,
  ): Promise<boolean> {
    const sub = await this.prisma.workspaceSubscription.findFirst({
      where: { providerRef },
      select: { id: true, workspaceId: true, currentPeriodEnd: true },
    });
    if (!sub) return false;
    // Clamp stale/out-of-order renewals: Stripe can re-deliver invoice.paid,
    // and webhook retries aren't ordered. A period end that's not strictly
    // after the current one would either no-op or, worse, SHORTEN the paid
    // period (and shift currentPeriodStart backwards onto an already-past
    // end). Treat it as an idempotent replay — ack without mutating.
    if (newPeriodEnd <= sub.currentPeriodEnd) {
      this.logger.warn(
        `ignoring stale renewal for subscription ${sub.id}: new period end ${newPeriodEnd.toISOString()} <= current ${sub.currentPeriodEnd.toISOString()}`,
      );
      return true;
    }
    await this.prisma.workspaceSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: sub.currentPeriodEnd,
        currentPeriodEnd: newPeriodEnd,
      },
    });
    this.entitlements.invalidate(sub.workspaceId);
    return true;
  }

  /** Stripe customer.subscription.deleted → stop at period end. */
  async cancelSubscriptionByProviderRef(providerRef: string): Promise<boolean> {
    const sub = await this.prisma.workspaceSubscription.findFirst({
      where: { providerRef },
      select: { id: true, workspaceId: true },
    });
    if (!sub) return false;
    await this.prisma.workspaceSubscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true },
    });
    this.entitlements.invalidate(sub.workspaceId);
    return true;
  }

  private async grantAddOn(order: {
    workspaceId: string;
    addOnCode: string | null;
    quantity: number;
  }) {
    const code = order.addOnCode ?? '';
    const grants = ADDON_GRANTS[code];
    if (!grants) throw new Error(`unknown add-on code: ${code}`);

    // Add-on boosts ride the subscription's billing period: they expire
    // with the current period and renew with it (kept simple — one period
    // at a time; renewals re-buy the boost).
    const sub = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId: order.workspaceId },
      select: { currentPeriodEnd: true },
    });

    await this.prisma.workspaceAddOn.create({
      data: {
        workspaceId: order.workspaceId,
        code,
        quantity: order.quantity,
        grants,
        status: 'ACTIVE',
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      },
    });
  }
}

export { ADDON_GRANTS };
