import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BudgetPerformanceSource } from './budget-performance.source';
import { allocate as allocateMarginal, AllocationPlan } from './marginal-allocator.util';
import { allocateBandit } from './bandit-allocator.util';
import { allocate as allocateMmm } from './mmm-allocator.util';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { BudgetExecutorService } from './budget-executor.service';
import { GrowthWalletService } from '../wallet/growth-wallet.service';
import { SpendLedgerService } from '../wallet/spend-ledger.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface ProposeResult {
  runId: string;
  status: 'PROPOSED' | 'SKIPPED';
  reason?: string;
  plan?: AllocationPlan;
  approvalId?: string;
  /** True when the AUTONOMOUS lane applied this plan (no approval involved). */
  autoApplied?: boolean;
}

const DEFAULT_APPLY_COOLDOWN_HOURS = 6;
/** How long an ASSISTED reallocation proposal stays approvable — the amounts
 *  are computed from tick-time performance data and go stale. */
const PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000;

function applyCooldownHours(): number {
  const raw = Number(process.env.GROWTH_AUTOPILOT_APPLY_COOLDOWN_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_APPLY_COOLDOWN_HOURS;
}

/**
 * Budget Autopilot orchestrator (Growth Autopilot spec D5/D6/D8). Reads a
 * workspace's GrowthBudget + allocations, gathers the performance signal, runs
 * the stage-selected allocator, records the proposal as an AutopilotRun, and
 * then branches on the budget's autonomy lane:
 *   - SHADOW      → record only (observation mode, no approvals, no writes)
 *   - ASSISTED    → record + enqueue a human approval (the pre-autopilot flow)
 *   - AUTONOMOUS  → record + auto-apply via the executor under MACHINE
 *                   guardrails (env flag + ACTIVE + kill-switch re-check +
 *                   apply cooldown). NO ApprovalRequest is ever created.
 * In the AUTONOMOUS lane the allocator pool is bounded by funded credit —
 * min(cap, governorDebited + wallet balance), an identity that equals the
 * credit actually loaded (audit B1) — and the lane is period-locked to the
 * budget whose periodKey is the current month (audit B2), so the engine can
 * never plan beyond the money the user actually loaded nor double-count the
 * workspace-shared wallet across co-active budgets. A killed/paused budget is
 * skipped.
 */
@Injectable()
export class BudgetAutopilotService {
  private readonly logger = new Logger(BudgetAutopilotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perf: BudgetPerformanceSource,
    private readonly approvals: ApprovalRequestService,
    private readonly executor: BudgetExecutorService,
    private readonly wallet: GrowthWalletService,
    private readonly ledger: SpendLedgerService,
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

    const level = (budget as { autonomyLevel?: string }).autonomyLevel ?? 'ASSISTED';
    // Period lock (audit B2): the workspace-shared wallet must fund only ONE
    // autonomous budget — the CURRENT period's. A stale-period budget left
    // ACTIVE would independently count the full shared balance and multiply
    // the committed pool; it falls to the ASSISTED human gate instead.
    const currentPeriod = now.toISOString().slice(0, 7);
    const autonomous =
      level === 'AUTONOMOUS' &&
      growthAutopilotAutonomyEnabled() &&
      budget.periodKey === currentPeriod;

    // D5 — funded-credit bound (audit B1). Only the armed autonomous lane
    // consults the wallet; SHADOW/ASSISTED keep the user cap exactly as before
    // (no behavior change while the feature ships dark). The "spent" term is
    // governorDebited — what the wallet ACTUALLY funded (clamped at the
    // balance floor) — so governorDebited + balance == credit loaded holds
    // exactly and the pool can never exceed the money the user put in. Raw
    // ledger netSpent keeps climbing with real ad spend after the wallet
    // floors at 0 and would self-reinforcingly ratchet the ceiling to the cap.
    let totalBudget = budget.totalAmount.toNumber();
    if (autonomous) {
      const [balance, funded] = await Promise.all([
        this.wallet.balance(workspaceId),
        this.wallet.governorDebited(workspaceId),
      ]);
      totalBudget = Math.min(totalBudget, funded.toNumber() + balance.toNumber());
    }

    const perf = await this.perf.collect(workspaceId, budget.allocations, now);
    const params = {
      totalBudget,
      explorationPct: budget.explorationPct,
      maxStepPct: 20,
      targetRoas: budget.targetRoas ? budget.targetRoas.toNumber() : undefined,
    };
    // Stage selector (Faz 7): Stage-1 marginal-ROAS (default), Stage-2 Thompson
    // bandit (explores under uncertainty), Stage-3 MMM-lite (diminishing-returns
    // water-fill). All share the same guardrailed AllocationPlan contract.
    const plan: AllocationPlan =
      budget.allocatorStage === 'BANDIT'
        ? allocateBandit(perf, params)
        : budget.allocatorStage === 'MMM'
          ? allocateMmm(perf, params)
          : allocateMarginal(perf, params);

    const objective = {
      totalBudget: plan.totalBudget,
      pool: plan.pool,
      reserve: plan.reserve,
      channels: plan.allocations.map((a) => ({ channel: a.channel, marginalRoas: a.marginalRoas, avgRoas: a.avgRoas })),
    };
    const before = plan.allocations.map((a) => ({ channel: a.channel, campaignRef: a.campaignRef, budget: a.before }));
    const after = plan.allocations.map((a) => ({ channel: a.channel, campaignRef: a.campaignRef, budget: a.after, deltaPct: a.deltaPct, reason: a.reason }));

    const run = await this.record(workspaceId, budgetId, { objective, before }, { after }, 'PROPOSED');

    if (plan.noop) return { runId: run.id, status: 'PROPOSED', plan };

    if (autonomous) {
      // AUTONOMOUS lane: machine guardrails replace the human gate. The apply
      // cooldown (D8) caps reallocation velocity — combined with the
      // allocator's maxStepPct this bounds worst-case movement per channel.
      const cooldownMs = applyCooldownHours() * 3_600_000;
      const recentAuto = cooldownMs > 0
        ? await this.prisma.autopilotRun.findFirst({
            where: {
              workspaceId,
              budgetId,
              autonomy: 'AUTO',
              ok: true,
              createdAt: { gte: new Date(now.getTime() - cooldownMs) },
            },
            select: { id: true },
          })
        : null;
      if (recentAuto) {
        return { runId: run.id, status: 'PROPOSED', plan, autoApplied: false };
      }
      try {
        await this.executor.applyAutonomous(workspaceId, budgetId, after, run.id);
        return { runId: run.id, status: 'PROPOSED', plan, autoApplied: true };
      } catch (e) {
        // The proposal record stands; the apply gate refused (e.g. kill-switch
        // flipped mid-tick) or the write failed. Never falls back to a human
        // prompt — the next tick simply re-evaluates.
        this.logger.warn(`autonomous apply skipped for budget ${budgetId}: ${(e as Error)?.message ?? e}`);
        return { runId: run.id, status: 'PROPOSED', plan, autoApplied: false };
      }
    }

    if (level === 'SHADOW') {
      // Pure observation: record the would-be move, touch nothing else.
      return { runId: run.id, status: 'PROPOSED', plan };
    }

    // ASSISTED (default, and AUTONOMOUS while the env flag is off): a material
    // reallocation enqueues a human approval — the pre-autopilot bridge to
    // execution. Nothing moves until an OWNER/MANAGER approves.
    // A NEWER proposal for the same budget supersedes any still-PENDING older
    // one: each proposal's amounts are computed from that tick's performance
    // data, so approving a stale card would commit + live-push OUTDATED
    // numbers. The new request also carries an expiry for the same reason.
    await this.prisma.approvalRequest.updateMany({
      where: { workspaceId, kind: 'BUDGET_REALLOCATION', status: 'PENDING', resourceId: budgetId },
      data: { status: 'EXPIRED' },
    });
    const req = await this.approvals.enqueue(workspaceId, {
      kind: 'BUDGET_REALLOCATION',
      summary: `Reallocate ${plan.allocations.filter((a) => Math.abs(a.after - a.before) >= 0.01).length} channel(s) within budget pool ${plan.pool}`,
      payload: { budgetId, runId: run.id, after },
      resourceType: 'growth_budget',
      resourceId: budgetId,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    });
    return { runId: run.id, status: 'PROPOSED', plan, approvalId: req.id };
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
