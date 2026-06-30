import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Feature flags a package can grant. MUST stay in lockstep with:
 *   - every Package row's `features` JSON keys (seed-packages.ts)
 *   - the @RequiresFeature() call sites
 * The drift tripwire (entitlements.tripwire.spec.ts) snapshot-pins this
 * array — same pattern as the monorepo's FEATURE_COLUMNS belt.
 */
export const FEATURE_KEYS = [
  'autoAssign',
  'telephony',
  'installations',
  'commissions',
  'advancedReports',
  'apiAccess',
  // GoHighLevel-class capabilities (P1+). Each is a sellable feature gate.
  'conversationAi',
  'workflows',
  'campaigns',
  'funnels',
  'reviews',
  'askAi',
  'agentStudio',
  'voiceAi',
  'invoicing',
  // AI Social Content Studio — gates media generation endpoints.
  'mediaGen',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Numeric entitlement limits beyond the three legacy columns. Stored in
 * Package.limits JSON; add-on grants fold in generically (`limit.<key>`).
 * -1 = unlimited. Tripwire-pinned against seed-packages.ts `limits` blocks.
 */
export const LIMIT_KEYS = [
  'aiCreditsMonthly',
  'messagesMonthly',
  'maxAgents',
  'maxWorkflows',
  'maxFunnels',
  'maxKnowledgeDocs',
  'maxCalendars',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export interface EffectiveEntitlements {
  workspaceId: string;
  packageCode: string | null;
  subscriptionStatus: string | null;
  dailyLeadQuota: number; // -1 = unlimited
  maxUsers: number;
  maxResearchProfiles: number;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, number>;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

function zeroLimits(): Record<LimitKey, number> {
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])) as Record<LimitKey, number>;
}

/** No (live) subscription → the floor: login works, nothing else moves. */
function zeroEntitlements(workspaceId: string, status: string | null): EffectiveEntitlements {
  return {
    workspaceId,
    packageCode: null,
    subscriptionStatus: status,
    dailyLeadQuota: 0,
    maxUsers: 1,
    maxResearchProfiles: 0,
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])) as Record<
      FeatureKey,
      boolean
    >,
    limits: zeroLimits(),
    trialEndsAt: null,
    currentPeriodEnd: null,
  };
}

const CACHE_TTL_MS = 30_000;

/**
 * Folds package + active add-ons into one effective entitlement object —
 * the single source every gate reads (lead quota, seat/profile limits,
 * feature guards). Slim port of the monorepo's entitlement engine:
 * in-process 30s cache, explicit invalidation on billing mutations.
 *
 * Status semantics:
 *   TRIALING (trialEndsAt in the future) / ACTIVE → full entitlements
 *   TRIALING past its end → zero (read-side belt; the scheduler flips the
 *     row to EXPIRED on its next tick)
 *   PAST_DUE → full entitlements (grace window; scheduler expires after 7d)
 *   CANCELLED / EXPIRED / missing → zero
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);
  private readonly cache = new Map<
    string,
    { value: EffectiveEntitlements; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  async getEffective(workspaceId: string): Promise<EffectiveEntitlements> {
    const cached = this.cache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = await this.compute(workspaceId);
    this.cache.set(workspaceId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private async compute(workspaceId: string): Promise<EffectiveEntitlements> {
    const sub = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
    });
    if (!sub) return zeroEntitlements(workspaceId, null);

    const now = new Date();
    const live =
      sub.status === 'ACTIVE' ||
      sub.status === 'PAST_DUE' ||
      (sub.status === 'TRIALING' && sub.trialEndsAt !== null && sub.trialEndsAt > now);
    if (!live) return zeroEntitlements(workspaceId, sub.status);

    const pkg = await this.prisma.package.findUnique({
      where: { id: sub.packageId },
    });
    if (!pkg) {
      this.logger.error(
        `subscription ${sub.id} points at missing package ${sub.packageId}`,
      );
      return zeroEntitlements(workspaceId, sub.status);
    }

    const features = Object.fromEntries(
      FEATURE_KEYS.map((k) => [
        k,
        Boolean((pkg.features as Record<string, unknown>)?.[k]),
      ]),
    ) as Record<FeatureKey, boolean>;

    let dailyLeadQuota = pkg.dailyLeadQuota;
    let maxUsers = pkg.maxUsers;
    let maxResearchProfiles = pkg.maxResearchProfiles;

    // Package.limits JSON seeds the LIMIT_KEYS record (missing key → 0).
    const pkgLimits = (pkg.limits ?? {}) as Record<string, unknown>;
    const limits = Object.fromEntries(
      LIMIT_KEYS.map((k) => {
        const v = pkgLimits[k];
        return [k, typeof v === 'number' ? v : 0];
      }),
    ) as Record<LimitKey, number>;

    const addons = await this.prisma.workspaceAddOn.findMany({
      where: {
        workspaceId,
        status: 'ACTIVE',
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
      },
      select: { grants: true, quantity: true },
    });

    for (const addon of addons) {
      const grants = (addon.grants ?? {}) as Record<string, unknown>;
      for (const [key, rawValue] of Object.entries(grants)) {
        if (key.startsWith('limit.')) {
          const delta = Number(rawValue) * addon.quantity;
          if (!Number.isFinite(delta)) continue;
          const limitKey = key.slice('limit.'.length);
          // -1 (unlimited) absorbs additions.
          if (limitKey === 'dailyLeadQuota' && dailyLeadQuota !== -1)
            dailyLeadQuota += delta;
          else if (limitKey === 'maxUsers' && maxUsers !== -1) maxUsers += delta;
          else if (limitKey === 'maxResearchProfiles' && maxResearchProfiles !== -1)
            maxResearchProfiles += delta;
          else if ((LIMIT_KEYS as readonly string[]).includes(limitKey)) {
            const lk = limitKey as LimitKey;
            if (limits[lk] !== -1) limits[lk] += delta;
          }
        } else if (key.startsWith('feature.')) {
          const featureKey = key.slice('feature.'.length) as FeatureKey;
          if ((FEATURE_KEYS as readonly string[]).includes(featureKey) && rawValue) {
            features[featureKey] = true;
          }
        }
      }
    }

    return {
      workspaceId,
      packageCode: pkg.code,
      subscriptionStatus: sub.status,
      dailyLeadQuota,
      maxUsers,
      maxResearchProfiles,
      features,
      limits,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }
}
