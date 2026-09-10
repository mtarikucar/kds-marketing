import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AI_CREDIT_COSTS } from './ai-credit-costs';
import { AiUsageStatsService } from './ai-usage-stats.service';
import { AI_SPEND_CATEGORIES, AiSpendCategory } from './ai-spend-policy';

/**
 * The settings page for AI money: what each job costs, and a switch per job.
 *
 * ── WHY THE PRICE HAS TO BE MEASURED, NOT LISTED ────────────────────────────
 *
 * `AI_CREDIT_COSTS` is priced from token CEILINGS, and its own docstring says
 * so: they are "deliberately conservative" guesses at what an action might
 * cost. Showing only those next to a switch would answer "what do we charge"
 * when the owner is asking "what does this actually cost me".
 *
 * So every row carries both, and they disagree on purpose:
 *
 *   - `credits` — what the workspace is metered.
 *   - `measured` — what the vendor actually billed, from AiUsageLog: dollars,
 *     calls, and the dollars-per-call that makes categories comparable.
 *
 * A category with no measured rows is not free; it is UNRUN. The field says
 * `calls: 0` rather than `usd: 0` alone, so nobody reads "never used" as
 * "costs nothing" — on this deployment `conversation` reads $0.00 only because
 * the platform key was dry and it never got to run.
 */
@Injectable()
export class AiSpendSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    // The dollar figures come from the service that already prices AiUsageLog
    // rows against per-model rates, including cache reads/writes and
    // per-request server tools. Re-deriving them here would be a second
    // pricing table to keep in step with the vendor's.
    private readonly usage: AiUsageStatsService,
  ) {}

  async get(workspaceId: string, days = 90) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiSpendPolicy: true },
    });
    const policy = (ws?.aiSpendPolicy as Record<string, unknown> | null) ?? {};

    // Folded from per-action rows into categories — the log is keyed by
    // action, and the category is a product concept that lives in code. The
    // same action can appear on SEVERAL models (a tier remap leaves history on
    // the old one), so rows are summed rather than indexed.
    const measured = await this.usage.breakdown(workspaceId, days).catch(() => ({ rows: [] as any[] }));
    const byAction = new Map<string, { usd: number; calls: number }>();
    for (const row of (measured as any).rows ?? []) {
      const hit = byAction.get(row.action) ?? { usd: 0, calls: 0 };
      hit.usd += Number(row.usd ?? 0);
      hit.calls += Number(row.calls ?? 0);
      byAction.set(row.action, hit);
    }

    let totalUsd = 0;
    const categories = (Object.keys(AI_SPEND_CATEGORIES) as AiSpendCategory[]).map((key) => {
      const def = AI_SPEND_CATEGORIES[key];
      let usd = 0;
      let calls = 0;
      const actions = def.actions.map((action) => {
        const hit = byAction.get(action);
        usd += hit?.usd ?? 0;
        calls += hit?.calls ?? 0;
        const priced = (AI_CREDIT_COSTS as Record<string, { credits: number; tier: string }>)[action];
        return {
          action,
          credits: priced?.credits ?? null,
          model: priced?.tier ?? null,
          measured: {
            usd: round(hit?.usd ?? 0),
            calls: hit?.calls ?? 0,
            usdPerCall: hit && hit.calls ? round(hit.usd / hit.calls, 4) : null,
          },
        };
      });
      totalUsd += usd;
      return {
        key,
        label: def.label,
        description: def.description,
        // Absent means ON — only an explicit false switches a job off.
        enabled: policy[key] !== false,
        measured: {
          usd: round(usd),
          calls,
          usdPerCall: calls ? round(usd / calls, 4) : null,
        },
        actions,
      };
    });

    // The share is what makes the page actionable: it names the one job worth
    // switching off, instead of leaving the owner to compare ten dollar
    // amounts by eye.
    for (const c of categories as any[]) {
      c.measured.shareOfBill = totalUsd > 0 ? Math.round((c.measured.usd / totalUsd) * 1000) / 10 : 0;
    }
    categories.sort((a: any, b: any) => b.measured.usd - a.measured.usd);

    return { days, totalUsd: round(totalUsd), categories };
  }

  /**
   * Flip switches. Only known categories, and only booleans.
   *
   * A typo'd key silently stored would read as "off" to nobody and "on" to the
   * gate — a switch that appears to be set and does nothing. Refused instead.
   */
  async set(workspaceId: string, patch: Record<string, unknown>) {
    const known = new Set(Object.keys(AI_SPEND_CATEGORIES));
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!known.has(key)) {
        throw new BadRequestException(
          `Unknown AI spend category "${key}". Known: ${[...known].join(', ')}`,
        );
      }
      if (typeof value !== 'boolean') {
        throw new BadRequestException(`"${key}" must be true or false.`);
      }
      next[key] = value;
    }

    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiSpendPolicy: true },
    });
    const merged = {
      ...((ws?.aiSpendPolicy as Record<string, unknown> | null) ?? {}),
      ...next,
    };
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { aiSpendPolicy: merged as never },
    });
    return this.get(workspaceId);
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
