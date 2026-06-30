import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from './agency.service';
import { AI_CREDITS_METRIC } from '../ai/ai-credits.service';
import { MESSAGES_METRIC } from '../channels/message-quota.service';

/**
 * Epic D1 — agency REBILLING / SaaS-mode (GoHighLevel "agency charges sub-account"
 * parity).
 *
 * An AGENCY runs child LOCATION sub-accounts (the D1 hierarchy). This service lets the
 * agency define a per-location SaaS plan (a flat monthly fee + a markup on the
 * location's REAL metered usage) and settle a monthly charge against it. It is the
 * agency-level SETTLEMENT ledger — a separate, ADDITIVE module that NEVER touches the
 * existing end-customer billing flow (packages / payment_orders / workspace_subscriptions
 * / invoices / workspace_psp_configs / StripeProvider / InvoicesService).
 *
 * Authorization model (mirrors the rest of the agency surface):
 *  - every reference to a child location funnels through
 *    {@link AgencyService.assertAgencyOwns}(agency, location), which 404s a
 *    foreign/missing location — so an agency can only ever plan/charge its OWN
 *    children, and cross-agency access is indistinguishable from non-existent.
 *
 * Metering reads REAL usage from the SAME source the product already meters into —
 * the `UsageCounter` table (`ai.credits` + `messages.sent`, monthly YYYY-MM keys
 * written by AiCreditsService / MessageQuotaService). We do NOT invent usage numbers;
 * computeCharge sums those counters over the months the billing window spans.
 *
 * Money is Decimal(10,2) TRY — identical semantics to packages/invoices. computeCharge
 * is PURE internal math (no external calls). The outbound charge
 * ({@link chargeViaStripeConnect}) is ENV-GATED on STRIPE_CONNECT_CLIENT_ID +
 * STRIPE_SECRET_KEY and is a no-op-but-clean when unset (the charge stays DRAFT).
 */

/** Usage metrics rebilling settles against — the REAL meters the product writes. */
export const REBILLED_USAGE_METRICS = [AI_CREDITS_METRIC, MESSAGES_METRIC] as const;

export interface UpsertPlanInput {
  basePrice: number | string;
  usageUnitPrice: number | string;
  markupPercent: number | string;
  enabled?: boolean;
}

const TWO_DP = 2;

/** Round a Decimal to money precision (2 dp, half-up) — the money invariant. */
function money(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(TWO_DP, Prisma.Decimal.ROUND_HALF_UP);
}

/** Snap a Date to the start of its UTC day (00:00:00.000Z) — canonical period key. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** All UTC month keys (YYYY-MM) the half-open window [start, end) touches. */
export function monthKeysInRange(start: Date, end: Date): string[] {
  if (!(start instanceof Date) || !(end instanceof Date) || isNaN(+start) || isNaN(+end)) {
    throw new BadRequestException('periodStart and periodEnd must be valid dates');
  }
  if (end <= start) {
    throw new BadRequestException('periodEnd must be after periodStart');
  }
  const keys: string[] = [];
  // Walk month-by-month in UTC from the start month up to (and including) the month
  // containing the last instant before `end`.
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based
  const lastInstant = new Date(end.getTime() - 1);
  const endY = lastInstant.getUTCFullYear();
  const endM = lastInstant.getUTCMonth();
  // Guard against an unbounded loop on absurd ranges.
  for (let guard = 0; guard < 600; guard++) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    if (y === endY && m === endM) break;
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return keys;
}

