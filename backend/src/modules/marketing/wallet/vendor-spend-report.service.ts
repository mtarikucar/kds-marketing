import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelTariffService, TariffChannel, TariffUnitType } from './channel-tariff.service';

/**
 * Every vendor unit the platform can spend real money on, and who bills for it.
 *
 * This list is the point of the report. `SpendLedger` only ever contains rows
 * for spend that could be PRICED: `ResearchSpendService.settle()` and its
 * conversation-side twin both resolve a `ChannelTariff` first and return early
 * when none matches. So an unpriced unit does not show up as a zero in the
 * ledger — it shows up as nothing at all, indistinguishable from "we never used
 * it". Listing the units up front and reporting which ones resolve is the only
 * way to tell those two apart.
 */
export const VENDOR_UNITS: ReadonlyArray<{
  channel: TariffChannel;
  unitType: TariffUnitType;
  vendor: string;
  what: string;
}> = [
  { channel: 'SMS', unitType: 'SMS_SEGMENT', vendor: 'NetGSM', what: 'SMS segmenti' },
  { channel: 'WHATSAPP', unitType: 'WA_MARKETING', vendor: 'Meta', what: 'WhatsApp pazarlama konuşması' },
  { channel: 'WHATSAPP', unitType: 'WA_UTILITY', vendor: 'Meta', what: 'WhatsApp bildirim konuşması' },
  { channel: 'WHATSAPP', unitType: 'WA_SERVICE', vendor: 'Meta', what: 'WhatsApp servis konuşması' },
  { channel: 'VOICE', unitType: 'VOICE_MINUTE', vendor: 'NetGSM', what: 'Sesli arama dakikası' },
  { channel: 'CONTENT', unitType: 'FAL_CREDIT', vendor: 'fal.ai', what: 'Görsel/video üretim kredisi' },
  { channel: 'RESEARCH', unitType: 'FIRECRAWL_PAGE', vendor: 'Firecrawl', what: 'Taranan sayfa' },
  { channel: 'RESEARCH', unitType: 'APIFY_RUN', vendor: 'Apify', what: 'Apify actor koşusu' },
  { channel: 'RESEARCH', unitType: 'RESEARCH_LEAD', vendor: 'Jeeta', what: 'Teslim edilen araştırma lead’i' },
];

export interface VendorRate {
  vendor: string;
  channel: TariffChannel;
  unitType: TariffUnitType;
  what: string;
  /** Null when no tariff resolves — meaning this vendor cost is NOT recorded. */
  unitCost: number | null;
  currency: string | null;
  metered: boolean;
  /** 'workspace' when this workspace overrides the platform default. */
  scope: 'workspace' | 'platform' | null;
}

export interface VendorSpendReport {
  periodDays: number;
  from: string;
  to: string;
  currency: string;
  totalSpend: number;
  totalRefund: number;
  byChannel: Array<{ channel: string; spend: number; refund: number; entries: number; quantity: number }>;
  rates: VendorRate[];
  /** Units with no tariff: real vendor money that leaves no trace anywhere. */
  unmetered: Array<{ vendor: string; unitType: TariffUnitType; what: string }>;
}

/**
 * What this workspace spent with OUTSIDE vendors — carriers, crawlers, actor
 * runs, media generation — as opposed to Anthropic tokens, which
 * `AiUsageStatsService` already reports.
 *
 * The two halves answer different questions and both are needed: `byChannel`
 * says what was recorded, and `rates`/`unmetered` say what CAN be recorded.
 * A vendor with no tariff reads as 0 TRY in every existing view while still
 * costing money on the vendor's own invoice.
 */
@Injectable()
export class VendorSpendReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: ChannelTariffService,
  ) {}

  /**
   * `country` defaults to 'TR' because that is what the spending callers pass
   * (`ConversationSpendService` resolves with `opts.country ?? 'TR'`) and the
   * seeded carrier tariffs carry `country = 'TR'`. Resolving with null here
   * would skip every one of those rows and report SMS, voice and WhatsApp as
   * unmetered while they are, in fact, priced — the exact false alarm this
   * report exists to prevent. The RESEARCH rows are country-agnostic and match
   * either way.
   */
  async report(
    workspaceId: string,
    days = 30,
    now: Date = new Date(),
    country: string | null = 'TR',
  ): Promise<VendorSpendReport> {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [entries, rates] = await Promise.all([
      this.prisma.spendLedger.findMany({
        where: { workspaceId, createdAt: { gte: from, lte: now } },
        select: { channel: true, delta: true, quantity: true },
      }),
      this.rates(workspaceId, now, country),
    ]);

    const perChannel = new Map<
      string,
      { channel: string; spend: number; refund: number; entries: number; quantity: number }
    >();
    let totalSpend = 0;
    let totalRefund = 0;

    for (const row of entries) {
      const delta = Number(row.delta);
      const bucket = perChannel.get(row.channel) ?? {
        channel: row.channel,
        spend: 0,
        refund: 0,
        entries: 0,
        quantity: 0,
      };
      // `delta` is signed: negative is money out, positive is a refund or a
      // correction. Reporting them separately keeps a big refund from hiding a
      // big spend behind a small net number.
      if (delta < 0) {
        bucket.spend += -delta;
        totalSpend += -delta;
      } else {
        bucket.refund += delta;
        totalRefund += delta;
      }
      bucket.entries += 1;
      bucket.quantity += Number(row.quantity ?? 0);
      perChannel.set(row.channel, bucket);
    }

    const round = (n: number) => Math.round(n * 100) / 100;

    return {
      periodDays: days,
      from: from.toISOString(),
      to: now.toISOString(),
      currency: 'TRY',
      totalSpend: round(totalSpend),
      totalRefund: round(totalRefund),
      byChannel: [...perChannel.values()]
        .map((b) => ({ ...b, spend: round(b.spend), refund: round(b.refund) }))
        .sort((a, b) => b.spend - a.spend),
      rates,
      unmetered: rates
        .filter((r) => !r.metered)
        .map((r) => ({ vendor: r.vendor, unitType: r.unitType, what: r.what })),
    };
  }

  private async rates(workspaceId: string, now: Date, country: string | null): Promise<VendorRate[]> {
    const resolved = await Promise.all(
      VENDOR_UNITS.map(async (unit) => ({
        unit,
        tariff: await this.tariffs.resolve(workspaceId, unit.channel, unit.unitType, country, now),
      })),
    );

    // Ask the rows themselves whether the winner was a workspace override rather
    // than re-deriving resolve()'s precedence here — a second copy of that
    // scoring is exactly the kind of duplicate that drifts out of agreement.
    const ids = resolved.map((r) => r.tariff?.tariffId).filter((id): id is string => !!id);
    const owners = new Map<string, string | null>();
    if (ids.length) {
      const rows = await this.prisma.channelTariff.findMany({
        where: { id: { in: ids } },
        select: { id: true, workspaceId: true },
      });
      for (const row of rows) owners.set(row.id, row.workspaceId);
    }

    return resolved.map(({ unit, tariff }) => ({
      vendor: unit.vendor,
      channel: unit.channel,
      unitType: unit.unitType,
      what: unit.what,
      unitCost: tariff ? Number(tariff.unitCost) : null,
      currency: tariff?.currency ?? null,
      metered: !!tariff,
      scope: tariff ? (owners.get(tariff.tariffId) ? 'workspace' : 'platform') : null,
    }));
  }
}
