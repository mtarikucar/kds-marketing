import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface ReconcileResult {
  wonOpportunities: number;
  attributed: number;
  campaignDaysUpdated: number;
  revenueAttributed: number;
}

/**
 * Faz 5 Performance Loop — closes the spend↔content↔revenue loop with FIRST-PARTY
 * data. It reads WON opportunities, joins each back to the ad campaign that
 * sourced its lead (via LeadAttribution), and writes the won value onto
 * AdMetric.revenue for the campaign on the day it closed. That is the exact
 * column BudgetPerformanceSource already sums, so the moment this runs the
 * Budget Autopilot's allocator optimizes on real CRM revenue instead of
 * platform-reported (self-crediting) ROAS. Idempotent by RECOMPUTE: each run
 * sets a (campaign, day)'s revenue to the full sum of won value attributed to
 * it, so re-running never double-counts.
 */
@Injectable()
export class PerformanceLoopService {
  private readonly logger = new Logger(PerformanceLoopService.name);
  private static readonly DEFAULT_WINDOW_DAYS = 30;

  constructor(private readonly prisma: PrismaService) {}

  async reconcile(workspaceId: string, windowDays = PerformanceLoopService.DEFAULT_WINDOW_DAYS, now: Date = new Date()): Promise<ReconcileResult> {
    const since = new Date(now.getTime() - windowDays * 86_400_000);

    const wonOpps = await this.prisma.opportunity.findMany({
      where: { workspaceId, status: 'WON', wonAt: { gte: since }, leadId: { not: null } },
      select: { leadId: true, value: true, wonAt: true },
    });
    if (wonOpps.length === 0) return { wonOpportunities: 0, attributed: 0, campaignDaysUpdated: 0, revenueAttributed: 0 };

    const leadIds = [...new Set(wonOpps.map((o) => o.leadId!).filter(Boolean))];
    const attributions = await this.prisma.leadAttribution.findMany({
      where: { workspaceId, leadId: { in: leadIds }, sourceAdCampaignId: { not: null } },
      select: { leadId: true, sourceAdCampaignId: true },
    });
    const leadToCampaign = new Map(attributions.map((a) => [a.leadId, a.sourceAdCampaignId!]));

    // Sum won value per (campaign, UTC won-day).
    const byCampaignDay = new Map<string, { campaignId: string; day: Date; revenue: number }>();
    let attributed = 0;
    for (const o of wonOpps) {
      const campaignId = leadToCampaign.get(o.leadId!);
      if (!campaignId || !o.wonAt) continue;
      const day = utcDay(o.wonAt);
      const key = `${campaignId}|${day.toISOString()}`;
      const entry = byCampaignDay.get(key) ?? { campaignId, day, revenue: 0 };
      entry.revenue += toNum(o.value);
      byCampaignDay.set(key, entry);
      attributed++;
    }

    let campaignDaysUpdated = 0;
    let revenueAttributed = 0;
    for (const { campaignId, day, revenue } of byCampaignDay.values()) {
      const updated = await this.writeCampaignRevenue(workspaceId, campaignId, day, revenue);
      if (updated) {
        campaignDaysUpdated++;
        revenueAttributed += revenue;
      }
    }
    if (campaignDaysUpdated > 0) {
      this.logger.log(`performance-loop: attributed ${revenueAttributed.toFixed(2)} revenue across ${campaignDaysUpdated} campaign-day(s) for ${workspaceId}`);
    }
    return { wonOpportunities: wonOpps.length, attributed, campaignDaysUpdated, revenueAttributed };
  }

  /**
   * Set AdMetric.revenue for (campaign, day) to `revenue` (recompute = idempotent),
   * recomputing roas from the row's spend. Requires an existing AdMetric row for
   * the campaign to resolve its ad account; if the campaign has never been pulled
   * we can't place the revenue and skip it.
   */
  private async writeCampaignRevenue(workspaceId: string, campaignId: string, day: Date, revenue: number): Promise<boolean> {
    const anchor = await this.prisma.adMetric.findFirst({
      where: { workspaceId, campaignId },
      select: { adAccountId: true },
    });
    if (!anchor) return false;

    const existing = await this.prisma.adMetric.findUnique({
      where: { adAccountId_date_campaignId: { adAccountId: anchor.adAccountId, date: day, campaignId } },
      select: { spend: true },
    });
    const spend = existing ? toNum(existing.spend) : 0;
    const roas = spend > 0 ? new Prisma.Decimal(revenue / spend) : null;
    const rev = new Prisma.Decimal(revenue);

    await this.prisma.adMetric.upsert({
      where: { adAccountId_date_campaignId: { adAccountId: anchor.adAccountId, date: day, campaignId } },
      create: { workspaceId, adAccountId: anchor.adAccountId, date: day, campaignId, revenue: rev, conversionValue: rev, roas: roas ?? undefined },
      update: { revenue: rev, conversionValue: rev, roas: roas ?? null },
    });
    return true;
  }
}

function utcDay(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
function toNum(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : typeof v === 'number' ? v : v.toNumber();
}