@Injectable()
export class RebillingService {
  private readonly logger = new Logger(RebillingService.name);
  private stripeClient: Stripe.Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agency: AgencyService,
    private readonly config: ConfigService,
  ) {}

  // ── Plan CRUD (one plan per child LOCATION) ───────────────────────────────────

  /**
   * Create or update the rebilling plan for a child LOCATION. assertAgencyOwns FIRST
   * (404s a foreign/missing location), then upsert by the (agency, location) natural
   * key. basePrice/usageUnitPrice/markupPercent are coerced to Decimal(10,2) — same
   * money semantics as packages/invoices.
   */
  async upsertPlan(
    agencyWorkspaceId: string,
    locationWorkspaceId: string,
    input: UpsertPlanInput,
  ) {
    await this.agency.assertAgencyOwns(agencyWorkspaceId, locationWorkspaceId);

    const basePrice = this.toMoney(input.basePrice, 'basePrice');
    const usageUnitPrice = this.toMoney(input.usageUnitPrice, 'usageUnitPrice');
    const markupPercent = this.toMoney(input.markupPercent, 'markupPercent');

    return this.prisma.rebillingPlan.upsert({
      where: {
        workspaceId_locationWorkspaceId: {
          workspaceId: agencyWorkspaceId,
          locationWorkspaceId,
        },
      },
      create: {
        workspaceId: agencyWorkspaceId,
        locationWorkspaceId,
        basePrice,
        usageUnitPrice,
        markupPercent,
        enabled: input.enabled ?? true,
      },
      update: {
        basePrice,
        usageUnitPrice,
        markupPercent,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    });
  }

  /** Every rebilling plan this agency owns (scoped to its own children). */
  async listPlans(agencyWorkspaceId: string) {
    return this.prisma.rebillingPlan.findMany({
      where: { workspaceId: agencyWorkspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The plan for one child LOCATION (404 if the location isn't this agency's). */
  async getPlan(agencyWorkspaceId: string, locationWorkspaceId: string) {
    await this.agency.assertAgencyOwns(agencyWorkspaceId, locationWorkspaceId);
    const plan = await this.prisma.rebillingPlan.findUnique({
      where: {
        workspaceId_locationWorkspaceId: {
          workspaceId: agencyWorkspaceId,
          locationWorkspaceId,
        },
      },
    });
    if (!plan) throw new NotFoundException('No rebilling plan for this location');
    return plan;
  }

  // ── Usage metering (REAL usage from UsageCounter) ─────────────────────────────

  /**
   * Sum the location's REAL metered usage over [periodStart, periodEnd). Reads the
   * SAME `UsageCounter` rows the product writes (`ai.credits` + `messages.sent`,
   * monthly YYYY-MM keys) — workspaceId-scoped to the LOCATION, for every month the
   * window touches. Returns the total raw units; the money mapping lives in
   * computeCharge so the metering stays a pure usage count.
   */
  async meterUsageUnits(
    locationWorkspaceId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const periodKeys = monthKeysInRange(periodStart, periodEnd);
    const agg = await this.prisma.usageCounter.aggregate({
      _sum: { value: true },
      where: {
        workspaceId: locationWorkspaceId,
        metric: { in: [...REBILLED_USAGE_METRICS] },
        periodKey: { in: periodKeys },
      },
    });
    return agg._sum.value ?? 0;
  }

  // ── computeCharge (pure internal math; creates a DRAFT) ───────────────────────

  /**
   * Compute and persist a DRAFT settlement line for one child LOCATION over
   * [periodStart, periodEnd):
   *   usageUnits  = REAL metered usage from UsageCounter (ai.credits + messages.sent)
   *   meteredCost = usageUnits × plan.usageUnitPrice
   *   usageAmount = meteredCost × (1 + markupPercent/100)
   *   baseAmount  = plan.basePrice
   *   totalAmount = baseAmount + usageAmount
   * Pure internal math — NO external calls. assertAgencyOwns FIRST; the plan must
   * exist and be enabled.
   */
  async computeCharge(
    agencyWorkspaceId: string,
    locationWorkspaceId: string,
    periodStartRaw: Date,
    periodEndRaw: Date,
  ) {
    await this.agency.assertAgencyOwns(agencyWorkspaceId, locationWorkspaceId);

    // Snap the period bounds to UTC-day boundaries so a re-run of the SAME logical
    // period with a slightly different time-of-day (UI vs scheduled run) dedups to
    // the same (periodStart, periodEnd) key instead of minting a second charge.
    const periodStart = startOfUtcDay(periodStartRaw);
    const periodEnd = startOfUtcDay(periodEndRaw);

    const plan = await this.prisma.rebillingPlan.findUnique({
      where: {
        workspaceId_locationWorkspaceId: {
          workspaceId: agencyWorkspaceId,
          locationWorkspaceId,
        },
      },
    });
    if (!plan) throw new NotFoundException('No rebilling plan for this location');
    if (!plan.enabled) {
      throw new BadRequestException('Rebilling plan for this location is disabled');
    }

    const usageUnits = await this.meterUsageUnits(
      locationWorkspaceId,
      periodStart,
      periodEnd,
    );

    const baseAmount = money(new Prisma.Decimal(plan.basePrice));
    const meteredCost = new Prisma.Decimal(plan.usageUnitPrice).mul(usageUnits);
    const markupFactor = new Prisma.Decimal(1).plus(
      new Prisma.Decimal(plan.markupPercent).div(100),
    );
    const usageAmount = money(meteredCost.mul(markupFactor));
    const totalAmount = money(baseAmount.plus(usageAmount));

    // Idempotent per (location, period): re-computing the same month (OWNER
    // double-click / retry / monthly re-run) must NOT mint a second charge row,
    // or settling both would bill the location's connected Stripe account twice
    // for one period. Return any existing non-FAILED charge for the period
    // instead of inserting a duplicate.
    const existing = await this.prisma.rebillCharge.findFirst({
      where: {
        workspaceId: agencyWorkspaceId,
        locationWorkspaceId,
        periodStart,
        periodEnd,
        status: { not: 'FAILED' },
      },
    });
    if (existing) return existing;

    try {
      return await this.prisma.rebillCharge.create({
        data: {
          workspaceId: agencyWorkspaceId,
          locationWorkspaceId,
          periodStart,
          periodEnd,
          baseAmount,
          usageAmount,
          totalAmount,
          usageUnits,
          status: 'DRAFT',
        },
      });
    } catch (e) {
      // Lost the true-concurrent race on the per-period partial-unique index —
      // a sibling compute already inserted the charge. Return it (no duplicate).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.rebillCharge.findFirst({
          where: { workspaceId: agencyWorkspaceId, locationWorkspaceId, periodStart, periodEnd, status: { not: 'FAILED' } },
        });
        if (row) return row;
      }
      throw e;
    }
  }

  /** Every settlement line this agency owns (optionally filtered to one location). */
  async listCharges(agencyWorkspaceId: string, locationWorkspaceId?: string) {
    return this.prisma.rebillCharge.findMany({
      where: {
        workspaceId: agencyWorkspaceId,
        ...(locationWorkspaceId ? { locationWorkspaceId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── chargeViaStripeConnect (ENV-GATED, idempotent) ────────────────────────────

  /** True only when BOTH the Connect client id AND the platform secret key are set. */
  isStripeConnectConfigured(): boolean {
    return Boolean(
      this.config.get<string>('STRIPE_CONNECT_CLIENT_ID') &&
        this.config.get<string>('STRIPE_SECRET_KEY'),
    );
  }

  /**
   * Lazy Stripe client (platform secret key) — only built when a live charge is
   * actually attempted, so a deploy without Stripe boots cleanly. Mock-friendly seam:
   * tests can stub `getStripeClient`.
   */
  getStripeClient(): Stripe.Stripe {
    if (!this.stripeClient) {
      const key = this.config.get<string>('STRIPE_SECRET_KEY');
      if (!key) throw new ServiceUnavailableException('Stripe is not configured');
      this.stripeClient = new Stripe(key);
    }
    return this.stripeClient;
  }

  /**
   * Resolve the LOCATION's connected Stripe account id from its PSP config (the same
   * per-workspace config the customer-invoicing path stores its Stripe creds in).
   * `connectAccountId` in configPublic is the Stripe Connect account the agency
   * onboarded for that location. Null when the location has no connected account —
   * in which case the live charge is treated as "not configured" (charge stays DRAFT).
   */
  private async resolveConnectedAccountId(
    locationWorkspaceId: string,
  ): Promise<string | null> {
    const psp = await this.prisma.workspacePspConfig.findUnique({
      where: { workspaceId: locationWorkspaceId },
      select: { provider: true, configPublic: true },
    });
    const pub = (psp?.configPublic ?? null) as Record<string, unknown> | null;
    const acct = pub && typeof pub.connectAccountId === 'string' ? pub.connectAccountId : null;
    return acct && acct.length > 0 ? acct : null;
  }

  /**
   * Attempt the live outbound charge for a DRAFT settlement line, on the LOCATION's
   * connected Stripe account.
   *
   * ENV-GATED + INERT when unconfigured: if STRIPE_CONNECT_CLIENT_ID / STRIPE_SECRET_KEY
   * are unset, OR the location has no connected account, this throws a clean
   * ServiceUnavailableException("rebilling not configured") and the charge STAYS DRAFT —
   * no live charge, no crash. Internal settlement (the recorded owed amount) is already
   * persisted by computeCharge regardless.
   *
   * IDEMPOTENT: a charge already INVOICED/PAID is returned unchanged (never
   * double-charged). On a live charge failure the row flips to FAILED and the Stripe
   * error is surfaced.
   */
  async chargeViaStripeConnect(agencyWorkspaceId: string, rebillChargeId: string) {
    // Scope the lookup to the agency that owns it (cross-agency → 404).
    const charge = await this.prisma.rebillCharge.findFirst({
      where: { id: rebillChargeId, workspaceId: agencyWorkspaceId },
    });
    if (!charge) throw new NotFoundException('Rebill charge not found');

    // Idempotency: never re-charge a settled line.
    if (charge.status === 'INVOICED' || charge.status === 'PAID') {
      return charge;
    }

    // ENV gate — when Connect isn't configured, stay DRAFT, clean error, no charge.
    if (!this.isStripeConnectConfigured()) {
      throw new ServiceUnavailableException({
        code: 'REBILLING_NOT_CONFIGURED',
        message: 'rebilling not configured (Stripe Connect env unset)',
      });
    }

    const connectAccountId = await this.resolveConnectedAccountId(
      charge.locationWorkspaceId,
    );
    if (!connectAccountId) {
      throw new ServiceUnavailableException({
        code: 'REBILLING_NOT_CONFIGURED',
        message: 'rebilling not configured (location has no connected Stripe account)',
      });
    }

    const total = new Prisma.Decimal(charge.totalAmount);
    if (total.lte(0)) {
      // Nothing to charge — settle internally as INVOICED with no Stripe charge.
      return this.prisma.rebillCharge.update({
        where: { id: charge.id },
        data: { status: 'INVOICED' },
      });
    }

    let stripeChargeId: string;
    try {
      const stripe = this.getStripeClient();
      // Decimal-safe TRY → minor units (kuruş): integer, half-up, like the existing
      // Stripe/PayTR adapters.
      const minorUnits = total
        .mul(100)
        .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
        .toNumber();
      // Direct charge on the location's connected account (Stripe Connect). The
      // `idempotencyKey` makes the SDK call itself idempotent at Stripe's side too.
      const intent = await stripe.paymentIntents.create(
        {
          amount: minorUnits,
          currency: 'try',
          confirm: true,
          off_session: true,
          metadata: {
            rebillChargeId: charge.id,
            agencyWorkspaceId,
            locationWorkspaceId: charge.locationWorkspaceId,
          },
        },
        {
          stripeAccount: connectAccountId,
          idempotencyKey: `rebill:${charge.id}`,
        },
      );
      stripeChargeId = intent.id;
    } catch (err) {
      this.logger.error(
        `rebill charge ${charge.id} failed at Stripe: ${(err as Error)?.message ?? err}`,
      );
      await this.prisma.rebillCharge.update({
        where: { id: charge.id },
        data: { status: 'FAILED' },
      });
      throw new ServiceUnavailableException(
        (err as Error)?.message ?? 'Stripe rejected the rebilling charge',
      );
    }

    return this.prisma.rebillCharge.update({
      where: { id: charge.id },
      data: { status: 'PAID', stripeChargeId },
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  /**
   * Coerce + validate a money/percent input to a non-negative Decimal(10,2).
   * basePrice, usageUnitPrice and markupPercent are all semantically
   * non-negative, so the guard is unconditional (no per-field opt-out).
   */
  private toMoney(raw: number | string, field: string): Prisma.Decimal {
    let dec: Prisma.Decimal;
    try {
      dec = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException(`${field} must be a number`);
    }
    if (!dec.isFinite()) throw new BadRequestException(`${field} must be finite`);
    if (dec.isNegative()) throw new BadRequestException(`${field} must be non-negative`);
    return money(dec);
  }
}
