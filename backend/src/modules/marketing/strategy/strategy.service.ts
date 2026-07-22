import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/** The autonomy lanes a workspace can arm its strategy into. SHADOW = propose
 *  only, ASSISTED = approve-to-run (default), AUTONOMOUS = self-driving. */
export const AUTONOMY_LEVELS = ['SHADOW', 'ASSISTED', 'AUTONOMOUS'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Priority rank so the ActionPlan surfaces HIGH before MEDIUM before LOW
 *  (the stored value is a string, so semantic ordering is applied here). */
const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Strategy Engine — the read/decision surface over the synthesized
 * `MarketingStrategy` + its `StrategyAction` ActionPlan. Everything is
 * workspace-scoped (an action belonging to another workspace is treated as
 * not-found). Execution wiring is P2 — here `approveAction` only flips the row's
 * status; the orchestrator dispatches approved actions to their executors later.
 */
@Injectable()
export class StrategyService {
  constructor(private readonly prisma: PrismaService) {}

  /** The workspace's single live strategy, or null if none has been synthesized. */
  getStrategy(workspaceId: string) {
    return this.prisma.marketingStrategy.findUnique({ where: { workspaceId } });
  }

  /** The workspace's ActionPlan, optionally filtered by status, ordered by
   *  priority (HIGH→LOW) then createdAt (oldest first). */
  async listActions(workspaceId: string, opts?: { status?: string }) {
    const actions = await this.prisma.strategyAction.findMany({
      where: { workspaceId, ...(opts?.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    // Stable sort by priority rank; equal priorities keep the createdAt order.
    return [...actions].sort(
      (a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99),
    );
  }

  /** PROPOSED → APPROVED. NotFound if missing/other-workspace; BadRequest if the
   *  action is not currently PROPOSED. */
  async approveAction(workspaceId: string, actionId: string) {
    const action = await this.requireAction(workspaceId, actionId);
    if (action.status !== 'PROPOSED') {
      throw new BadRequestException(`action is ${action.status}, only PROPOSED actions can be approved`);
    }
    return this.prisma.strategyAction.update({
      where: { id: action.id },
      data: { status: 'APPROVED' },
    });
  }

  /** → DISMISSED. NotFound if missing/other-workspace; BadRequest if the action
   *  has already run (RUNNING/DONE) or is already DISMISSED. */
  async dismissAction(workspaceId: string, actionId: string) {
    const action = await this.requireAction(workspaceId, actionId);
    if (!['PROPOSED', 'APPROVED'].includes(action.status)) {
      throw new BadRequestException(`action is ${action.status} and cannot be dismissed`);
    }
    return this.prisma.strategyAction.update({
      where: { id: action.id },
      data: { status: 'DISMISSED' },
    });
  }

  /** Arm the strategy's autonomy lane. Validates the enum; NotFound if the
   *  workspace has no strategy yet. */
  async setAutonomy(workspaceId: string, level: string) {
    if (!AUTONOMY_LEVELS.includes(level as AutonomyLevel)) {
      throw new BadRequestException(`invalid autonomy level: ${level}`);
    }
    const strategy = await this.prisma.marketingStrategy.findUnique({ where: { workspaceId } });
    if (!strategy) throw new NotFoundException('no strategy for this workspace');
    return this.prisma.marketingStrategy.update({
      where: { workspaceId },
      data: { autonomyLevel: level },
    });
  }

  /** Load a workspace-scoped action or throw NotFound (an action from another
   *  workspace is invisible here). */
  private async requireAction(workspaceId: string, actionId: string) {
    const action = await this.prisma.strategyAction.findFirst({
      where: { id: actionId, workspaceId },
    });
    if (!action) throw new NotFoundException('strategy action not found');
    return action;
  }
}
