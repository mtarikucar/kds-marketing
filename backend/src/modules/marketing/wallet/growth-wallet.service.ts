import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type GrowthWalletKind = 'TOPUP' | 'ENGINE_SPEND' | 'AD_GOVERNOR' | 'REFUND' | 'ADJUST';

export interface GrowthWalletMovement {
  /** Positive money amount in the wallet currency (major units). */
  amount: number | Prisma.Decimal;
  kind: GrowthWalletKind;
  /** Globally-unique idempotency ref (e.g. order:{id}, admetric:{c}:{day}). */
  ref?: string | null;
  note?: string | null;
  /** Used only when the movement creates the wallet (first top-up). */
  currency?: string;
}

export interface GrowthWalletResult {
  wallet: { id: string; workspaceId: string; balance: Prisma.Decimal; currency: string };
  /** True when the unique `ref` had already been applied — nothing moved. */
  replayed: boolean;
}

export interface GrowthWalletDebitUpToResult extends GrowthWalletResult {
  /** What was actually debited (≤ the requested amount, ≥ 0). */
  debited: Prisma.Decimal;
  /** requested − debited (> 0 when the balance could not cover the request). */
  shortfall: Prisma.Decimal;
}

/** Fail-closed guard: the growth wallet can NEVER go negative. */
export class InsufficientGrowthCreditError extends BadRequestException {
  constructor(message = 'Insufficient growth credit') {
    super({ message, code: 'GROWTH_WALLET_INSUFFICIENT' });
  }
}

/**
 * Prepaid growth credit (Growth Autopilot, spec D1/D4). One wallet per
 * workspace. Every movement writes the cached balance AND an append-only
 * ledger entry in the SAME transaction; a debit uses a conditional updateMany
 * (balance >= amount) so it is race-safe and the balance can never go
 * negative. Movements carrying a `ref` are idempotent: the ledger's unique
 * index arbitrates races, and a replay (pre-checked or P2002) is a no-op that
 * reports `replayed: true`. Workspace-scoped throughout.
 */
@Injectable()
export class GrowthWalletService {
  constructor(private readonly prisma: PrismaService) {}

  /** Wallet for a workspace, or a zero-balance shell (`exists: false`). */
  async get(workspaceId: string) {
    const wallet = await this.prisma.growthWallet.findUnique({ where: { workspaceId } });
    if (!wallet) {
      return { workspaceId, balance: new Prisma.Decimal(0), currency: 'TRY', exists: false as const };
    }
    return { ...wallet, exists: true as const };
  }

  /** Current balance (0 when no wallet). */
  async balance(workspaceId: string): Promise<Prisma.Decimal> {
    const wallet = await this.prisma.growthWallet.findUnique({ where: { workspaceId } });
    return wallet?.balance ?? new Prisma.Decimal(0);
  }

  /**
   * Cumulative AD_GOVERNOR total actually taken from the wallet (≥ 0). This is
   * the identity-preserving "spent" term for the autonomous pool bound (audit
   * B1): because governor debits are clamped at the balance floor,
   * governorDebited + balance can never exceed the credit actually loaded —
   * unlike raw SpendLedger netSpent, which keeps climbing with real ad spend
   * after the wallet floors at 0 and would ratchet the ceiling toward the cap.
   */
  async governorDebited(workspaceId: string): Promise<Prisma.Decimal> {
    const agg = await this.prisma.growthWalletLedgerEntry.aggregate({
      where: { workspaceId, kind: 'AD_GOVERNOR' },
      _sum: { delta: true },
    });
    const sum = agg._sum.delta ?? new Prisma.Decimal(0);
    return new Prisma.Decimal(sum).negated(); // debits are negative deltas
  }

  /** Add credit (top-up / refund / adjust). Creates the wallet on first use. */
  credit(workspaceId: string, movement: GrowthWalletMovement): Promise<GrowthWalletResult> {
    return this.move(workspaceId, movement, +1);
  }

  /** Draw down credit. Fail-closed: throws InsufficientGrowthCreditError. */
  debit(workspaceId: string, movement: GrowthWalletMovement): Promise<GrowthWalletResult> {
    return this.move(workspaceId, movement, -1);
  }

  /**
   * Clamped governor debit (spec D3): debits min(balance, amount) and NEVER
   * throws on a shortfall — the ad-spend mirror is bookkeeping, so a partial
   * (or even 0-delta) ledger entry is always written under the ref to keep
   * replays idempotent. A shortfall is recorded in the note. The balance still
   * can never go negative (same conditional-updateMany arbiter as `debit`).
   */
  async debitUpTo(workspaceId: string, movement: GrowthWalletMovement): Promise<GrowthWalletDebitUpToResult> {
    const amount = new Prisma.Decimal(movement.amount).toDecimalPlaces(2);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new BadRequestException('Invalid growth wallet amount');
    }
    const ref = movement.ref ?? null;

