import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelTariffService, TariffUnitType } from '../wallet/channel-tariff.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export type ResearchUnit = 'FIRECRAWL_PAGE' | 'APIFY_RUN' | 'RESEARCH_LEAD';

/**
 * Prices a unit of AI-research cost (a firecrawl page, an apify actor run, or a
 * delivered qualified lead) from ChannelTariff and debits it to the workspace's
 * SpendLedger under the RESEARCH channel — so "the budget covers prospecting" is
 * real, exactly like ConversationSpendService does for messaging. Best-effort:
 * a pricing/debit blip is logged, never thrown into the research worker.
 *
 * Growth Autopilot D4: spend recorded WITH a budgetId (engine context) whose
 * budget is armed AUTONOMOUS additionally draws down the prepaid growth
 * wallet. Manual settlements (no budgetId) are untouched.
 */
@Injectable()
export class ResearchSpendService {
  private readonly logger = new Logger(ResearchSpendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: ChannelTariffService,
    private readonly ledger: SpendLedgerService,
    private readonly wallet: GrowthWalletService,
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
      const entry = await this.ledger.debit(workspaceId, {
        channel: 'RESEARCH',
        amount: priced.amount,
        reason: 'RESEARCH',
        ref: opts.ref ?? opts.unit,
        budgetId: opts.budgetId ?? null,
        unitCost: priced.unitCost,
        quantity: qty,
      });
      await this.engineWalletDrawdown(workspaceId, opts.budgetId ?? null, entry.id, priced.amount, opts.unit);
      return { amount: priced.amount, quantity: qty };
    } catch (e) {
      this.logger.warn(`research settle(${opts.unit}) failed for ${workspaceId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * Growth Autopilot D4: engine-initiated research spend (it carries a
   * budgetId) draws down the prepaid growth wallet when that budget is armed
   * AUTONOMOUS (and the env flag is on). The settle runs AFTER the page/actor
   * run already executed (post-consumption accounting), so the drawdown is
   * `debitUpTo` — clamped best-effort, never fail-closed. The wallet ref uses
   * the unique ledger ENTRY id (`spend:{id}`) because the research ledger ref
   * (the runId) legitimately repeats across settles within one run. Never
   * throws — a wallet blip must not lose the settlement result.
   */
  private async engineWalletDrawdown(
    workspaceId: string,
    budgetId: string | null,
    ledgerEntryId: string,
    amount: Prisma.Decimal,
    unit: ResearchUnit,
  ): Promise<void> {
    try {
      if (!budgetId || !growthAutopilotAutonomyEnabled()) return;
      const budget = await this.prisma.growthBudget.findFirst({
        where: { id: budgetId, workspaceId },
        select: { autonomyLevel: true },
      });
      if (budget?.autonomyLevel !== 'AUTONOMOUS') return;
      await this.wallet.debitUpTo(workspaceId, {
        amount,
        kind: 'ENGINE_SPEND',
        ref: `spend:${ledgerEntryId}`,
        note: `engine research spend ${unit} (budget ${budgetId})`,
      });
    } catch (e) {
      this.logger.warn(`engine wallet drawdown failed for research ${unit}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
