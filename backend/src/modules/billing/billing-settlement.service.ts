import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';

const ADDON_GRANTS: Record<string, Record<string, number>> = {
  quota_boost_10: { 'limit.dailyLeadQuota': 10 },
  extra_profile: { 'limit.maxResearchProfiles': 1 },
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
      if (order.type === 'ADDON') {
        await this.grantAddOn(order);
      } else {
        await this.activateSubscription(order);
      }
    } catch (e) {
      // The order IS paid — never roll the flip back. Log loudly; the
      // platform console shows succeeded-but-ungranted orders for ops.
      this.logger.error(
        `entitlement grant failed for paid order ${order.id}: ${(e as Error)?.message}`,
      );
    }

    this.entitlements.invalidate(order.workspaceId);
    return { settled: true };
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
