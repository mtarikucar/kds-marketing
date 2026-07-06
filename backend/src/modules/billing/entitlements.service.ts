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
  // AI Social Content Studio — Social Campaign engine (Milestone 3).
  'socialCampaigns',
  // Optional modules hidden by default for NEW workspaces (nav-gating only, no
  // API gate) — a leaner first-run; power users switch them on in Modules.
  'memberships',
  'research',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Feature keys that map to a user-facing MODULE a workspace can toggle on/off for
 * progressive disclosure (via Workspace.activatedModules). `autoAssign` is
 * background behaviour, not a surfaced module, so it is never toggled off here.
 */
export const TOGGLEABLE_MODULE_KEYS: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => k !== 'autoAssign',
);

/**
 * New-workspace default `activatedModules`: every toggleable module active
 * EXCEPT the ones hidden by default for a leaner first-run (memberships +
 * research). Existing workspaces keep `activatedModules = null` (all-active),
 * so this only affects freshly-created workspaces; the two hidden modules stay
 * entitled and can be switched on in Modules settings.
 */
export const DEFAULT_ACTIVATED_MODULES: FeatureKey[] = TOGGLEABLE_MODULE_KEYS.filter(
  (k) => k !== 'memberships' && k !== 'research',
);

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
  /** Toggleable modules the plan/add-ons entitle, BEFORE per-workspace activation
   *  is applied — lets the catalog tell "not in plan" from "deactivated". */
  entitledModules: FeatureKey[];
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
    entitledModules: [],
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
          const raw = Number(rawValue);
          if (!Number.isFinite(raw)) continue;
          // -1 is the universal "unlimited" sentinel, so a grant of -1 (an
          // "unlimited X" add-on) UNLOCKS the limit — it must NOT be folded in as
          // an additive delta (which would subtract `quantity` from the base).
          // `apply(base)` either keeps an already-unlimited base, sets unlimited
          // on a -1 grant, or otherwise adds `raw × quantity`.
          const unlimitedGrant = raw === -1;
          const delta = raw * addon.quantity;
          const apply = (base: number): number =>
            base === -1 ? -1 : unlimitedGrant ? -1 : base + delta;
          const limitKey = key.slice('limit.'.length);
          if (limitKey === 'dailyLeadQuota') dailyLeadQuota = apply(dailyLeadQuota);
          else if (limitKey === 'maxUsers') maxUsers = apply(maxUsers);
          else if (limitKey === 'maxResearchProfiles')
            maxResearchProfiles = apply(maxResearchProfiles);
          else if ((LIMIT_KEYS as readonly string[]).includes(limitKey)) {
            const lk = limitKey as LimitKey;
            limits[lk] = apply(limits[lk]);
          }
        } else if (key.startsWith('feature.')) {
          const featureKey = key.slice('feature.'.length) as FeatureKey;
          if ((FEATURE_KEYS as readonly string[]).includes(featureKey) && rawValue) {
            features[featureKey] = true;
          }
        }
      }
    }

    // Toggleable modules the plan/add-ons entitle, captured BEFORE activation.
    const entitledModules = TOGGLEABLE_MODULE_KEYS.filter((k) => features[k]);

    // Progressive-disclosure module activation. If the workspace has an explicit
    // allow-list, a toggleable module stays active only when it's BOTH entitled
    // and activated. NULL/absent = every entitled module active (back-compat, so
    // existing tenants are unaffected). This gates BOTH the API FeatureGuard and
    // the SPA nav, since both read this one features map.
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { activatedModules: true },
    });
    const activated = Array.isArray(workspace?.activatedModules)
      ? (workspace!.activatedModules as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        )
      : null;
    if (activated) {
      for (const k of TOGGLEABLE_MODULE_KEYS) {
        if (!activated.includes(k)) features[k] = false;
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
      entitledModules,
      limits,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }
}
