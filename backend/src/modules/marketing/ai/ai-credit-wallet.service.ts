import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The subset of the client both a PrismaService and an interactive-transaction
 * client satisfy. Callers that already hold a transaction MUST pass it, so the
 * wallet movement commits or rolls back with their work — a debit that commits
 * while its caller aborts silently destroys credit the customer paid for.
 */
type WalletTx = Prisma.TransactionClient;

export type AiCreditLedgerKind = 'TOPUP' | 'SPEND' | 'REFUND' | 'ADJUST' | 'GRANT';

export interface AiCreditMovement {
  amount: number; // always positive; direction comes from the method
  kind: AiCreditLedgerKind;
  /** Globally unique key. A replayed settlement webhook must credit ONCE. */
  ref?: string | null;
  note?: string | null;
}

/**
 * Prepaid AI credits — the balance a workspace tops up when its monthly
 * allowance runs out.
 *
 * The old `ai_credit_boost_500` add-on raised `limits.aiCreditsMonthly` for the
 * current subscription period, so credits a customer PAID for evaporated at
 * period end and never carried over. That is the wrong shape for a plan built
 * on modest included credits plus self-serve top-up: bought credits have to
 * behave like money.
 *
 * Mirrors GrowthWalletService's arbiter deliberately — the cached balance is
 * only ever mutated together with an append-only ledger entry, and a debit uses
 * a conditional `updateMany` (balance >= amount) so concurrent spends cannot
 * drive it negative. Integers throughout: there is no such thing as a third of
 * a credit.
 */
@Injectable()
export class AiCreditWalletService {
  private readonly logger = new Logger(AiCreditWalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  async balance(workspaceId: string): Promise<number> {
    const w = await this.prisma.aiCreditWallet.findUnique({
      where: { workspaceId },
      select: { balance: true },
    });
    return w?.balance ?? 0;
  }

  /** Add credits. Idempotent when `ref` is given. */
  async credit(workspaceId: string, movement: AiCreditMovement, tx?: WalletTx): Promise<number> {
    const amount = Math.trunc(movement.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Invalid AI credit amount');
    }
    const ref = movement.ref ?? null;

    if (ref) {
      const existing = await (tx ?? this.prisma).aiCreditLedgerEntry.findUnique({ where: { ref } });
      if (existing) return this.balance(workspaceId); // already applied
    }

    const run = async (tx: WalletTx): Promise<number> => {
      {
        const w = await tx.aiCreditWallet.upsert({
          where: { workspaceId },
          create: { workspaceId },
          update: {},
        });
        const updated = await tx.aiCreditWallet.update({
          where: { id: w.id },
          data: { balance: { increment: amount } },
        });
        await tx.aiCreditLedgerEntry.create({
          data: {
            workspaceId,
            walletId: w.id,
            delta: amount,
            balanceAfter: updated.balance,
            kind: movement.kind,
            ref,
            note: movement.note ?? null,
          },
        });
        return updated.balance;
      }
    };

    try {
      return tx ? await run(tx) : await this.prisma.$transaction(run);
    } catch (e) {
      // Lost a race on the unique ref — the other writer applied it.
      if (ref && (e as { code?: string })?.code === 'P2002') return this.balance(workspaceId);
      throw e;
    }
  }

  /**
   * Take up to `amount` credits, returning how many were actually taken.
   *
   * "Up to" rather than all-or-nothing because the caller has already decided
   * how much of a charge the monthly allowance covers; a partial wallet balance
   * still legitimately covers part of the rest, and the caller refuses the
   * action when the total falls short.
   */
  async debitUpTo(workspaceId: string, movement: AiCreditMovement, tx?: WalletTx): Promise<number> {
    const amount = Math.trunc(movement.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Invalid AI credit amount');
    }
    const ref = movement.ref ?? null;

    if (ref) {
      const existing = await (tx ?? this.prisma).aiCreditLedgerEntry.findUnique({ where: { ref } });
      if (existing) return Math.abs(existing.delta);
    }

    const run = async (tx: WalletTx): Promise<number> => {
      {
        const w = await tx.aiCreditWallet.upsert({
          where: { workspaceId },
          create: { workspaceId },
          update: {},
        });
        let taken = Math.min(w.balance, amount);
        if (taken > 0) {
          const res = await tx.aiCreditWallet.updateMany({
            where: { id: w.id, workspaceId, balance: { gte: taken } },
            data: { balance: { decrement: taken } },
          });
          // Raced to a lower balance between read and decrement — take nothing
          // rather than risk going negative.
          if (res.count === 0) taken = 0;
        }
        if (taken === 0 && !ref) return 0; // nothing moved and no ref to anchor

        const fresh = await tx.aiCreditWallet.findUnique({ where: { id: w.id } });
        await tx.aiCreditLedgerEntry.create({
          data: {
            workspaceId,
            walletId: w.id,
            delta: -taken,
            balanceAfter: fresh?.balance ?? 0,
            kind: movement.kind,
            ref,
            note: movement.note ?? null,
          },
        });
        return taken;
      }
    };

    try {
      return tx ? await run(tx) : await this.prisma.$transaction(run);
    } catch (e) {
      if (ref && (e as { code?: string })?.code === 'P2002') {
        const existing = await this.prisma.aiCreditLedgerEntry.findUnique({ where: { ref } });
        return existing ? Math.abs(existing.delta) : 0;
      }
      throw e;
    }
  }

  /** Recent ledger entries, newest first — what the billing page shows. */
  async recentEntries(workspaceId: string, take = 20) {
    return this.prisma.aiCreditLedgerEntry.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { delta: true, balanceAfter: true, kind: true, note: true, createdAt: true },
    });
  }
}
