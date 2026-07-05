import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export type ActivityType = 'RUN' | 'SPEND' | 'WALLET';

export interface ActivityItem {
  ts: Date;
  type: ActivityType;
  /** Structured payload — the client localizes the plain-language "why". */
  data: Record<string, unknown>;
}

/**
 * Activity Log (Growth Autopilot spec D14) — the trust surface that REPLACES
 * the approval queue for autonomous budgets. One merged, time-desc feed of
 * everything the engine did: every autopilot decision (before→after + why),
 * every ledger debit, every wallet movement. The user reads WHAT HAPPENED;
 * they are never asked permission. Workspace-scoped throughout.
 */
@Injectable()
export class BudgetActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async activity(workspaceId: string, budgetId: string, limit = 100): Promise<ActivityItem[]> {
    const budget = await this.prisma.growthBudget.findFirst({
      where: { id: budgetId, workspaceId },
      select: { id: true },
    });
    if (!budget) throw new NotFoundException('Growth budget not found');

    const take = Math.min(Math.max(limit, 1), 200);
    const [runs, spend, wallet] = await Promise.all([
      this.prisma.autopilotRun.findMany({
        where: { workspaceId, budgetId },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true, kind: true, autonomy: true, ok: true, createdAt: true,
          objective: true, before: true, after: true, approvalRequestId: true,
        },
      }),
      this.prisma.spendLedger.findMany({
        where: { workspaceId, budgetId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, channel: true, reason: true, delta: true, balanceAfter: true, ref: true, createdAt: true },
      }),
      // The wallet is workspace-level (one per workspace) — its movements
      // belong on every budget's feed.
      this.prisma.growthWalletLedgerEntry.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, kind: true, delta: true, balanceAfter: true, ref: true, note: true, createdAt: true },
      }),
    ]);

    const items: ActivityItem[] = [
      ...runs.map((r) => ({ ts: r.createdAt, type: 'RUN' as const, data: r as unknown as Record<string, unknown> })),
      ...spend.map((s) => ({ ts: s.createdAt, type: 'SPEND' as const, data: s as unknown as Record<string, unknown> })),
      ...wallet.map((w) => ({ ts: w.createdAt, type: 'WALLET' as const, data: w as unknown as Record<string, unknown> })),
    ];
    items.sort((a, b) => b.ts.getTime() - a.ts.getTime());
    return items.slice(0, take);
  }
}
