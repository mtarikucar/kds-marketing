import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { AdWriteCapabilityService } from '../ads/ad-write-capability.service';
import { AdManagementService } from '../ads/ad-management.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

interface AfterAllocation {
  channel: string;
  campaignRef?: string;
  budget: number;
  deltaPct?: number;
  reason?: string;
}
interface ChannelResult {
  channel: string;
  campaignRef: string;
  budget: number;
  applied: boolean;
  note: string;
}

export interface ApplyResult {
  /** APPLIED = at least one live ad-platform write; NO_LIVE_WRITE = plan committed
   *  internally but no platform push (no creds / read-only providers). */
  status: 'APPLIED' | 'NO_LIVE_WRITE' | 'ALREADY_APPLIED';
  runId?: string;
  applied: number;
  skipped: number;
  results: ChannelResult[];
}

/**
 * Budget executor — the propose → approve → EXECUTE capstone of the Budget
 * Autopilot. Given an APPROVED BUDGET_REALLOCATION approval it:
 *   (1) commits the approved per-channel amounts to the INTERNAL plan
 *       (BudgetAllocation.plannedAmount — this is what the pacer reads), and
 *   (2) pushes a live daily-budget change to any WRITE-CAPABLE ad platform.
 *
 * MONEY-SAFETY — a live platform write happens ONLY when ALL of:
 *   - a human already APPROVED the reallocation (status === 'APPROVED'),
 *   - the provider is write-capable with credentials present
 *     (AdWriteCapabilityService.canWriteBudget — today only Meta, cred-gated),
 *   - the allocation targets a concrete ad entity (campaignRef) with budget > 0.
 * With no credentials NOTHING is pushed to any platform; the internal plan still
 * reflects the approved decision and the run records exactly what was/wasn't
 * pushed. The underlying AdManagementService.setDailyBudget is itself validated.
 */
@Injectable()
export class BudgetExecutorService {
  private readonly logger = new Logger(BudgetExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRequestService,
    private readonly capability: AdWriteCapabilityService,
    private readonly ads: AdManagementService,
  ) {}

  async apply(workspaceId: string, approvalId: string, userId: string): Promise<ApplyResult> {
    const approval = await this.prisma.approvalRequest.findFirst({ where: { id: approvalId, workspaceId } });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.kind !== 'BUDGET_REALLOCATION') throw new BadRequestException('Not a budget reallocation request');
    if (approval.status === 'APPLIED') return { status: 'ALREADY_APPLIED', applied: 0, skipped: 0, results: [] };
    if (approval.status !== 'APPROVED') throw new BadRequestException(`Approve the request first (it is ${approval.status})`);

    const payload = (approval.payload ?? {}) as { budgetId?: string; runId?: string; after?: AfterAllocation[] };
    const budgetId = payload.budgetId;
    const after = Array.isArray(payload.after) ? payload.after : [];
    if (!budgetId || after.length === 0) throw new BadRequestException('Approval payload has no allocations');

    const budget = await this.prisma.growthBudget.findFirst({ where: { id: budgetId, workspaceId } });
    if (!budget) throw new NotFoundException('Growth budget not found');
    if (budget.killSwitch || budget.status !== 'ACTIVE') throw new BadRequestException('Budget is not active');

    const { results, applied, skipped } = await this.commitAndPush(workspaceId, budgetId, after);

    const run = await this.prisma.autopilotRun.create({
      data: {
        workspaceId,
        budgetId,
        kind: 'REALLOCATION',
        autonomy: 'APPROVED',
        approvalRequestId: approvalId,
        approvedBy: userId,
        objective: Prisma.JsonNull,
        before: Prisma.JsonNull,
        after: results as unknown as Prisma.InputJsonValue,
        ok: true,
      },
      select: { id: true },
    });

