import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelTariffService, TariffUnitType } from '../wallet/channel-tariff.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { smsSegments } from '../wallet/sms-segments.util';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface SettlementResult {
  amount: Prisma.Decimal;
  quantity: number;
  unitCost: Prisma.Decimal;
}

type WaCategory = 'MARKETING' | 'UTILITY' | 'SERVICE';

/**
 * Prices a completed conversation event (SMS / WhatsApp template / voice minute)
 * from ChannelTariff, debits it to the SpendLedger, and stamps the real cost on
 * the message/call row. This is what makes "the budget covers conversations"
 * real — every outbound touch settles against the same growth budget as ad
 * spend. Best-effort: pricing/debit failures are logged, never thrown, so a
 * settlement blip can't break the send path that calls it.
 *
 * Growth Autopilot D4: spend recorded WITH a budgetId (engine context) whose
 * budget is armed AUTONOMOUS additionally draws down the prepaid growth
 * wallet. Manual settlements (no budgetId) are untouched.
 */
@Injectable()
export class ConversationSpendService {
  private readonly logger = new Logger(ConversationSpendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: ChannelTariffService,
    private readonly ledger: SpendLedgerService,
    private readonly wallet: GrowthWalletService,
  ) {}

  /** Price + record an outbound SMS by segment count. */
  async settleSms(
    workspaceId: string,
    opts: { messageId: string; text: string; country?: string | null; budgetId?: string | null },
  ): Promise<SettlementResult | null> {
    const segments = smsSegments(opts.text ?? '');
    const priced = await this.tariffs.price(workspaceId, 'SMS', 'SMS_SEGMENT', segments, opts.country ?? 'TR');
    if (!priced) return this.unpriced('SMS', workspaceId);
    await this.debitAndStampMessage(workspaceId, opts.messageId, 'SMS', 'SMS', priced.amount, priced.unitCost, segments, opts.budgetId ?? null, {
      smsSegments: segments,
    });
    return { amount: priced.amount, quantity: segments, unitCost: priced.unitCost };
  }

  /**
   * Price + record an outbound CAMPAIGN SMS by segment count — SpendLedger
   * entry ONLY, deliberately narrower than `settleSms`: a CampaignRecipient
   * has no `costAmount` column to stamp (unlike Message), and adding one is
   * out of scope here, so this mirrors `settleVoice`'s shape (ledger debit +
   * engine wallet drawdown, no per-row cost stamp) rather than
   * `debitAndStampMessage`'s.
   */
  async settleCampaignSms(
    workspaceId: string,
    opts: { recipientId: string; text: string; country?: string | null; budgetId?: string | null },
  ): Promise<SettlementResult | null> {
    const segments = smsSegments(opts.text ?? '');
    const priced = await this.tariffs.price(workspaceId, 'SMS', 'SMS_SEGMENT', segments, opts.country ?? 'TR');
    if (!priced) return this.unpriced('SMS', workspaceId);
    await this.safe(async () => {
      // debitOnce: ref-deduped so a replayed settlement (future retry path,
      // crash-recovery re-run) can never double-bill the same recipient.
      await this.ledger.debitOnce(workspaceId, {
        channel: 'SMS',
        amount: priced.amount,
        reason: 'SMS',
        ref: opts.recipientId,
        budgetId: opts.budgetId ?? null,
        unitCost: priced.unitCost,
        quantity: segments,
      });
      await this.engineWalletDrawdown(workspaceId, opts.budgetId ?? null, 'SMS', opts.recipientId, priced.amount);
    });
    return { amount: priced.amount, quantity: segments, unitCost: priced.unitCost };
  }

  /** Price + record an outbound WhatsApp template by conversation category. */
  async settleWhatsApp(
    workspaceId: string,
    opts: { messageId: string; category: WaCategory; country?: string | null; budgetId?: string | null },
  ): Promise<SettlementResult | null> {
    const unitType = `WA_${opts.category}` as TariffUnitType;
    const priced = await this.tariffs.price(workspaceId, 'WHATSAPP', unitType, 1, opts.country ?? 'TR');
    if (!priced) return this.unpriced('WHATSAPP', workspaceId);
    await this.debitAndStampMessage(workspaceId, opts.messageId, 'WHATSAPP', 'WHATSAPP', priced.amount, priced.unitCost, 1, opts.budgetId ?? null, {});
    return { amount: priced.amount, quantity: 1, unitCost: priced.unitCost };
  }

