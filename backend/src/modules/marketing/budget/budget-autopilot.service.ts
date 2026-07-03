import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BudgetPerformanceSource } from './budget-performance.source';
import { allocate, AllocationPlan } from './marginal-allocator.util';
import { ApprovalRequestService } from '../agents/approval-request.service';

export interface ProposeResult {
  runId: string;
  status: 'PROPOSED' | 'SKIPPED';
  reason?: string;
  plan?: AllocationPlan;
  approvalId?: string;
}

/**
 * Budget Autopilot orchestrator — SHADOW stage (Faz 7, the design's safe first
 * step). It reads a workspace's GrowthBudget + allocations, gathers the
 * performance signal, runs the Stage-1 marginal-ROAS allocator, and records the
 * proposed reallocation as an AutopilotRun with autonomy='SHADOW'. It NEVER
 * writes to an ad platform or moves real money — the whole point is to build
 * trust with a dry-run before autonomy (and threshold-gated approval) is turned
 * on in a later slice. A killed/paused budget is skipped.
 */
@Injectable()
export class BudgetAutopilotService {
  private readonly logger = new Logger(BudgetAutopilotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perf: BudgetPerformanceSource,
    private readonly approvals: ApprovalRequestService,
  ) {}

  async propose(workspaceId: string, budgetId: string, now: Date = new Date()): Promise<ProposeResult> {
    const budget = await this.prisma.growthBudget.findFirst({
      where: { id: budgetId, workspaceId },
      include: { allocations: true },
    });
    if (!budget) throw new NotFoundException('Growth budget not found');

    if (budget.killSwitch || budget.status !== 'ACTIVE') {
      const run = await this.record(workspaceId, budgetId, null, null, 'SKIPPED');
      return { runId: run.id, status: 'SKIPPED', reason: budget.killSwitch ? 'kill-switch' : `status-${budget.status}` };
    }

    const perf = await this.perf.collect(workspaceId, budget.allocations, now);
    const plan = allocate(perf, {
      totalBudget: budget.totalAmount.toNumber(),
      explorationPct: budget.explorationPct,
      maxStepPct: 20,
      targetRoas: budget.targetRoas ? budget.targetRoas.toNumber() : undefined,
    });

    const objective = {
      totalBudget: plan.totalBudget,
      pool: plan.pool,
      reserve: plan.reserve,
      channels: plan.allocations.map((a) => ({ channel: a.channel, marginalRoas: a.marginalRoas, avgRoas: a.avgRoas })),
    };
    const before = plan.allocations.map((a) => ({ channel: a.channel, campaignRef: a.campaignRef, budget: a.before }));
    const after = plan.allocations.map((a) => ({ channel: a.channel, campaignRef: a.campaignRef, budget: a.after, deltaPct: a.deltaPct, reason: a.reason }));

    const run = await this.record(workspaceId, budgetId, { objective, before }, { after }, 'PROPOSED');

    // A material (non-noop) reallocation enqueues a human approval — the bridge
    // to execution. Nothing moves until an OWNER/MANAGER approves; the executor
    // (credential-gated live ad-write) applies the payload on approval.
    let approvalId: string | undefined;
    if (!plan.noop) {
      const moved = plan.allocations.filter((a) => Math.abs(a.after - a.before) >= 0.01);
      const req = await this.approvals.enqueue(workspaceId, {
        kind: 'BUDGET_REALLOCATION',
        summary: `Reallocate ${moved.length} channel(s) within budget pool ${plan.pool}`,
        payload: { budgetId, runId: run.id, after },
        resourceType: 'growth_budget',
        resourceId: budgetId,
      });
      approvalId = req.id;
    }
    return { runId: run.id, status: 'PROPOSED', plan, approvalId };
  }

  private record(
    workspaceId: string,
    budgetId: string,
    beforeBlock: { objective: unknown; before: unknown } | null,
    afterBlock: { after: unknown } | null,
    outcome: 'PROPOSED' | 'SKIPPED',
  ) {
    return this.prisma.autopilotRun.create({
      data: {
        workspaceId,
        budgetId,
        kind: 'REALLOCATION',
        autonomy: 'SHADOW',
        objective: (beforeBlock?.objective ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        before: (beforeBlock?.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        after: (afterBlock?.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        ok: outcome === 'PROPOSED',
      },
      select: { id: true },
    });
  }
}
