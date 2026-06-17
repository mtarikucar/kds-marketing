import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';

export const AI_CREDITS_METRIC = 'ai.credits';

/** UTC month key (YYYY-MM) — AI credits + message meters reset monthly. */
export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * Monthly AI-credit metering. Mirrors the lead-ingest reserve/settle pattern:
 * an advisory xact-lock serializes the read-modify-write so concurrent AI
 * actions can't both pass the limit. reserve() BEFORE the LLM call (throws
 * AI_CREDITS_EXHAUSTED at the cap); refund() if the call then fails so a
 * customer isn't charged for an error.
 */
@Injectable()
export class AiCreditsService {
  private readonly logger = new Logger(AiCreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async reserve(workspaceId: string, cost: number): Promise<void> {
    if (cost <= 0) return;
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.aiCreditsMonthly;
    const period = monthKey();

    if (limit === -1) {
      await this.bump(workspaceId, period, cost);
      return;
    }
    if (limit === 0) {
      throw new ForbiddenException({
        code: 'AI_CREDITS_EXHAUSTED',
        message: 'AI credits are not included in your plan',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('ai-credits:' + workspaceId)}))::text AS locked`,
      );
      const row = await tx.usageCounter.findUnique({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId,
            metric: AI_CREDITS_METRIC,
            periodKey: period,
          },
        },
        select: { value: true },
      });
      const used = row?.value ?? 0;
      if (used + cost > limit) {
        throw new ForbiddenException({
          code: 'AI_CREDITS_EXHAUSTED',
          message: `Monthly AI credit limit reached (${limit})`,
        });
      }
      await tx.usageCounter.upsert({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId,
            metric: AI_CREDITS_METRIC,
            periodKey: period,
          },
        },
        create: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period, value: cost },
        update: { value: { increment: cost } },
      });
    });
  }

  /** Return reserved credits to the pool when the AI call itself failed. */
  async refund(workspaceId: string, cost: number): Promise<void> {
    if (cost <= 0) return;
    const period = monthKey();
    // Floored read-modify-write under the SAME per-workspace lock as reserve, so
    // a refund can never drive the meter below 0 (a negative `used` would make
    // `remaining` overstate the cap and let a workspace exceed its plan).
    await this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('ai-credits:' + workspaceId)}))::text AS locked`,
        );
        const row = await tx.usageCounter.findUnique({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period } },
          select: { value: true },
        });
        if (!row) return; // nothing reserved this period → nothing to refund
        const next = Math.max(0, (row.value ?? 0) - cost);
        await tx.usageCounter.update({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period } },
          data: { value: next },
        });
      })
      .catch((e: any) =>
        this.logger.error(`credit refund failed for ${workspaceId}: ${e?.message ?? e}`),
      );
  }

  /** Read-only meter for the billing summary / UI gauges. */
  async usage(workspaceId: string): Promise<{ limit: number; used: number; remaining: number }> {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.aiCreditsMonthly;
    const row = await this.prisma.usageCounter.findUnique({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId,
          metric: AI_CREDITS_METRIC,
          periodKey: monthKey(),
        },
      },
      select: { value: true },
    });
    const used = row?.value ?? 0;
    return { limit, used, remaining: limit === -1 ? -1 : Math.max(0, limit - used) };
  }

  private async bump(workspaceId: string, periodKey: string, delta: number): Promise<void> {
    await this.prisma.usageCounter.upsert({
      where: {
        workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey },
      },
      create: {
        workspaceId,
        metric: AI_CREDITS_METRIC,
        periodKey,
        value: Math.max(0, delta),
      },
      update: { value: { increment: delta } },
    });
  }
}