    // The decision is committed to the internal plan regardless of live write, so
    // the approval transitions to APPLIED. status distinguishes whether a real
    // ad-platform push happened.
    await this.approvals.markApplied(workspaceId, approvalId);
    if (applied === 0) {
      this.logger.log(`Budget reallocation ${approvalId} committed to plan; no live ad-platform write (no capability/creds).`);
    }
    return { status: applied > 0 ? 'APPLIED' : 'NO_LIVE_WRITE', runId: run.id, applied, skipped, results };
  }

  /**
   * AUTONOMOUS lane (Growth Autopilot spec D6/D8): applies an allocation plan
   * under MACHINE guardrails instead of a human approval. Gates re-verified
   * HERE at apply time — env flag armed, budget ACTIVE, kill-switch off,
   * budget explicitly armed AUTONOMOUS. Touches NOTHING in the approval
   * queue; the AutopilotRun (autonomy='AUTO') is the audit record. The live
   * ad-platform push keeps the exact same credential gate as the approved
   * path (commitAndPush).
   */
  async applyAutonomous(
    workspaceId: string,
    budgetId: string,
    after: AfterAllocation[],
    proposalRunId?: string,
  ): Promise<ApplyResult> {
    if (!growthAutopilotAutonomyEnabled()) {
      throw new BadRequestException('Autonomous budget execution is not enabled');
    }
    if (!Array.isArray(after) || after.length === 0) {
      throw new BadRequestException('Plan has no allocations');
    }
    const budget = await this.prisma.growthBudget.findFirst({ where: { id: budgetId, workspaceId } });
    if (!budget) throw new NotFoundException('Growth budget not found');
    if (budget.killSwitch || budget.status !== 'ACTIVE') {
      throw new BadRequestException('Budget is not active');
    }
    if ((budget as { autonomyLevel?: string }).autonomyLevel !== 'AUTONOMOUS') {
      throw new BadRequestException('Budget is not armed for autonomous execution');
    }

    const { results, applied, skipped } = await this.commitAndPush(workspaceId, budgetId, after);

    const run = await this.prisma.autopilotRun.create({
      data: {
        workspaceId,
        budgetId,
        kind: 'REALLOCATION',
        autonomy: 'AUTO',
        objective: (proposalRunId ? { proposalRunId } : Prisma.JsonNull) as Prisma.InputJsonValue,
        before: Prisma.JsonNull,
        after: results as unknown as Prisma.InputJsonValue,
        ok: true,
      },
      select: { id: true },
    });

    if (applied === 0) {
      this.logger.log(`Autonomous reallocation for budget ${budgetId} committed to plan; no live ad-platform write (no capability/creds).`);
    }
    return { status: applied > 0 ? 'APPLIED' : 'NO_LIVE_WRITE', runId: run.id, applied, skipped, results };
  }

  /**
   * The shared per-channel commit + credential-gated live-write loop — the
   * money-safety core both lanes (APPROVED and AUTO) run through unchanged.
   */
  private async commitAndPush(
    workspaceId: string,
    budgetId: string,
    after: AfterAllocation[],
  ): Promise<{ results: ChannelResult[]; applied: number; skipped: number }> {
    // Resolve a Meta ad account once (only when Meta is cred-write-capable).
    const metaAccount = this.capability.canWriteBudget('META')
      ? await this.prisma.adAccount.findFirst({ where: { workspaceId, provider: 'META' }, select: { id: true } })
      : null;

    const results: ChannelResult[] = [];
    for (const a of after) {
      const ref = a.campaignRef ?? '';
      const base = { channel: a.channel, campaignRef: ref, budget: a.budget };

      // (1) Always commit the approved amount to the internal plan (the pacer's source of truth).
      await this.prisma.budgetAllocation.updateMany({
        where: { budgetId, channel: a.channel, campaignRef: ref },
        data: { plannedAmount: new Prisma.Decimal(Number.isFinite(a.budget) ? a.budget : 0) },
      });

      // (2) Live ad-platform push — strictly gated.
      if (!this.capability.canWriteBudget(a.channel)) {
        results.push({ ...base, applied: false, note: `plan committed; no live write capability for ${a.channel}` });
        continue;
      }
      if (a.channel !== 'META') {
        results.push({ ...base, applied: false, note: `plan committed; ${a.channel} write client not available yet` });
        continue;
      }
      if (!ref) {
        results.push({ ...base, applied: false, note: 'plan committed; channel-level rollup has no ad entity to write' });
        continue;
      }
      if (!metaAccount) {
        results.push({ ...base, applied: false, note: 'plan committed; no Meta ad account connected' });
        continue;
      }
      if (!(a.budget > 0)) {
        results.push({ ...base, applied: false, note: 'plan committed; skipped live write for a non-positive budget' });
        continue;
      }
      try {
        await this.ads.setDailyBudget(workspaceId, metaAccount.id, ref, a.budget);
        results.push({ ...base, applied: true, note: 'daily budget pushed to Meta' });
      } catch (e) {
        results.push({ ...base, applied: false, note: `live write failed: ${e instanceof Error ? e.message : 'error'}` });
      }
    }

    const applied = results.filter((r) => r.applied).length;
    return { results, applied, skipped: results.length - applied };
  }
}
