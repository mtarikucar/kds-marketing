import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface UpsertBudgetInput {
  periodKey: string; // YYYY-MM
  totalAmount: number;
  currency?: string;
  scope?: 'HOLISTIC' | 'AD_ONLY';
  explorationPct?: number;
  targetRoas?: number | null;
  targetCac?: number | null;
}

export interface UpsertAllocationInput {
  channel: string;
  campaignRef?: string;
  plannedAmount: number;
  minBudget?: number | null;
  maxBudget?: number | null;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCOPES = ['HOLISTIC', 'AD_ONLY'];
const STATUSES = ['ACTIVE', 'PAUSED', 'KILLED'];
const CHANNELS = ['META', 'TIKTOK', 'GOOGLE', 'LINKEDIN', 'CONTENT', 'SMS', 'VOICE', 'WHATSAPP'];

/**
 * CRUD for the Budget Autopilot's growth budget + allocations. Pure data +
 * validation; the allocation/execution logic lives in BudgetAutopilotService.
 * All reads/writes are workspace-scoped (multi-tenant isolation).
 */
@Injectable()
export class BudgetManagementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create or update the workspace's budget for a month (unique per period). */
  async upsertBudget(workspaceId: string, input: UpsertBudgetInput) {
    if (!PERIOD_RE.test(input.periodKey)) throw new BadRequestException('periodKey must be YYYY-MM');
    if (!(input.totalAmount >= 0)) throw new BadRequestException('totalAmount must be ≥ 0');
    if (input.scope && !SCOPES.includes(input.scope)) throw new BadRequestException('invalid scope');
    const explorationPct = input.explorationPct ?? 20;
    if (explorationPct < 0 || explorationPct > 90) throw new BadRequestException('explorationPct must be 0–90');

    const data = {
      totalAmount: new Prisma.Decimal(input.totalAmount),
      currency: input.currency ?? 'TRY',
      scope: input.scope ?? 'HOLISTIC',
      explorationPct,
      targetRoas: input.targetRoas != null ? new Prisma.Decimal(input.targetRoas) : null,
      targetCac: input.targetCac != null ? new Prisma.Decimal(input.targetCac) : null,
    };
    return this.prisma.growthBudget.upsert({
      where: { workspaceId_periodKey: { workspaceId, periodKey: input.periodKey } },
      create: { workspaceId, periodKey: input.periodKey, ...data },
      update: data,
    });
  }

  async get(workspaceId: string, id: string) {
    const budget = await this.prisma.growthBudget.findFirst({
      where: { id, workspaceId },
      include: { allocations: { orderBy: { channel: 'asc' } } },
    });
    if (!budget) throw new NotFoundException('Growth budget not found');
    return budget;
  }

  list(workspaceId: string) {
    return this.prisma.growthBudget.findMany({ where: { workspaceId }, orderBy: { periodKey: 'desc' } });
  }

  /** Flip the kill-switch (halts all autonomous spend instantly). */
  async setKillSwitch(workspaceId: string, id: string, on: boolean) {
    await this.assertOwned(workspaceId, id);
    return this.prisma.growthBudget.update({ where: { id }, data: { killSwitch: on } });
  }

  async setStatus(workspaceId: string, id: string, status: string) {
    if (!STATUSES.includes(status)) throw new BadRequestException('invalid status');
    await this.assertOwned(workspaceId, id);
    return this.prisma.growthBudget.update({ where: { id }, data: { status } });
  }

  /** Create/update one channel allocation (unique per budget+channel+campaign). */
  async upsertAllocation(workspaceId: string, budgetId: string, input: UpsertAllocationInput) {
    if (!CHANNELS.includes(input.channel)) throw new BadRequestException('invalid channel');
    if (!(input.plannedAmount >= 0)) throw new BadRequestException('plannedAmount must be ≥ 0');
    await this.assertOwned(workspaceId, budgetId);
    const campaignRef = input.campaignRef ?? '';
    const planned = new Prisma.Decimal(input.plannedAmount);
    return this.prisma.budgetAllocation.upsert({
      where: { budgetId_channel_campaignRef: { budgetId, channel: input.channel, campaignRef } },
      create: { workspaceId, budgetId, channel: input.channel, campaignRef, plannedAmount: planned },
      update: { plannedAmount: planned },
    });
  }

  listRuns(workspaceId: string, budgetId: string, take = 50) {
    return this.prisma.autopilotRun.findMany({
      where: { workspaceId, budgetId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  private async assertOwned(workspaceId: string, id: string): Promise<void> {
    const found = await this.prisma.growthBudget.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!found) throw new NotFoundException('Growth budget not found');
  }
}
