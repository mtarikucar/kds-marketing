import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { usdFor } from './ai-model-prices';
import { AI_CREDIT_COSTS, AiAction } from './ai-credit-costs';

export interface UsageRow {
  action: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Server-tool requests, billed per call. */
  webSearches: number;
  usd: number;
  /** Credits billed for these calls, from the price table. */
  credits: number;
  /**
   * Real cost divided by revenue at the 1 credit ≈ $0.01 anchor. Above 1.0
   * means the action is sold below what it costs to run.
   */
  costRatio: number | null;
}

/**
 * Where the AI money actually went.
 *
 * Every LLM call already records its measured tokens (AiUsageLog); nothing read
 * them back, so "why did the Anthropic bill spike" had no answer short of a
 * psql session on the box. This turns that into a query — and, by pricing each
 * action against what it was CHARGED, it also shows which prices in
 * ai-credit-costs.ts are wrong, which is the thing you actually act on.
 */
@Injectable()
export class AiUsageStatsService {
  constructor(private readonly prisma: PrismaService) {}

  private since(days: number): Date {
    const n = Math.min(Math.max(Math.trunc(days), 1), 365);
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  /** Per action+model, most expensive first. Workspace-scoped when given one. */
  async breakdown(workspaceId: string | undefined, days = 30) {
    const where = { createdAt: { gte: this.since(days) }, ...(workspaceId ? { workspaceId } : {}) };

    const grouped = await this.prisma.aiUsageLog.groupBy({
      by: ['action', 'model'],
      where,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheWriteTokens: true,
        cacheReadTokens: true,
        webSearches: true,
      },
    });

    const rows: UsageRow[] = grouped.map((g) => {
      const inputTokens = g._sum.inputTokens ?? 0;
      const outputTokens = g._sum.outputTokens ?? 0;
      const cacheWriteTokens = g._sum.cacheWriteTokens ?? 0;
      const cacheReadTokens = g._sum.cacheReadTokens ?? 0;
      const webSearches = g._sum.webSearches ?? 0;
      const calls = g._count._all;
      const usd = usdFor(g.model, {
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        webSearches,
      });
      const perCall = AI_CREDIT_COSTS[g.action as AiAction]?.credits;
      const credits = perCall === undefined ? 0 : perCall * calls;
      return {
        action: g.action,
        model: g.model,
        calls,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        webSearches,
        usd,
        credits,
        // 1 credit ≈ $0.01 (media-models.config's anchor).
        costRatio: credits > 0 ? Math.round((usd / (credits * 0.01)) * 100) / 100 : null,
      };
    });
    rows.sort((a, b) => b.usd - a.usd);

    const totalUsd = Math.round(rows.reduce((n, r) => n + r.usd, 0) * 100) / 100;
    const totalIn = rows.reduce(
      (n, r) => n + r.inputTokens + r.cacheWriteTokens + r.cacheReadTokens,
      0,
    );
    const totalOut = rows.reduce((n, r) => n + r.outputTokens, 0);

    return {
      days,
      scope: workspaceId ? 'workspace' : 'platform',
      total: {
        usd: totalUsd,
        calls: rows.reduce((n, r) => n + r.calls, 0),
        inputTokens: totalIn,
        outputTokens: totalOut,
        // Input dwarfing output is the tell that a tool loop is re-sending
        // schemas every turn — i.e. that prompt caching is the lever.
        inputOutputRatio: totalOut > 0 ? Math.round((totalIn / totalOut) * 10) / 10 : null,
      },
      rows,
    };
  }

  /** Daily totals, newest first — for spotting the day it ran away. */
  async daily(workspaceId: string | undefined, days = 30) {
    const where = { createdAt: { gte: this.since(days) }, ...(workspaceId ? { workspaceId } : {}) };
    const logs = await this.prisma.aiUsageLog.findMany({
      where,
      select: {
        createdAt: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheWriteTokens: true,
        cacheReadTokens: true,
        webSearches: true,
      },
    });

    const byDay = new Map<string, { day: string; calls: number; usd: number }>();
    for (const l of logs) {
      const day = l.createdAt.toISOString().slice(0, 10);
      const cur = byDay.get(day) ?? { day, calls: 0, usd: 0 };
      cur.calls += 1;
      cur.usd += usdFor(l.model, l);
      byDay.set(day, cur);
    }
    return [...byDay.values()]
      .map((d) => ({ ...d, usd: Math.round(d.usd * 100) / 100 }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }
}
