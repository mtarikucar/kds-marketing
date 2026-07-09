import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { withAdvisoryLock } from '../../common/scheduling/advisory-lock';
import {
  EntitlementsService,
  DEFAULT_ACTIVATED_MODULES,
} from './entitlements.service';
import { GrowthWalletService } from '../marketing/wallet/growth-wallet.service';

const ADDON_GRANTS: Record<string, Record<string, number>> = {
  quota_boost_10: { 'limit.dailyLeadQuota': 10 },
  extra_profile: { 'limit.maxResearchProfiles': 1 },
  // Phase F P1 — AI metering boosts. The `limit.*` grants fold generically
  // into the monthly meters (entitlements.service.ts), -1 packages absorb them.
  ai_credit_boost_500: { 'limit.aiCreditsMonthly': 500 },
  messages_boost_1000: { 'limit.messagesMonthly': 1000 },
  // NetGSM SMS v2 Task 12 — `feature.*` grants OR onto the package's feature
  // map (entitlements.service.ts) regardless of any workspace module
  // customization (`smsOtp` is deliberately excluded from
  // TOGGLEABLE_MODULE_KEYS — see entitlements.service.ts).
  sms_otp_package: { 'feature.smsOtp': 1 },
  // NetGSM Phase 5 Task 1 — unlike smsOtp, `voiceCampaigns` IS a toggleable
  // module (TOGGLEABLE_MODULE_KEYS does NOT exclude it, since SCALE/OPERATOR
  // grant it via the plan already) — this add-on just ALSO ORs it on for
  // lower tiers, same `feature.*` mechanism.
  voice_campaigns_package: { 'feature.voiceCampaigns': 1 },
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
export class BillingSettlementService implements OnModuleInit {
  private readonly logger = new Logger(BillingSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly growthWallet: GrowthWalletService,
  ) {}

  /**
   * Recover any order that SUCCEEDED but whose entitlement grant failed (e.g. a
   * crash/deploy mid-settlement) — at boot AND every 5 min. Without this, a
   * paying customer can stay un-provisioned indefinitely. Advisory-locked so
   * only one replica sweeps; the boot run closes the gap a deploy opens.
   */
  onModuleInit(): void {
    void this.reconcileSweep().catch((e) =>
      this.logger.error(`boot reconcile failed: ${(e as Error)?.message}`),
    );
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'billing-reconcile-ungranted' })
  async reconcileSweep(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'billing:reconcile-ungranted',
      async () => {
        const n = await this.reconcileUngrantedOrders();
        if (n > 0) this.logger.warn(`billing reconcile: re-granted ${n} ungranted order(s)`);
      },
      this.logger,
    );
  }

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
      await this.markGranted(order.id);
    } catch (e) {
      // The order IS paid — never roll the flip back. Log loudly; the
      // platform console shows succeeded-but-ungranted orders for ops, and
      // reconcileUngrantedOrders() re-grants them out of band. grantedAt stays
      // NULL so the sweep's window (audit A1) is guaranteed to reach this row.
      this.logger.error(
        `entitlement grant failed for paid order ${order.id}: ${(e as Error)?.message}`,
      );
    }

    this.entitlements.invalidate(order.workspaceId);
    return { settled: true };
  }

  /**
   * Stamp the grant-success marker (audit A1). updateMany (not update) so a
   * concurrently-deleted row can't throw and undo a grant that DID land; the
   * stamp itself is best-effort — a missed stamp only means one extra probe
   * on the next sweep, never a lost grant.
   */
  private async markGranted(orderId: string): Promise<void> {
    await this.prisma.paymentOrder.updateMany({
      where: { id: orderId },
      data: { grantedAt: new Date() },
    });
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
    id: string;
    type: string;
    workspaceId: string;
    packageId: string | null;
    billingCycle: string | null;
    amount: unknown;
    currency: string;
    provider: string;
    providerRef: string | null;
    addOnCode: string | null;
    quantity: number;
  }) {
    if (order.type === 'WALLET_TOPUP') {
      // Growth Autopilot spec D2: a paid top-up credits the growth wallet.
      // Idempotent by the ledger's unique ref, so webhook replays and the
      // reconcile sweep can safely re-run this grant.
      await this.growthWallet.credit(order.workspaceId, {
        amount: order.amount as number,
        kind: 'TOPUP',
        ref: `order:${order.id}`,
        currency: order.currency,
      });
    } else if (order.type === 'ADDON') {
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
   * Driven by reconcileSweep() — @Cron every 5 min + a boot run (onModuleInit),
   * advisory-locked for single-replica safety.
   */
  async reconcileUngrantedOrders(limit = 100): Promise<number> {
    // grantedAt: null is the window fix (audit A1): without it the blind
    // `take: limit` window pinned to the oldest-`limit` SUCCEEDED orders —
    // all long-granted in steady state — and a recent failed grant was never
    // re-examined. Filtering on the marker keeps the window on genuinely
    // ungranted rows, so it always advances.
    const candidates = await this.prisma.paymentOrder.findMany({
      where: {
        status: 'SUCCEEDED',
        grantedAt: null,
        type: { in: ['SUBSCRIPTION', 'UPGRADE', 'RENEWAL'] },
      },
      orderBy: { succeededAt: 'asc' },
      take: limit,
    });

    let regranted = 0;
    for (const order of candidates) {
      const existing = await this.prisma.workspaceSubscription.findUnique({
        where: { workspaceId: order.workspaceId },
        select: { packageId: true, status: true, currentPeriodEnd: true },
      });
      // Only treat as already-granted when the live subscription actually
      // reflects THIS paid order — same package, ACTIVE, and a period still
      // open. A mere row EXISTING is NOT enough: the universal trial→paid
      // upgrade always has a TRIALING row (or a different package) sitting
      // there, and short-circuiting on its presence defeated recovery — the
      // paid grant never landed and the customer stayed on trial entitlements.
      // Otherwise fall through and (re-)grant; activateSubscription is an
      // idempotent upsert on workspaceId, so re-running it is safe.
      const alreadyGranted =
        existing != null &&
        existing.packageId === order.packageId &&
        existing.status === 'ACTIVE' &&
        existing.currentPeriodEnd > new Date();
      if (alreadyGranted) {
        // Stamp it so it leaves the window instead of being re-probed on every
        // sweep forever.
        await this.markGranted(order.id);
        continue;
      }

      try {
        await this.grantEntitlement(order);
        await this.markGranted(order.id);
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

    // WALLET_TOPUP recovery (Growth Autopilot spec D2): a paid top-up whose
    // wallet credit failed after the flip has NO ledger entry under its
    // order ref — re-credit it. Safe to auto-sweep (unlike ADDON) because the
    // credit is idempotent by the unique ref.
    const topups = await this.prisma.paymentOrder.findMany({
      where: { status: 'SUCCEEDED', grantedAt: null, type: 'WALLET_TOPUP' },
      orderBy: { succeededAt: 'asc' },
      take: limit,
    });
    for (const order of topups) {
      const landed = await this.prisma.growthWalletLedgerEntry.findUnique({
        where: { ref: `order:${order.id}` },
        select: { id: true },
      });
      if (landed) {
        await this.markGranted(order.id); // credit already applied — evict from the window
        continue;
      }

      try {
        await this.grantEntitlement(order);
        await this.markGranted(order.id);
        this.entitlements.invalidate(order.workspaceId);
        regranted++;
        this.logger.warn(
          `reconcile: re-credited uncredited SUCCEEDED top-up ${order.id} for workspace ${order.workspaceId}`,
        );
      } catch (e) {
        this.logger.error(
          `reconcile: top-up re-credit failed for order ${order.id}: ${(e as Error)?.message}`,
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

    // A purchased feature must be ON by default. Workspaces that never
    // customised their module list keep activatedModules = null (all entitled
    // modules active) and need nothing. But once a workspace has an explicit
    // allow-list, that list is exhaustive — a module the NEW package now
    // entitles would stay dark until manually toggled on. Union the newly
    // entitled default-ON modules into the allow-list so the upgrade lands hot.
    await this.activateEntitledModules(order.workspaceId, order.packageId);
  }

  /**
   * Turn ON any default-activated module the (new) package entitles for a
   * workspace whose `activatedModules` is an explicit allow-list. Mirrors a
   * fresh workspace's DEFAULT_ACTIVATED_MODULES (memberships/research stay
   * user-controlled — hidden by default even when entitled). Workspaces with
   * `activatedModules = null` are all-active and left untouched.
   */
  private async activateEntitledModules(
    workspaceId: string,
    packageId: string,
  ): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { activatedModules: true },
    });
    // null/absent = every entitled module already active — nothing to widen.
    if (!Array.isArray(workspace?.activatedModules)) return;
    const activated = (workspace!.activatedModules as unknown[]).filter(
      (m): m is string => typeof m === 'string',
    );

    const pkg = await this.prisma.package.findUnique({
      where: { id: packageId },
      select: { features: true },
    });
    const features = (pkg?.features ?? {}) as Record<string, unknown>;
    const toAdd = DEFAULT_ACTIVATED_MODULES.filter(
      (k) => Boolean(features[k]) && !activated.includes(k),
    );
    if (toAdd.length === 0) return;

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { activatedModules: [...activated, ...toAdd] },
    });
    this.entitlements.invalidate(workspaceId);
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
