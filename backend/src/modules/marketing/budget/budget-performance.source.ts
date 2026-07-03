import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelPerf } from './marginal-allocator.util';

/** Provider → allocator channel key. */
const PROVIDER_CHANNEL: Record<string, string> = {
  META: 'META',
  TIKTOK: 'TIKTOK',
  LINKEDIN: 'LINKEDIN',
  GOOGLE: 'GOOGLE',
};

interface AllocationLike {
  channel: string;
  campaignRef: string;
  plannedAmount: { toNumber(): number } | number;
}

const num = (v: { toNumber(): number } | number | null | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : v.toNumber();

/**
 * Gathers the per-channel spend/revenue signal the allocator needs, from the
 * spend/revenue already ingested into AdMetric over a trailing window. This is
 * the seam the Faz 5 Performance Loop upgrades: today it uses provider-reported
 * spend + whatever revenue has been reconciled onto AdMetric; once first-party
 * lead→revenue attribution lands, `revenue` becomes CRM-sourced with no change
 * to the allocator. Non-ad channels (CONTENT/SMS/VOICE/WHATSAPP) currently carry
 * no revenue signal, so they hold.
 */
@Injectable()
export class BudgetPerformanceSource {
  private static readonly WINDOW_DAYS = 7;

  constructor(private readonly prisma: PrismaService) {}

  async collect(
    workspaceId: string,
    allocations: AllocationLike[],
    now: Date = new Date(),
  ): Promise<ChannelPerf[]> {
    const since = new Date(now.getTime() - BudgetPerformanceSource.WINDOW_DAYS * 86_400_000);
    const metrics = await this.prisma.adMetric.findMany({
      where: { workspaceId, date: { gte: since } },
      select: { spend: true, revenue: true, leads: true, adAccount: { select: { provider: true } } },
    });

    // Aggregate spend/revenue/leads per allocator channel.
    const byChannel = new Map<string, { spend: number; revenue: number; conversions: number }>();
    for (const m of metrics) {
      const channel = PROVIDER_CHANNEL[m.adAccount?.provider ?? ''];
      if (!channel) continue;
      const agg = byChannel.get(channel) ?? { spend: 0, revenue: 0, conversions: 0 };
      agg.spend += num(m.spend);
      agg.revenue += num(m.revenue);
      agg.conversions += m.leads ?? 0;
      byChannel.set(channel, agg);
    }

    return allocations.map((a) => {
      const agg = byChannel.get(a.channel) ?? { spend: 0, revenue: 0, conversions: 0 };
      return {
        channel: a.channel,
        campaignRef: a.campaignRef,
        currentBudget: num(a.plannedAmount),
        spend: agg.spend,
        revenue: agg.revenue,
        conversions: agg.conversions,
      };
    });
  }
}
