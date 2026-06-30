import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { rangeEndInclusive } from '../services/report-date-range.util';

export type AttributionModel = 'first' | 'last' | 'linear';

interface AttributionQuery {
  model: AttributionModel;
  from?: string;
  to?: string;
}

export interface ChannelAttribution {
  channel: string;
  /** Revenue credited to this channel under the chosen model, in TRY (2dp). */
  revenue: number;
  /** Converted leads crediting this channel under the model. */
  conversions: number;
  /** Distinct leads that had at least one touch on this channel (in range). */
  leads: number;
  /** conversions / leads, as a percentage rounded to 1dp. */
  conversionRate: number;
}

export interface AttributionResult {
  model: AttributionModel;
  /** Sum of accepted-offer value over converted leads in range, TRY (2dp). */
  totalRevenue: number;
  /** Number of converted leads with attributable value in range. */
  conversions: number;
  channels: ChannelAttribution[];
}

/**
 * LeadActivity.type → marketing channel, aligned with Lead.source vocabulary
 * (INSTAGRAM, REFERRAL, FIELD_VISIT, ADS, WEBSITE, PHONE, OTHER) so a phone
 * call and a "PHONE"-sourced lead aggregate onto the same channel. Types with
 * no channel meaning (NOTE, STATUS_CHANGE) are dropped from the touch path.
 */
const ACTIVITY_CHANNEL: Record<string, string> = {
  CALL: 'PHONE',
  VISIT: 'FIELD_VISIT',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  MEETING: 'FIELD_VISIT',
  DEMO: 'FIELD_VISIT',
};

const ZERO = new Prisma.Decimal(0);

/**
 * Multi-touch attribution + conversion value (GoHighLevel parity).
 *
 * Read-only. Derives touch paths from EXISTING data — no new write path:
 *   - the first touch is the lead's origin channel (Lead.source) at createdAt;
 *   - subsequent touches are the lead's channel-bearing LeadActivity rows in
 *     chronological order, up to the conversion moment (convertedAt).
 *
 * A lead's conversion value is the sum of its ACCEPTED offers' effective price
 * (customPrice ?? planMonthlyPrice ?? 0). Money stays Decimal(10,2) TRY — the
 * same semantics the offer/commission paths use — and is surfaced as a Number
 * rounded to 2dp (matching SalesTargetService's Number(_sum.amount) pattern).
 *
 * Every query pins workspaceId; a second workspace's rows can never be read.
 */
@Injectable()
export class AttributionService {
  constructor(private prisma: PrismaService) {}

  private range(from?: string, to?: string): Prisma.LeadWhereInput {
    if (!from && !to) return {};
    const createdAt: Prisma.DateTimeFilter = {};
    if (from) createdAt.gte = new Date(from);
    // Inclusive end-of-day for a bare YYYY-MM-DD, so leads created during the
    // selected end day aren't dropped (mirrors analytics/reports).
    if (to) createdAt.lte = rangeEndInclusive(to);
    return { createdAt };
  }

  /** Effective TRY value of a lead = sum of its ACCEPTED offers' price. */
  private leadValue(offers: {
    status: string;
    customPrice: Prisma.Decimal | number | null;
    planMonthlyPrice: Prisma.Decimal | number | null;
  }[]): Prisma.Decimal {
    let total = ZERO;
    for (const o of offers) {
      if (o.status !== 'ACCEPTED') continue;
      const price = o.customPrice ?? o.planMonthlyPrice ?? 0;
      total = total.plus(new Prisma.Decimal(price as Prisma.Decimal.Value));
    }
    return total;
  }

  /** Ordered, de-duplicated-by-position channel touch path for a lead. */
  private touches(lead: {
    source: string;
    createdAt: Date;
    convertedAt: Date | null;
    activities: { type: string; createdAt: Date }[];
  }): string[] {
    const path: { channel: string; at: number }[] = [
      { channel: lead.source, at: lead.createdAt.getTime() },
    ];
    const cap = lead.convertedAt ? lead.convertedAt.getTime() : Infinity;
    for (const a of lead.activities) {
      const channel = ACTIVITY_CHANNEL[a.type];
      if (!channel) continue;
      if (a.createdAt.getTime() > cap) continue;
      path.push({ channel, at: a.createdAt.getTime() });
    }
    path.sort((x, y) => x.at - y.at);
    return path.map((p) => p.channel);
  }

