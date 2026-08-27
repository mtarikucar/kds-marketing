import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelTariffService } from '../wallet/channel-tariff.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { UnpricedSpendWarner } from './unpriced-spend.warner';

/**
 * Prices a finished fal.ai generation from ChannelTariff and debits it to the
 * workspace's SpendLedger under the CONTENT channel — the same thing
 * ResearchSpendService does for crawls and ConversationSpendService does for
 * carrier traffic.
 *
 * fal.ai was the last vendor whose cost never reached that ledger. The pieces
 * were all present and simply never joined: the `CONTENT` ledger channel, the
 * `FAL_CREDIT` tariff unit and `estimateMediaCredits()` have coexisted since
 * media generation shipped, with nothing in between them. So fal spend showed
 * up in the customer's credit meter and — for engine assets only — in the growth
 * wallet, while the vendor-cost ledger reported 0 for it forever.
 *
 * DELIBERATELY no growth-wallet drawdown here, unlike its two sibling services.
 * MediaGenService already debits the wallet itself at request time and reconciles
 * it against the provider's actual duration on finalize; a second drawdown would
 * bill the same generation twice.
 *
 * Best-effort throughout: an asset that reached the customer must never be
 * failed by a bookkeeping problem.
 */
@Injectable()
export class MediaSpendService {
  private readonly logger = new Logger(MediaSpendService.name);
  private readonly unpriced = new UnpricedSpendWarner(this.logger);

  constructor(
    private readonly tariffs: ChannelTariffService,
    private readonly ledger: SpendLedgerService,
  ) {}

  /**
   * `credits` is the trued-up figure from `estimateMediaCredits()` — the
   * provider's ACTUAL duration, not the requested one — so a 10s request that
   * returns a 4s clip is costed at what fal actually billed.
   */
  async settle(
    workspaceId: string,
    opts: { assetId: string; credits: number; budgetId?: string | null },
  ): Promise<{ amount: Prisma.Decimal; quantity: number } | null> {
    const qty = Math.max(0, Math.round(opts.credits ?? 0));
    if (qty === 0) return null;
    try {
      const priced = await this.tariffs.price(workspaceId, 'CONTENT', 'FAL_CREDIT', qty);
      if (!priced) {
        this.unpriced.warn(
          workspaceId,
          'FAL_CREDIT',
          `no CONTENT tariff for FAL_CREDIT (ws ${workspaceId}, ${qty} credits)`,
        );
        return null;
      }
      // Finalize runs from BOTH the webhook and the poller, and they race by
      // design — the loser is detected further up by an updateMany claim. The
      // settle sits outside that claim, so it dedups on its own ref instead.
      await this.ledger.debitOnce(workspaceId, {
        channel: 'CONTENT',
        amount: priced.amount,
        reason: 'CONTENT_GEN',
        ref: `mediagen:${opts.assetId}`,
        budgetId: opts.budgetId ?? null,
        unitCost: priced.unitCost,
        quantity: qty,
      });
      return { amount: priced.amount, quantity: qty };
    } catch (e) {
      this.logger.warn(
        `media settle failed for asset ${opts.assetId}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }
}
