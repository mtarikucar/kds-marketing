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
    opts: {
      assetId: string;
      credits: number;
      budgetId?: string | null;
      /** Who rendered it. Absent = fal (every row before hybrid routing). */
      vendor?: 'fal' | 'runware';
      /** The vendor's USD figure for this generation (Runware reports its own). */
      vendorUsd?: number;
    },
  ): Promise<{ amount: Prisma.Decimal; quantity: number } | null> {
    // fal is metered in the catalogue's credits (1 ≈ $0.01). Runware reports
    // its own USD per task and the credit meter stays the catalogue's whichever
    // vendor ran, so a Runware generation is metered in CENTS of that figure
    // under its own tariff row — same currency assumption, two vendors on the
    // report, and never fal's rate for a render fal did not do. Cents are kept
    // FRACTIONAL (4 dp, the ledger's own precision): BiRefNet is $0.0006 a run,
    // and rounding that to a whole cent would either drop it entirely or bill
    // it 17x — the "invoice is real, ledger reads 0" defect this service exists
    // to close. Both meters are nominally cents of USD, so the CONTENT channel's
    // summed quantity stays meaningful across the two.
    const runware = opts.vendor === 'runware';
    const unitType = runware ? 'RUNWARE_CENT' : 'FAL_CREDIT';
    const qty: number | Prisma.Decimal = runware
      ? new Prisma.Decimal(Math.max(0, opts.vendorUsd ?? 0)).mul(100).toDecimalPlaces(4)
      : Math.max(0, Math.round(opts.credits ?? 0));
    if (new Prisma.Decimal(qty).lte(0)) return null;
    try {
      const priced = await this.tariffs.price(workspaceId, 'CONTENT', unitType, qty);
      if (!priced) {
        this.unpriced.warn(
          workspaceId,
          unitType,
          `no CONTENT tariff for ${unitType} (ws ${workspaceId}, ${qty} ${runware ? 'cents' : 'credits'})`,
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
      return { amount: priced.amount, quantity: Number(qty) };
    } catch (e) {
      this.logger.warn(
        `media settle failed for asset ${opts.assetId}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }
}