  async attribution(workspaceId: string, q: AttributionQuery): Promise<AttributionResult> {
    const leads = await this.prisma.lead.findMany({
      // Exclude tombstoned (merged-away) AND soft-deleted (bulk-deleted) leads
      // from analytics — matching analytics/reports, so a hidden lead never
      // keeps contributing channel revenue/conversions.
      where: { workspaceId, mergedIntoId: null, deletedAt: null, ...this.range(q.from, q.to) },
      select: {
        id: true,
        source: true,
        status: true,
        convertedTenantId: true,
        createdAt: true,
        convertedAt: true,
        offers: { select: { status: true, customPrice: true, planMonthlyPrice: true } },
        activities: { select: { type: true, createdAt: true } },
      },
    });

    // Per-channel accumulators.
    const revenue = new Map<string, Prisma.Decimal>(); // model-credited revenue
    const conversions = new Map<string, number>(); // converted leads crediting channel
    const touchedLeads = new Map<string, Set<string>>(); // distinct leads touching channel
    const touchedConverted = new Map<string, Set<string>>(); // converted leads touching channel

    let totalRevenue = ZERO;
    let convertedCount = 0;

    const addRevenue = (channel: string, amount: Prisma.Decimal) => {
      revenue.set(channel, (revenue.get(channel) ?? ZERO).plus(amount));
    };
    const addConversion = (channel: string) => {
      conversions.set(channel, (conversions.get(channel) ?? 0) + 1);
    };

    for (const lead of leads) {
      const path = this.touches(lead);
      // Track touch reach (for conversionRate) regardless of conversion.
      const distinct = new Set(path);
      const value = this.leadValue(lead.offers);
      // Conversion is driven by the REAL signal (status WON / a provisioned
      // tenant — convert() sets both), not by whether the lead happened to have
      // a priced ACCEPTED offer. An offer-less or FREE-plan conversion is still
      // a conversion (its revenue may legitimately be 0).
      const isConverted = lead.status === 'WON' || lead.convertedTenantId != null;

      for (const ch of distinct) {
        if (!touchedLeads.has(ch)) touchedLeads.set(ch, new Set());
        touchedLeads.get(ch)!.add(lead.id);
        if (isConverted) {
          if (!touchedConverted.has(ch)) touchedConverted.set(ch, new Set());
          touchedConverted.get(ch)!.add(lead.id);
        }
      }

      if (!isConverted) continue;
      totalRevenue = totalRevenue.plus(value);
      convertedCount += 1;

      if (q.model === 'first') {
        const ch = path[0];
        addRevenue(ch, value);
        addConversion(ch);
      } else if (q.model === 'last') {
        const ch = path[path.length - 1];
        addRevenue(ch, value);
        addConversion(ch);
      } else {
        // linear — split value evenly across EVERY touch (positional, so a
        // channel touched twice gets two shares). conversions credit distinct
        // channels in the path (a lead converts each channel it ran through).
        const share = value.dividedBy(path.length).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        for (const ch of path) addRevenue(ch, share);
        for (const ch of distinct) addConversion(ch);
      }
    }

    const channels: ChannelAttribution[] = [];
    const allChannels = new Set<string>([...revenue.keys(), ...touchedLeads.keys()]);
    for (const channel of allChannels) {
      const leadCount = touchedLeads.get(channel)?.size ?? 0;
      const convCount = touchedConverted.get(channel)?.size ?? 0;
      channels.push({
        channel,
        revenue: Number((revenue.get(channel) ?? ZERO).toFixed(2)),
        conversions: conversions.get(channel) ?? 0,
        leads: leadCount,
        conversionRate: leadCount ? Math.round((convCount / leadCount) * 1000) / 10 : 0,
      });
    }
    channels.sort((a, b) => b.revenue - a.revenue);

    return {
      model: q.model,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      conversions: convertedCount,
      channels,
    };
  }
}
