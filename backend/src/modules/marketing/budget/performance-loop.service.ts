import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { collectRevenueEvents } from './revenue-events.util';

export interface ReconcileResult {
  /** Revenue events in the window (all sources, post per-lead precedence). */
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

    // Unified sale signal (spec D9): WON opportunities, PAID invoices, ACCEPTED
    // offers and ACCEPTED estimates — with per-lead precedence so one deal
    // recorded several ways is only counted once. A workspace that sells via
    // invoices/order-forms (no Opportunity ever) now feeds the loop too.
    const events = await collectRevenueEvents(this.prisma, workspaceId, since);
    if (events.length === 0) return { wonOpportunities: 0, attributed: 0, campaignDaysUpdated: 0, revenueAttributed: 0 };

    const leadIds = [...new Set(events.map((e) => e.leadId))];
    const attributions = await this.prisma.leadAttribution.findMany({
      where: { workspaceId, leadId: { in: leadIds }, sourceAdCampaignId: { not: null } },
      select: { leadId: true, sourceAdCampaignId: true },
    });
    const leadToCampaign = new Map(attributions.map((a) => [a.leadId, a.sourceAdCampaignId!]));

    // Sum revenue per (campaign, UTC event-day).
    const byCampaignDay = new Map<string, { campaignId: string; day: Date; revenue: number }>();
    let attributed = 0;
    for (const ev of events) {
      const campaignId = leadToCampaign.get(ev.leadId);
      if (!campaignId) continue;
      const day = utcDay(ev.at);
      const key = `${campaignId}|${day.toISOString()}`;
      const entry = byCampaignDay.get(key) ?? { campaignId, day, revenue: 0 };
      entry.revenue += toNum(ev.value);
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
    return { wonOpportunities: events.length, attributed, campaignDaysUpdated, revenueAttributed };
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
