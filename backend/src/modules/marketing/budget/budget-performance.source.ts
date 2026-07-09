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
      select: { spend: true, revenue: true, leads: true, campaignId: true, adAccount: { select: { provider: true } } },
    });

    // Aggregate BOTH per (channel, campaign) — so the entry-based allocator sees
    // each campaign's OWN true ROAS instead of the channel blend — AND per channel
    // (for channel-rollup allocations that carry no campaignRef).
    type Agg = { spend: number; revenue: number; conversions: number };
    const empty = (): Agg => ({ spend: 0, revenue: 0, conversions: 0 });
    const byCampaign = new Map<string, Agg>();
    const byChannel = new Map<string, Agg>();
    const bump = (map: Map<string, Agg>, key: string, m: (typeof metrics)[number]) => {
      const agg = map.get(key) ?? empty();
      agg.spend += num(m.spend);
      agg.revenue += num(m.revenue);
      agg.conversions += m.leads ?? 0;
      map.set(key, agg);
    };
    for (const m of metrics) {
      const channel = PROVIDER_CHANNEL[m.adAccount?.provider ?? ''];
      if (!channel) continue;
      bump(byCampaign, `${channel}:${m.campaignId ?? ''}`, m);
      bump(byChannel, channel, m);
    }

    return allocations.map((a) => {
      // Campaign allocation → that campaign's own perf; channel-rollup (no
      // campaignRef) → the channel total.
      const agg = a.campaignRef
        ? byCampaign.get(`${a.channel}:${a.campaignRef}`) ?? empty()
        : byChannel.get(a.channel) ?? empty();
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
