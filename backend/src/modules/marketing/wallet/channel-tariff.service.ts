import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type TariffChannel = 'SMS' | 'WHATSAPP' | 'VOICE' | 'CONTENT' | 'RESEARCH';
export type TariffUnitType =
  | 'SMS_SEGMENT'
  | 'WA_MARKETING'
  | 'WA_UTILITY'
  | 'WA_SERVICE'
  | 'VOICE_MINUTE'
  | 'FAL_CREDIT'
  | 'FIRECRAWL_PAGE'
  | 'APIFY_RUN'
  | 'RESEARCH_LEAD';

export interface ResolvedTariff {
  unitCost: Prisma.Decimal;
  currency: string;
  tariffId: string;
}

export interface PricedUnits extends ResolvedTariff {
  quantity: Prisma.Decimal;
  amount: Prisma.Decimal;
}

/**
 * Resolves the unit price of a billable growth channel so the Budget Autopilot
 * can express SMS segments, WhatsApp categories, voice minutes and fal credits
 * in one currency. Resolution precedence: a workspace-specific row beats a
 * platform default; a country-matched row beats a country-agnostic one; ties
 * break to the most recent `effectiveFrom`. Rows with `effectiveFrom` in the
 * future or `active=false` never resolve.
 */
@Injectable()
export class ChannelTariffService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    workspaceId: string,
    channel: TariffChannel,
    unitType: TariffUnitType,
    country?: string | null,
    now: Date = new Date(),
  ): Promise<ResolvedTariff | null> {
    const rows = await this.prisma.channelTariff.findMany({
      where: {
        channel,
        unitType,
        active: true,
        effectiveFrom: { lte: now },
        workspaceId: { in: [workspaceId, null] },
        OR: [{ country: null }, ...(country ? [{ country }] : [])],
      },
    });
    if (rows.length === 0) return null;
    const best = rows
      .map((r) => ({
        r,
        score:
          (r.workspaceId === workspaceId ? 2 : 0) +
          (country && r.country === country ? 1 : 0),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.r.effectiveFrom.getTime() - a.r.effectiveFrom.getTime();
      })[0].r;
    return { unitCost: best.unitCost, currency: best.currency, tariffId: best.id };
  }

  /** Resolve the tariff and multiply by `quantity` (segments/minutes/credits). */
  async price(
    workspaceId: string,
    channel: TariffChannel,
    unitType: TariffUnitType,
    quantity: number | Prisma.Decimal,
    country?: string | null,
    now: Date = new Date(),
  ): Promise<PricedUnits | null> {
    const t = await this.resolve(workspaceId, channel, unitType, country, now);
    if (!t) return null;
    const qty = new Prisma.Decimal(quantity);
    return { ...t, quantity: qty, amount: t.unitCost.mul(qty) };
  }
}
