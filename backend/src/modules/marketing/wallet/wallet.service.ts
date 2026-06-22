import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PG_INT_MAX } from '../invoicing/money.util';

export type WalletReason = 'CREDIT' | 'DEBIT' | 'REFUND' | 'MANUAL_ADJUST';

/**
 * Customer store-credit wallet (GoHighLevel parity). One wallet per (workspace,
 * lead). Every movement is an append-only ledger entry written in the SAME
 * transaction that adjusts the cached `balance`; a debit uses a conditional
 * updateMany (balance ≥ amount) so it is race-safe and the balance can never go
 * negative. Workspace-scoped throughout.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /** Wallet + recent ledger for a workspace lead (0-balance shell if none yet). */
  async getWallet(workspaceId: string, leadId: string) {
    await this.assertLead(workspaceId, leadId);
    const wallet = await this.prisma.customerWallet.findUnique({
      where: { workspaceId_leadId: { workspaceId, leadId } },
    });
    if (!wallet) return { leadId, balance: 0, currency: 'TRY', ledger: [] as unknown[] };
    const ledger = await this.prisma.walletLedgerEntry.findMany({
      where: { workspaceId, walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ...wallet, ledger };
  }

  credit(workspaceId: string, leadId: string, amount: number, note?: string, reason: WalletReason = 'CREDIT') {
    return this.apply(workspaceId, leadId, Math.abs(Math.round(amount)), reason, { note });
  }

  debit(
    workspaceId: string,
    leadId: string,
    amount: number,
    note?: string,
    opts: { reason?: WalletReason; invoiceId?: string; tx?: Prisma.TransactionClient } = {},
  ) {
    return this.apply(workspaceId, leadId, -Math.abs(Math.round(amount)), opts.reason ?? 'DEBIT', {
      note,
      invoiceId: opts.invoiceId,
      tx: opts.tx,
    });
  }

  /**
   * Core movement. `delta` signed (credit > 0, debit < 0). A debit only succeeds
   * when the balance covers it (conditional update → no negative, no lost update).
   * Accepts an optional `tx` so a caller (e.g. pay-with-wallet) can run the debit
   * in the SAME transaction as its own writes — making the cross-aggregate money
   * operation atomic.
   */
  async apply(
    workspaceId: string,
    leadId: string,
    delta: number,
    reason: WalletReason,
    opts: { note?: string; invoiceId?: string; currency?: string; tx?: Prisma.TransactionClient } = {},
  ) {
    if (!Number.isInteger(delta) || delta === 0) throw new BadRequestException('Invalid amount');
    await this.assertLead(workspaceId, leadId);
    const run = async (tx: Prisma.TransactionClient) => {
      const wallet = await tx.customerWallet.upsert({
        where: { workspaceId_leadId: { workspaceId, leadId } },
        create: { workspaceId, leadId, balance: 0, currency: opts.currency ?? 'TRY' },
        update: {},
      });
      if (delta < 0) {
        const res = await tx.customerWallet.updateMany({
          where: { id: wallet.id, workspaceId, balance: { gte: -delta } },
          data: { balance: { increment: delta } },
        });
        if (res.count === 0) throw new BadRequestException('Insufficient wallet balance');
      } else {
        // Reject a credit that would overflow the int4 balance column.
        if (wallet.balance + delta > PG_INT_MAX) {
          throw new BadRequestException('Wallet balance would exceed the maximum');
        }
        await tx.customerWallet.update({ where: { id: wallet.id }, data: { balance: { increment: delta } } });
      }
      await tx.walletLedgerEntry.create({
        data: {
          workspaceId,
          walletId: wallet.id,
          delta,
          reason,
          invoiceId: opts.invoiceId ?? null,
          note: opts.note ?? null,
        },
      });
      return tx.customerWallet.findUnique({ where: { id: wallet.id } });
    };
    return opts.tx ? run(opts.tx) : this.prisma.$transaction(run);
  }

  private async assertLead(workspaceId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, workspaceId }, select: { id: true } });
    if (!lead) throw new NotFoundException('Contact not found');
  }
}