  /** Price + record a completed voice call by billable minutes (ceil). */
  async settleVoice(
    workspaceId: string,
    opts: { callId: string; durationSec: number; country?: string | null; budgetId?: string | null; table?: 'voiceCall' | 'salesCall' },
  ): Promise<SettlementResult | null> {
    const minutes = Math.max(1, Math.ceil((opts.durationSec ?? 0) / 60));
    const priced = await this.tariffs.price(workspaceId, 'VOICE', 'VOICE_MINUTE', minutes, opts.country ?? 'TR');
    if (!priced) return this.unpriced('VOICE', workspaceId);
    await this.safe(async () => {
      await this.ledger.debit(workspaceId, {
        channel: 'VOICE',
        amount: priced.amount,
        reason: 'VOICE',
        ref: opts.callId,
        budgetId: opts.budgetId ?? null,
        unitCost: priced.unitCost,
        quantity: minutes,
      });
      const data = { costAmount: priced.amount, billableSeconds: opts.durationSec ?? 0 };
      if (opts.table === 'salesCall') {
        await this.prisma.salesCall.update({ where: { id: opts.callId }, data });
      } else {
        await this.prisma.voiceCall.update({ where: { id: opts.callId }, data });
      }
      await this.engineWalletDrawdown(workspaceId, opts.budgetId ?? null, 'VOICE', opts.callId, priced.amount);
    });
    return { amount: priced.amount, quantity: minutes, unitCost: priced.unitCost };
  }

  private async debitAndStampMessage(
    workspaceId: string,
    messageId: string,
    channel: 'SMS' | 'WHATSAPP',
    reason: 'SMS' | 'WHATSAPP',
    amount: Prisma.Decimal,
    unitCost: Prisma.Decimal,
    quantity: number,
    budgetId: string | null,
    extraStamp: Prisma.MessageUpdateInput,
  ): Promise<void> {
    await this.safe(async () => {
      // debitOnce: ref-deduped (messageId) — a replayed settlement no-ops
      // instead of double-billing; same safety as the wallet drawdown below.
      await this.ledger.debitOnce(workspaceId, {
        channel,
        amount,
        reason,
        ref: messageId,
        budgetId,
        unitCost,
        quantity,
      });
      await this.prisma.message.update({ where: { id: messageId }, data: { costAmount: amount, ...extraStamp } });
      await this.engineWalletDrawdown(workspaceId, budgetId, channel, messageId, amount);
    });
  }

  /**
   * Growth Autopilot D4: engine-initiated conversation spend (it carries a
   * budgetId) draws down the prepaid growth wallet when that budget is armed
   * AUTONOMOUS (and the env flag is on). This service settles AFTER the
   * message/call already went out (post-send accounting), so the drawdown is
   * `debitUpTo` — clamped best-effort, never fail-closed: you can't unsend an
   * SMS, and the D5 effective-pool math collapses to spent-so-far once the
   * wallet empties, idling the engine. The wallet ref derives from the ledger
   * ref (messageId/callId), so a replayed settlement can never double-draw.
   * Never throws — a wallet blip must not disturb the settlement.
   */
  private async engineWalletDrawdown(
    workspaceId: string,
    budgetId: string | null,
    channel: 'SMS' | 'WHATSAPP' | 'VOICE',
    ref: string,
    amount: Prisma.Decimal,
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
        ref: `engine:${channel}:${ref}`,
        note: `engine ${channel.toLowerCase()} spend (budget ${budgetId})`,
      });
    } catch (err) {
      this.logger.warn(`engine wallet drawdown failed (${channel} ${ref}): ${String((err as Error)?.message ?? err)}`);
    }
  }

  private unpriced(channel: string, workspaceId: string): null {
    this.logger.debug(`no ${channel} tariff for workspace ${workspaceId}; skipping settlement`);
    return null;
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`conversation spend settlement failed: ${String((err as Error)?.message ?? err)}`);
    }
  }
}
