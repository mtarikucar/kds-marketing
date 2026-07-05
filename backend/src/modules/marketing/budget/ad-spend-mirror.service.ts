import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SpendLedgerService, SpendChannel } from '../wallet/spend-ledger.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface MirrorResult {
  /** New (non-replayed) campaign/account-day rows mirrored this run. */
  mirrored: number;
  governorDebits: number;
}

interface BudgetShape {
  id: string;
  workspaceId: string;
  periodKey: string; // YYYY-MM
  autonomyLevel?: string | null;
}

/** Ad channels whose provider name matches the AdAccount.provider values. */
const AD_PROVIDER_CHANNELS = new Set(['META', 'TIKTOK', 'GOOGLE', 'LINKEDIN']);

/**
 * Ad-spend mirror (Growth Autopilot spec D3, Mode-1 "governor"). The platform
 * does not pay ad networks — the customer's own ad account does — but the
 * engine's pacing and the credit governor still need REAL ad spend in the
 * ledger. Each tick this mirrors engine-scoped AdMetric.spend into idempotent
 * AD_SPEND SpendLedger entries (ref admetric:{campaign|acct}:{day}) and, for
 * armed AUTONOMOUS budgets, debits the wallet with the clearly-labeled
 * non-cash AD_GOVERNOR counterpart — so loaded credit truly bounds what the
 * engine commits. Scope = the budget's own allocations: a concrete campaignRef
 * mirrors that campaign; a channel-level rollup ('' ref) mirrors the
 * account-level rows of that channel's connected ad accounts.
 */
@Injectable()
export class AdSpendMirrorService {
  private readonly logger = new Logger(AdSpendMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: SpendLedgerService,
    private readonly wallet: GrowthWalletService,
  ) {}

  async mirrorForBudget(workspaceId: string, budget: BudgetShape, now: Date = new Date()): Promise<MirrorResult> {
    const allocations = await this.prisma.budgetAllocation.findMany({
      where: { budgetId: budget.id },
      select: { channel: true, campaignRef: true },
    });
    if (allocations.length === 0) return { mirrored: 0, governorDebits: 0 };

    const monthStart = new Date(`${budget.periodKey}-01T00:00:00.000Z`);
    const governed =
      budget.autonomyLevel === 'AUTONOMOUS' && growthAutopilotAutonomyEnabled();

    let mirrored = 0;
    let governorDebits = 0;

    for (const alloc of allocations) {
      const rows = await this.metricsFor(workspaceId, alloc, monthStart, now);
      for (const row of rows) {
        const day = row.date.toISOString().slice(0, 10);
        const scope = row.campaignId && row.campaignId !== ''
          ? row.campaignId
          : `acct:${row.adAccountId}`;
        const ref = `admetric:${scope}:${day}`;

        const res = await this.ledger.debitOnce(workspaceId, {
          channel: alloc.channel as SpendChannel,
          amount: row.spend,
          reason: 'AD_SPEND',
          ref,
          budgetId: budget.id,
        });
        if (res.replayed) continue; // already mirrored — never double-count
        mirrored++;

        if (governed) {
          // Non-cash governor bookkeeping: clamped, never throws on shortfall
          // (the pool math collapses to 0 anyway when credit runs out).
          await this.wallet.debitUpTo(workspaceId, {
            amount: row.spend,
            kind: 'AD_GOVERNOR',
            ref: `adgov:${scope}:${day}`,
            note: `ad spend mirror ${alloc.channel} ${day}`,
          });
          governorDebits++;
        }
      }
    }

    if (mirrored > 0) {
      this.logger.log(`ad-spend mirror: ${mirrored} new day-row(s) for budget ${budget.id}`);
    }
    return { mirrored, governorDebits };
  }

  private async metricsFor(
    workspaceId: string,
    alloc: { channel: string; campaignRef: string },
    monthStart: Date,
    now: Date,
  ): Promise<Array<{ campaignId: string; adAccountId: string; date: Date; spend: Prisma.Decimal }>> {
    if (alloc.campaignRef && alloc.campaignRef !== '') {
      return this.prisma.adMetric.findMany({
        where: {
          workspaceId,
          campaignId: alloc.campaignRef,
          date: { gte: monthStart, lte: now },
          spend: { gt: 0 },
        },
        select: { campaignId: true, adAccountId: true, date: true, spend: true },
      });
    }

    // Channel-level rollup: account-level AdMetric rows ('' campaign) of the
    // channel's connected ad accounts. Non-ad channels have nothing to mirror.
    if (!AD_PROVIDER_CHANNELS.has(alloc.channel)) return [];
    const accounts = await this.prisma.adAccount.findMany({
      where: { workspaceId, provider: alloc.channel },
      select: { id: true },
    });
    if (accounts.length === 0) return [];
    return this.prisma.adMetric.findMany({
      where: {
        workspaceId,
        adAccountId: { in: accounts.map((a) => a.id) },
        campaignId: '',
        date: { gte: monthStart, lte: now },
        spend: { gt: 0 },
      },
      select: { campaignId: true, adAccountId: true, date: true, spend: true },
    });
  }
}
