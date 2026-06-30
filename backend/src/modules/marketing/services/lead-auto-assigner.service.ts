import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Auto-assignment policies — kept in sync with the seeded values in
 * the marketing_distribution_config table.
 */
export const DISTRIBUTION_STRATEGIES = ['DISABLED', 'ROUND_ROBIN', 'LEAST_LOADED'] as const;
export type DistributionStrategy = (typeof DISTRIBUTION_STRATEGIES)[number];

/**
 * Picks a sales rep to own a freshly-created lead, based on the
 * caller workspace's MarketingDistributionConfig row (one per
 * workspace — no longer a singleton). Returns `null` when the caller
 * should fall back to manual assignment — either the strategy
 * is DISABLED, no active reps exist, or the call raced with config
 * deletion. Callers must tolerate `null` and treat the lead as
 * unassigned in that case (the manager will dispatch it later).
 */
@Injectable()
export class LeadAutoAssignerService {
  private readonly logger = new Logger(LeadAutoAssignerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async pickAssignee(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const db = tx ?? this.prisma;
    const cfg = await db.marketingDistributionConfig.findFirst({
      where: { workspaceId },
    });
    if (!cfg || cfg.strategy === 'DISABLED') return null;

    const activeReps = await db.marketingUser.findMany({
      where: { workspaceId, role: 'REP', status: 'ACTIVE' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (activeReps.length === 0) return null;

    if (cfg.strategy === 'ROUND_ROBIN') {
      const lastIdx = cfg.lastAssignedToId
        ? activeReps.findIndex((r) => r.id === cfg.lastAssignedToId)
        : -1;
      const next = activeReps[(lastIdx + 1) % activeReps.length];
      // Atomic cursor advance. Two concurrent ingests racing here
      // both read the same `cfg.lastAssignedToId` snapshot, so they'd
      // pick the same next rep — acceptable: the cursor still moves
      // forward and self-corrects on the next call. We don't try to
      // serialize through SELECT FOR UPDATE because lead creation
      // shouldn't block on a per-workspace lock. Keyed by the config
      // row id, which the scoped findFirst above resolved in-workspace.
      await db.marketingDistributionConfig.update({
        where: { id: cfg.id },
        data: { lastAssignedToId: next.id },
      });
      return next.id;
    }

    if (cfg.strategy === 'LEAST_LOADED') {
      const counts = await db.lead.groupBy({
        by: ['assignedToId'],
        where: {
          workspaceId,
          assignedToId: { in: activeReps.map((r) => r.id) },
          // Terminal leads don't count toward "load" — a rep who closed
          // 50 deals shouldn't be considered the most loaded one.
          status: { notIn: ['WON', 'LOST'] },
          // Hidden leads don't count either: a rep whose leads were merged
          // away or bulk-deleted would otherwise look "loaded" and be unfairly
          // skipped, even though those leads no longer exist for them.
          mergedIntoId: null,
          deletedAt: null,
        },
        _count: { _all: true },
      });
      const countMap = new Map(
        counts.map((c) => [c.assignedToId, c._count._all]),
      );
      // Tie-breaker: keep stable createdAt order so reproducible.
      const sorted = activeReps
        .map((r) => ({ id: r.id, open: countMap.get(r.id) ?? 0 }))
        .sort((a, b) => a.open - b.open);
      return sorted[0].id;
    }

    // Unknown strategy — log and fall back to manual rather than
    // throwing inside a lead create() path.
    this.logger.warn(`Unknown distribution strategy: ${cfg.strategy}`);
    return null;
  }
}
