import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelTariffService, TariffUnitType } from '../wallet/channel-tariff.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';

export type ResearchUnit = 'FIRECRAWL_PAGE' | 'APIFY_RUN' | 'RESEARCH_LEAD';

/**
 * Prices a unit of AI-research cost (a firecrawl page, an apify actor run, or a
 * delivered qualified lead) from ChannelTariff and debits it to the workspace's
 * SpendLedger under the RESEARCH channel — so "the budget covers prospecting" is
 * real, exactly like ConversationSpendService does for messaging. Best-effort:
 * a pricing/debit blip is logged, never thrown into the research worker.
 */
@Injectable()
export class ResearchSpendService {
  private readonly logger = new Logger(ResearchSpendService.name);

  constructor(
    private readonly tariffs: ChannelTariffService,
    private readonly ledger: SpendLedgerService,
  ) {}

  async settle(
    workspaceId: string,
    opts: { unit: ResearchUnit; quantity: number; ref?: string | null; budgetId?: string | null },
  ): Promise<{ amount: Prisma.Decimal; quantity: number } | null> {
    const qty = Math.max(0, Math.round(opts.quantity ?? 0));
    if (qty === 0) return null;
    try {
      const priced = await this.tariffs.price(workspaceId, 'RESEARCH', opts.unit as TariffUnitType, qty);
      if (!priced) {
        this.logger.debug(`No RESEARCH tariff for ${opts.unit} (ws ${workspaceId}) — spend not metered`);
        return null;
      }
      await this.ledger.debit(workspaceId, {
        channel: 'RESEARCH',
        amount: priced.amount,
        reason: 'RESEARCH',
        ref: opts.ref ?? opts.unit,
        budgetId: opts.budgetId ?? null,
        unitCost: priced.unitCost,
        quantity: qty,
      });
      return { amount: priced.amount, quantity: qty };
    } catch (e) {
      this.logger.warn(`research settle(${opts.unit}) failed for ${workspaceId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
