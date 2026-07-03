import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelTariffService, TariffUnitType } from '../wallet/channel-tariff.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { smsSegments } from '../wallet/sms-segments.util';

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
 */
@Injectable()
export class ConversationSpendService {
  private readonly logger = new Logger(ConversationSpendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tariffs: ChannelTariffService,
    private readonly ledger: SpendLedgerService,
  ) {}

  /** Price + record an outbound SMS by segment count. */
  async settleSms(
    workspaceId: string,
    opts: { messageId: string; text: string; country?: string | null; budgetId?: string | null },
  ): Promise<SettlementResult | null> {
    const segments = smsSegments(opts.text ?? '');
    const priced = await this.tariffs.price(workspaceId, 'SMS', 'SMS_SEGMENT', segments, opts.country ?? 'TR');
    if (!priced) return this.unpriced('SMS', workspaceId);
    await this.debitAndStampMessage(workspaceId, opts.messageId, 'SMS', 'SMS', priced.amount, priced.unitCost, segments, {
      smsSegments: segments,
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
    await this.debitAndStampMessage(workspaceId, opts.messageId, 'WHATSAPP', 'WHATSAPP', priced.amount, priced.unitCost, 1, {});
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
    extraStamp: Prisma.MessageUpdateInput,
  ): Promise<void> {
    await this.safe(async () => {
      await this.ledger.debit(workspaceId, {
        channel,
        amount,
        reason,
        ref: messageId,
        unitCost,
        quantity,
      });
      await this.prisma.message.update({ where: { id: messageId }, data: { costAmount: amount, ...extraStamp } });
    });
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
