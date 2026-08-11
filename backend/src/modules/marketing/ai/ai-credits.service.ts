import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AiCreditWalletService } from './ai-credit-wallet.service';

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
    private readonly wallet: AiCreditWalletService,
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
        // The monthly allowance can't cover this. Prepaid credits are the
        // release valve — the plan ships deliberately modest included credits
        // precisely so a heavy month tops up rather than stops.
        //
        // Only the SHORTFALL comes out of the wallet: nobody should burn
        // credits they paid for while free ones are still sitting unused.
        const fromAllowance = Math.max(0, limit - used);
        const shortfall = cost - fromAllowance;
        // `tx` is passed on purpose: the debit MUST commit or roll back with
        // the counter below. Letting the wallet open its own transaction would
        // leave a committed debit behind whenever this one aborts — silently
        // destroying credit the customer paid for.
        const taken = await this.wallet.debitUpTo(
          workspaceId,
          { amount: shortfall, kind: 'SPEND', note: `monthly allowance exhausted (${limit})` },
          tx,
        );
        if (taken < shortfall) {
          // Throwing rolls the transaction back, which returns the partial
          // debit on its own — no compensating credit needed, and issuing one
          // here would hand back the credits twice.
          throw new ForbiddenException({
            code: 'AI_CREDITS_EXHAUSTED',
            message: `Monthly AI credit limit reached (${limit}) and prepaid credits are insufficient`,
          });
        }
        // The counter tracks TOTAL consumed, allowance + wallet, which keeps a
        // single source of truth: everything above `limit` was paid for out of
        // the wallet, and refund() derives the split from exactly that.
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
    let walletBack = 0;

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
        const before = row.value ?? 0;
        const next = Math.max(0, before - cost);

        // Work out how much of what we're handing back had been PAID for.
        // The counter holds total consumed and everything above the allowance
        // came from the wallet, so the paid portion of this refund is the drop
        // in the above-the-limit part. No per-reservation bookkeeping needed,
        // and it stays correct when several reservations interleave.
        const effective = await this.entitlements.getEffective(workspaceId);
        const limit = effective.limits.aiCreditsMonthly;
        if (limit >= 0) {
          walletBack = Math.max(0, before - limit) - Math.max(0, next - limit);
        }

        await tx.usageCounter.update({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period } },
          data: { value: next },
        });

        // Inside the transaction, for the same reason the debit is: the meter
        // and the balance must move together or not at all.
        if (walletBack > 0) {
          await this.wallet.credit(
            workspaceId,
            { amount: walletBack, kind: 'REFUND', note: 'AI call failed' },
            tx,
          );
        }
      })
      .catch((e: any) =>
        this.logger.error(`credit refund failed for ${workspaceId}: ${e?.message ?? e}`),
      );
  }

  /** Meter an already-incurred overage that MUST be recorded even past the cap
   *  (the work was already delivered — e.g. a media generation cost more than the
   *  reserved estimate). Unlike reserve(), this never throws at the limit, so the
   *  meter can't understate what was actually consumed. */
  async chargeOverage(workspaceId: string, cost: number): Promise<void> {
    if (cost <= 0) return;
    await this.bump(workspaceId, monthKey(), cost);
  }

  /** Read-only meter for the billing summary / UI gauges. `walletBalance` is
   *  prepaid credit that keeps working after the monthly allowance is gone —
   *  the gauge is a lie without it once a workspace has topped up. */
  async usage(
    workspaceId: string,
  ): Promise<{ limit: number; used: number; remaining: number; walletBalance: number }> {
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
    const walletBalance = await this.wallet.balance(workspaceId);
    return {
      limit,
      used,
      remaining: limit === -1 ? -1 : Math.max(0, limit - used),
      walletBalance,
    };
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
