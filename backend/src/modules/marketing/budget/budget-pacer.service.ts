import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { monthProgress, pace, PacerOutput } from './pacer.util';

/**
 * Runs the budget pacer for a growth budget: measures spend-to-date from the
 * SpendLedger, computes the ideal-curve error, and persists the PID controller
 * state (so the integral carries across ticks) plus the recommended daily cap
 * the allocator/executor should respect. Whole-budget pacing (channel '').
 */
@Injectable()
export class BudgetPacerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: SpendLedgerService,
  ) {}

  async tick(workspaceId: string, budgetId: string, now: Date = new Date()): Promise<PacerOutput> {
    const budget = await this.prisma.growthBudget.findFirst({
      where: { id: budgetId, workspaceId },
      select: { totalAmount: true, periodKey: true },
    });
    if (!budget) throw new NotFoundException('Growth budget not found');

    const spentToDate = (await this.ledger.netSpent(workspaceId, budgetId)).toNumber();
    const prev = await this.prisma.pacingState.findUnique({
      where: { budgetId_channel: { budgetId, channel: '' } },
      select: { pidIntegral: true, pidLastError: true },
    });
    const { elapsedFraction, remainingDays } = monthProgress(budget.periodKey, now);

    const out = pace({
      totalBudget: budget.totalAmount.toNumber(),
      spentToDate,
      elapsedFraction,
      remainingDays,
      prevIntegral: prev?.pidIntegral.toNumber(),
      prevError: prev?.pidLastError.toNumber(),
    });

    const data = {
      spentToDate: new Prisma.Decimal(spentToDate),
      idealToDate: new Prisma.Decimal(out.idealToDate),
      pidIntegral: new Prisma.Decimal(out.integral),
      pidLastError: new Prisma.Decimal(out.error),
      recommendedDailyCap: new Prisma.Decimal(out.recommendedDailyCap),
      status: out.status,
      lastPacedAt: now,
    };
    await this.prisma.pacingState.upsert({
      where: { budgetId_channel: { budgetId, channel: '' } },
      create: { workspaceId, budgetId, channel: '', ...data },
      update: data,
    });
    return out;
  }
}