    if (ref) {
      const existing = await this.prisma.growthWalletLedgerEntry.findUnique({ where: { ref } });
      if (existing) return this.replayUpToResult(workspaceId, amount, existing);
    }

    try {
      const { wallet, debited } = await this.prisma.$transaction(async (tx) => {
        const w = await tx.growthWallet.upsert({
          where: { workspaceId },
          create: { workspaceId, currency: movement.currency ?? 'TRY' },
          update: {},
        });
        this.assertCurrencyMatches(w.currency, movement.currency);
        const balance = new Prisma.Decimal(w.balance ?? 0);
        let taken = balance.lt(amount) ? balance : amount;
        if (taken.gt(0)) {
          const res = await tx.growthWallet.updateMany({
            where: { id: w.id, workspaceId, balance: { gte: taken } },
            data: { balance: { increment: taken.negated() } },
          });
          // Raced to a lower balance between read and decrement: fall back to a
          // 0-delta anchor entry (never negative, ref still consumed).
          if (res.count === 0) taken = new Prisma.Decimal(0);
        }
        const fresh = await tx.growthWallet.findUnique({ where: { workspaceId } });
        const short = amount.minus(taken);
        const shortNote = short.gt(0)
          ? `governor shortfall: requested ${amount.toFixed(2)}, debited ${taken.toFixed(2)}`
          : null;
        const note = [movement.note, shortNote].filter(Boolean).join(' | ') || null;
        await tx.growthWalletLedgerEntry.create({
          data: {
            workspaceId,
            walletId: w.id,
            delta: taken.isZero() ? new Prisma.Decimal(0) : taken.negated(),
            balanceAfter: fresh!.balance,
            kind: movement.kind,
            ref,
            note,
          },
        });
        return { wallet: fresh!, debited: taken };
      });
      return { wallet, replayed: false, debited, shortfall: amount.minus(debited) };
    } catch (e) {
      if (ref && (e as { code?: string })?.code === 'P2002') {
        const existing = await this.prisma.growthWalletLedgerEntry.findUnique({ where: { ref } });
        return this.replayUpToResult(workspaceId, amount, existing);
      }
      throw e;
    }
  }

  /**
   * Governor debit tracking a GROWING day-cumulative (audit B3+B4). The
   * ad-spend day row is overwritten by every hourly pull, so the governor must
   * take only what it has not yet taken under the ref prefix — derived from
   * the wallet's OWN ledger, so a debit missed by a crash between the
   * spend-ledger commit and the wallet write self-heals on the next tick
   * (fixing the permanent divergence of the replay-gated design). Refs are
   * `{prefix}:c{cumulative}`; legacy exact-`{prefix}` entries count toward the
   * taken total; still clamped ≥ 0 with the shortfall reported, never thrown.
   */
  async debitUpToCumulative(
    workspaceId: string,
    movement: Omit<GrowthWalletMovement, 'amount' | 'ref'>,
    refPrefix: string,
    cumulative: number | Prisma.Decimal,
  ): Promise<GrowthWalletDebitUpToResult> {
    if (!refPrefix) throw new BadRequestException('debitUpToCumulative requires a ref prefix');
    const target = new Prisma.Decimal(cumulative).abs().toDecimalPlaces(2);

    try {
      const { wallet, debited, shortfall } = await this.prisma.$transaction(async (tx) => {
        const w = await tx.growthWallet.upsert({
          where: { workspaceId },
          create: { workspaceId, currency: movement.currency ?? 'TRY' },
          update: {},
        });
        this.assertCurrencyMatches(w.currency, movement.currency);

        const prior = await tx.growthWalletLedgerEntry.findMany({
          where: {
            workspaceId,
            OR: [{ ref: refPrefix }, { ref: { startsWith: `${refPrefix}:c` } }],
          },
          select: { delta: true },
        });
        const alreadyTaken = prior.reduce(
          (sum, e) => sum.add(new Prisma.Decimal(e.delta).negated()),
          new Prisma.Decimal(0),
        );
        const inc = target.minus(alreadyTaken);
        if (inc.lte(0)) {
          return { wallet: w, debited: null as Prisma.Decimal | null, shortfall: new Prisma.Decimal(0) };
        }

        const balance = new Prisma.Decimal(w.balance ?? 0);
        let taken = balance.lt(inc) ? balance : inc;
        if (taken.gt(0)) {
          const res = await tx.growthWallet.updateMany({
            where: { id: w.id, workspaceId, balance: { gte: taken } },
            data: { balance: { increment: taken.negated() } },
          });
          if (res.count === 0) taken = new Prisma.Decimal(0);
        }
        const fresh = await tx.growthWallet.findUnique({ where: { workspaceId } });
        const short = inc.minus(taken);
        const shortNote = short.gt(0)
          ? `governor shortfall: cumulative ${target.toFixed(2)}, taken so far ${alreadyTaken.add(taken).toFixed(2)}`
          : null;
        const note = [movement.note, shortNote].filter(Boolean).join(' | ') || null;
        await tx.growthWalletLedgerEntry.create({
          data: {
            workspaceId,
            walletId: w.id,
            delta: taken.isZero() ? new Prisma.Decimal(0) : taken.negated(),
            balanceAfter: fresh!.balance,
            kind: movement.kind,
            ref: `${refPrefix}:c${target.toString()}`,
            note,
          },
        });
        return { wallet: fresh!, debited: taken, shortfall: short };
      });
      if (debited === null) {
        // Cumulative already fully mirrored — a replay, nothing moved.
        return { wallet, replayed: true, debited: new Prisma.Decimal(0), shortfall: new Prisma.Decimal(0) };
      }
      return { wallet, replayed: false, debited, shortfall };
    } catch (e) {
      // Same-snapshot race: another tick already wrote `{prefix}:c{target}` —
      // its write covered this cumulative; report the replay.
      if ((e as { code?: string })?.code === 'P2002') {
        const base = await this.replayResult(workspaceId);
        return { ...base, debited: new Prisma.Decimal(0), shortfall: new Prisma.Decimal(0) };
      }
      throw e;
    }
  }

  private async replayUpToResult(
    workspaceId: string,
    amount: Prisma.Decimal,
    existing: { delta: Prisma.Decimal } | null,
  ): Promise<GrowthWalletDebitUpToResult> {
    const base = await this.replayResult(workspaceId);
    const debited = existing ? new Prisma.Decimal(existing.delta).negated() : new Prisma.Decimal(0);
    return { ...base, debited, shortfall: amount.minus(debited) };
  }

  private async move(
    workspaceId: string,
    movement: GrowthWalletMovement,
    sign: 1 | -1,
  ): Promise<GrowthWalletResult> {
    const amount = new Prisma.Decimal(movement.amount).toDecimalPlaces(2);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new BadRequestException('Invalid growth wallet amount');
    }
    const ref = movement.ref ?? null;

    // Fast-path idempotency: an already-applied ref is a replay, nothing moves.
    if (ref) {
      const existing = await this.prisma.growthWalletLedgerEntry.findUnique({ where: { ref } });
      if (existing) return this.replayResult(workspaceId);
    }

    const delta = sign < 0 ? amount.negated() : amount;
    try {
      const wallet = await this.prisma.$transaction(async (tx) => {
        const w = await tx.growthWallet.upsert({
          where: { workspaceId },
          create: { workspaceId, currency: movement.currency ?? 'TRY' },
          update: {},
        });
        this.assertCurrencyMatches(w.currency, movement.currency);
        if (sign < 0) {
          // Conditional decrement — the race-safe never-negative arbiter.
          const res = await tx.growthWallet.updateMany({
            where: { id: w.id, workspaceId, balance: { gte: amount } },
            data: { balance: { increment: delta } },
          });
          if (res.count === 0) throw new InsufficientGrowthCreditError();
        } else {
          await tx.growthWallet.update({
            where: { id: w.id },
            data: { balance: { increment: delta } },
          });
        }
        const fresh = await tx.growthWallet.findUnique({ where: { workspaceId } });
        await tx.growthWalletLedgerEntry.create({
          data: {
            workspaceId,
            walletId: w.id,
            delta,
            balanceAfter: fresh!.balance,
            kind: movement.kind,
            ref,
            note: movement.note ?? null,
          },
        });
        return fresh!;
      });
      return { wallet, replayed: false };
    } catch (e) {
      // Unique-ref race: another writer applied this movement first. The whole
      // transaction rolled back (no double debit/credit) — report the replay.
      if (ref && (e as { code?: string })?.code === 'P2002') {
        return this.replayResult(workspaceId);
      }
      throw e;
    }
  }

  /**
   * No-FX invariant (audit A2): the wallet stores ONE currency and there is no
   * conversion anywhere in the system, so a movement declaring a different
   * currency must be rejected — crediting a TRY amount onto a USD wallet at
   * face value would mint ~33x spendable value (and the inverse under-credits).
   * A movement that omits `currency` is taken to be in the wallet's currency.
   * Runs inside the movement transaction, so nothing is written on mismatch.
   */
  private assertCurrencyMatches(walletCurrency: string, movementCurrency?: string): void {
    if (movementCurrency && movementCurrency !== walletCurrency) {
      throw new BadRequestException(
        `Growth wallet currency mismatch: wallet is ${walletCurrency}, movement is ${movementCurrency}`,
      );
    }
  }

  private async replayResult(workspaceId: string): Promise<GrowthWalletResult> {
    const wallet = await this.prisma.growthWallet.findUnique({ where: { workspaceId } });
    if (!wallet) throw new BadRequestException('Growth wallet not found for replayed movement');
    return { wallet, replayed: true };
  }
}
