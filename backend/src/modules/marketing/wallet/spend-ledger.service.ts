import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

export type SpendChannel =
  | 'META'
  | 'TIKTOK'
  | 'GOOGLE'
  | 'LINKEDIN'
  | 'CONTENT'
  | 'SMS'
  | 'VOICE'
  | 'WHATSAPP'
  | 'RESEARCH';

export type SpendReason =
  | 'AD_WRITE'
  | 'AD_SPEND' // daily AdMetric mirror (Growth Autopilot D3)
  | 'SMS'
  | 'VOICE'
  | 'WHATSAPP'
  | 'CONTENT_GEN'
  | 'RESEARCH'
  | 'REFUND'
  | 'ADJUST';

export interface SpendEntry {
  channel: SpendChannel;
  /** Positive money amount; `debit` records it as a negative delta. */
  amount: number | Prisma.Decimal;
  reason: SpendReason;
  ref?: string | null;
  budgetId?: string | null;
  unitCost?: number | Prisma.Decimal | null;
  quantity?: number | Prisma.Decimal | null;
}

export interface LedgerResult {
  id: string;
  balanceAfter: Prisma.Decimal;
}

export interface DedupLedgerResult extends LedgerResult {
  /** True when the ref had already been recorded in this partition — no new row. */
  replayed: boolean;
}

/**
 * Append-only, tenant-scoped money ledger for the Budget Autopilot. Mirrors the
 * ai-credits reserve pattern: a per-(workspace,budget) advisory xact-lock
 * serializes the read-modify-write so concurrent debits can't corrupt the
 * running balance. Sign convention: `delta` < 0 is spend, > 0 is a refund/credit;
 * `balanceAfter` is the cumulative signed total, so `netSpent = -balanceAfter`.
 */
@Injectable()
export class SpendLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a spend (amount > 0 becomes a negative delta). */
  debit(workspaceId: string, entry: SpendEntry): Promise<LedgerResult> {
    return this.record(workspaceId, entry, -1);
  }

  /** Record a refund/credit (amount > 0 becomes a positive delta). */
  credit(workspaceId: string, entry: SpendEntry): Promise<LedgerResult> {
    return this.record(workspaceId, { ...entry, reason: 'REFUND' }, +1);
  }

  /**
   * Ref-deduped debit (Growth Autopilot D3 ad-spend mirror). Inside the SAME
   * advisory-locked transaction as a normal debit: if an entry with this ref
   * already exists in the (workspace, budget) partition it is returned with
   * `replayed: true` and NOTHING is recorded — so a re-run of the daily mirror
   * can never double-count a (campaign, day)'s spend.
   */
  async debitOnce(workspaceId: string, entry: SpendEntry): Promise<DedupLedgerResult> {
    const ref = entry.ref;
    if (!ref) throw new BadRequestException('debitOnce requires an idempotency ref');
    const amount = new Prisma.Decimal(entry.amount).abs();
    const budgetId = entry.budgetId ?? null;

    return this.prisma.$transaction(async (tx) => {
      await this.lockPartition(tx, workspaceId, budgetId);
      const existing = await tx.spendLedger.findFirst({
        where: { workspaceId, budgetId, ref },
        orderBy: { createdAt: 'desc' },
        select: { id: true, balanceAfter: true },
      });
      if (existing) return { id: existing.id, balanceAfter: existing.balanceAfter, replayed: true };
      const row = await this.append(tx, workspaceId, budgetId, entry, amount.negated());
      return { ...row, replayed: false };
    });
  }

  private async record(workspaceId: string, entry: SpendEntry, sign: 1 | -1): Promise<LedgerResult> {
    const amount = new Prisma.Decimal(entry.amount).abs();
    const delta = sign < 0 ? amount.negated() : amount;
    const budgetId = entry.budgetId ?? null;

    return this.prisma.$transaction(async (tx) => {
      await this.lockPartition(tx, workspaceId, budgetId);
      return this.append(tx, workspaceId, budgetId, entry, delta);
    });
  }

  /** Take the per-(workspace,budget) advisory xact-lock that serializes appends. */
  private async lockPartition(tx: Prisma.TransactionClient, workspaceId: string, budgetId: string | null): Promise<void> {
    const lockKey = `spend-ledger:${workspaceId}:${budgetId ?? 'none'}`;
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey(lockKey)}))::text AS locked`,
    );
  }

  /** Append one signed entry, carrying the running balance forward. Lock must be held. */
  private async append(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    budgetId: string | null,
    entry: SpendEntry,
    delta: Prisma.Decimal,
  ): Promise<LedgerResult> {
    const last = await tx.spendLedger.findFirst({
      where: { workspaceId, budgetId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    const prev = last?.balanceAfter ?? new Prisma.Decimal(0);
    const balanceAfter = prev.add(delta);
    const row = await tx.spendLedger.create({
      data: {
        workspaceId,
        budgetId,
        channel: entry.channel,
        delta,
        reason: entry.reason,
        ref: entry.ref ?? null,
        unitCost: entry.unitCost != null ? new Prisma.Decimal(entry.unitCost) : null,
        quantity: entry.quantity != null ? new Prisma.Decimal(entry.quantity) : null,
        balanceAfter,
      },
      select: { id: true, balanceAfter: true },
    });
    return { id: row.id, balanceAfter: row.balanceAfter };
  }

  /** Cumulative signed balance for a (workspace, budget) partition. */
  async balance(workspaceId: string, budgetId: string | null = null): Promise<Prisma.Decimal> {
    const last = await this.prisma.spendLedger.findFirst({
      where: { workspaceId, budgetId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    return last?.balanceAfter ?? new Prisma.Decimal(0);
  }

  /** Net money spent this partition (refunds reduce it). Always ≥ 0 in practice. */
  async netSpent(workspaceId: string, budgetId: string | null = null): Promise<Prisma.Decimal> {
    return (await this.balance(workspaceId, budgetId)).negated();
  }
}
