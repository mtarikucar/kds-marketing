import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AiCreditWalletService } from './ai-credit-wallet.service';

export const AI_CREDITS_METRIC = 'ai.credits';

/**
 * How much of this period's consumption was funded by the PREPAID WALLET.
 *
 * Without it, refund() has to infer the paid portion from "everything above the
 * monthly limit came from the wallet" — and `chargeOverage()` breaks that
 * invariant on purpose: it bumps the counter past the limit WITHOUT a wallet
 * debit, because the work was already delivered. A later refund from any other
 * action in the same month would then read the inflated counter and credit the
 * wallet for credits it never gave up, minting them out of nothing.
 *
 * Tracking the wallet-funded total explicitly makes the refund floor exact.
 */
export const AI_CREDITS_WALLET_METRIC = 'ai.credits.wallet';

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
      // No allowance — but prepaid credits are the customer's MONEY and were
      // sold as non-expiring. A lapsed or cancelled subscription resolves to
      // zeroEntitlements, and throwing here made a paid balance permanently
      // unspendable while the billing page still displayed it.
      const taken = await this.wallet.debitUpTo(workspaceId, {
        amount: cost,
        kind: 'SPEND',
        note: 'no monthly allowance — spending prepaid credits',
      });
      if (taken < cost) {
        if (taken > 0) {
          await this.wallet
            .credit(workspaceId, { amount: taken, kind: 'REFUND', note: 'insufficient balance' })
            .catch(() => undefined);
        }
        throw new ForbiddenException({
          code: 'AI_CREDITS_EXHAUSTED',
          message: 'AI credits are not included in your plan and prepaid credits are insufficient',
        });
      }
      await this.bump(workspaceId, period, cost);
      await this.bumpWalletFunded(workspaceId, period, cost);
      return;
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
        // Record the paid portion separately so refund() can hand back exactly
        // what the wallet gave up — see AI_CREDITS_WALLET_METRIC.
        await tx.usageCounter.upsert({
          where: {
            workspaceId_metric_periodKey: {
              workspaceId,
              metric: AI_CREDITS_WALLET_METRIC,
              periodKey: period,
            },
          },
          create: {
            workspaceId,
            metric: AI_CREDITS_WALLET_METRIC,
            periodKey: period,
            value: taken,
          },
          update: { value: { increment: taken } },
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
    // A refund must land on the period the RESERVE was made in. Keying purely
    // on "now" loses a reservation made at 23:55 on the last day of the month
    // whose call fails minutes later: the new period has no counter row, the
    // early return fires, and prepaid credits the customer paid cash for are
    // gone with no ledger entry explaining it.
    const period = (await this.periodHoldingCharge(workspaceId, cost)) ?? monthKey();
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
          const derived = Math.max(0, before - limit) - Math.max(0, next - limit);
          // Floor by what the wallet ACTUALLY funded. chargeOverage() pushes the
          // counter past the limit without taking anything from the wallet, so
          // the derivation alone would refund credits that were never debited.
          const fundedRow = await tx.usageCounter.findUnique({
            where: {
              workspaceId_metric_periodKey: {
                workspaceId,
                metric: AI_CREDITS_WALLET_METRIC,
                periodKey: period,
              },
            },
            select: { value: true },
          });
          walletBack = Math.max(0, Math.min(derived, fundedRow?.value ?? 0));
        }

        await tx.usageCounter.update({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: period } },
          data: { value: next },
        });

        if (walletBack > 0) {
          await tx.usageCounter.update({
            where: {
              workspaceId_metric_periodKey: {
                workspaceId,
                metric: AI_CREDITS_WALLET_METRIC,
                periodKey: period,
              },
            },
            data: { value: { decrement: walletBack } },
          });
        }

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

  /** The UTC month whose meter still holds this charge — current month if it
   *  has one, else the previous month (a reserve that straddled the rollover). */
  private async periodHoldingCharge(workspaceId: string, cost: number): Promise<string | null> {
    const now = monthKey();
    const current = await this.prisma.usageCounter.findUnique({
      where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: now } },
      select: { value: true },
    });
    if ((current?.value ?? 0) >= cost) return now;

    const d = new Date();
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const previous = await this.prisma.usageCounter.findUnique({
      where: { workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_METRIC, periodKey: prev } },
      select: { value: true },
    });
    if ((previous?.value ?? 0) >= cost) return prev;
    return current ? now : null;
  }

  private async bumpWalletFunded(workspaceId: string, periodKey: string, delta: number): Promise<void> {
    await this.prisma.usageCounter.upsert({
      where: {
        workspaceId_metric_periodKey: { workspaceId, metric: AI_CREDITS_WALLET_METRIC, periodKey },
      },
      create: { workspaceId, metric: AI_CREDITS_WALLET_METRIC, periodKey, value: Math.max(0, delta) },
      update: { value: { increment: delta } },
    });
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
