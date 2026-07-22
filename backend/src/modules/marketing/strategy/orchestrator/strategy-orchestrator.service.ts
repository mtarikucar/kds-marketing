import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ActionKind, Executor } from '../strategy.types';
import { LeadHuntExecutor } from '../executors/lead-hunt.executor';
import { ContentExecutor } from '../executors/content.executor';
import { CommunityEngageExecutor } from '../executors/community-engage.executor';
import { AdCampaignExecutor } from '../executors/ad-campaign.executor';
import { growthAutopilotAutonomyEnabled } from '../../budget/growth-autonomy.flag';

export type ExecuteResult =
  | { status: 'DONE'; resultRef: string | null }
  | { status: 'FAILED'; error: string }
  | { skipped: 'executor-not-available' };

/** The outcome of a lane-aware `applyPlan` sweep for one workspace. */
export interface ApplyPlanResult {
  /** The strategy's autonomy lane ('NONE' when the workspace has no strategy). */
  lane: string;
  /** How many PROPOSED actions this run auto-executed (AUTONOMOUS only). */
  applied: number;
  /** How many were left PROPOSED by the machine guardrail (kill-switch off). */
  skipped: number;
}

/** Per-run safety cap: never auto-apply more than this many actions in one
 *  AUTONOMOUS sweep, bounding worst-case blast radius per synthesis/feedback tick. */
const MAX_AUTO_ACTIONS = 10;

/**
 * Action kinds whose execution spends ad money or PUBLISHES to an external
 * audience. In the AUTONOMOUS lane these auto-run ONLY when the Growth Autopilot
 * env kill-switch (`growthAutopilotAutonomyEnabled()`) is ON — the same global
 * switch that arms every other money/publish autonomy in the platform. LEAD_HUNT
 * (prospect research staged internally, already quota- + credit-metered) is
 * deliberately absent, so it can auto-run without the kill-switch.
 */
const SPEND_OR_PUBLISH_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'AD_CAMPAIGN',
  'CONTENT',
  'COMMUNITY_ENGAGE',
  'CHANNEL_SETUP',
]);

/**
 * Strategy Orchestrator — dispatches an APPROVED `StrategyAction` to the
 * `Executor` registered for its kind. This is the ASSISTED lane's execute step
 * (approve → execute). It owns the action's execution lifecycle:
 * APPROVED → RUNNING → DONE (stamping the executor's `resultRef`) or → FAILED
 * (recording the error, never crashing the caller). Kinds without an executor
 * yet (AD_CAMPAIGN / CHANNEL_SETUP — later phases) no-op
 * gracefully: the action stays APPROVED and `{ skipped }` is returned.
 */
@Injectable()
export class StrategyOrchestrator {
  private readonly logger = new Logger(StrategyOrchestrator.name);
  private readonly registry: Map<ActionKind, Executor>;

  constructor(
    private readonly prisma: PrismaService,
    leadHunt: LeadHuntExecutor,
    content: ContentExecutor,
    communityEngage: CommunityEngageExecutor,
    adCampaign: AdCampaignExecutor,
  ) {
    this.registry = new Map<ActionKind, Executor>([
      [leadHunt.kind, leadHunt],
      [content.kind, content],
      [communityEngage.kind, communityEngage],
      [adCampaign.kind, adCampaign],
    ]);
  }

  /**
   * Lane-aware entry point — apply the workspace's strategy ActionPlan according
   * to its `MarketingStrategy.autonomyLevel`:
   *   - SHADOW    → observation only; leave every action PROPOSED.
   *   - ASSISTED  → no-op here; execution stays approval-gated via
   *                 `StrategyService.approveAction` (the default flow).
   *   - AUTONOMOUS→ auto-execute PROPOSED actions via the existing `execute`
   *                 path (flip to APPROVED then dispatch), under machine
   *                 guardrails: spend/publish kinds require the env kill-switch,
   *                 and no more than MAX_AUTO_ACTIONS are applied per run.
   * Called after synthesis/feedback (re)seeds the plan. A dispatch/executor
   * failure is recorded on the action by `execute`; it never crashes the sweep.
   */
  async applyPlan(workspaceId: string): Promise<ApplyPlanResult> {
    const strategy = await this.prisma.marketingStrategy.findUnique({ where: { workspaceId } });
    if (!strategy) return { lane: 'NONE', applied: 0, skipped: 0 };

    const lane = String((strategy as { autonomyLevel?: string }).autonomyLevel ?? 'ASSISTED');
    // SHADOW = observe; ASSISTED = approval-gated (approveAction already wired).
    // Neither auto-executes here — the common path is untouched.
    if (lane !== 'AUTONOMOUS') return { lane, applied: 0, skipped: 0 };

    const proposedActions = await this.prisma.strategyAction.findMany({
      where: { workspaceId, strategyId: strategy.id, status: 'PROPOSED' },
      orderBy: { createdAt: 'asc' },
    });

    const killSwitchOn = growthAutopilotAutonomyEnabled();
    let applied = 0;
    let skipped = 0;
    for (const action of proposedActions) {
      if (applied >= MAX_AUTO_ACTIONS) break; // per-run cap
      const kind = action.kind as ActionKind;
      // Machine guardrail: spend/publish kinds are inert unless the env flag arms them.
      if (SPEND_OR_PUBLISH_KINDS.has(kind) && !killSwitchOn) {
        skipped += 1;
        continue; // leave PROPOSED
      }
      await this.prisma.strategyAction.update({ where: { id: action.id }, data: { status: 'APPROVED' } });
      await this.execute(workspaceId, action.id).catch((e) => {
        // execute() records executor failures on the action itself; this guards
        // only an unexpected dispatch-time throw so one bad action can't halt the sweep.
        this.logger.error(`applyPlan: dispatch failed for action ${action.id}: ${(e as Error)?.message ?? e}`);
      });
      applied += 1;
    }
    this.logger.log(
      `applyPlan ws ${workspaceId}: AUTONOMOUS auto-applied ${applied}, guardrail-skipped ${skipped} (kill-switch ${killSwitchOn ? 'ON' : 'OFF'})`,
    );
    return { lane, applied, skipped };
  }

  async execute(workspaceId: string, actionId: string): Promise<ExecuteResult> {
    const action = await this.prisma.strategyAction.findFirst({
      where: { id: actionId, workspaceId },
    });
    if (!action) throw new NotFoundException('strategy action not found');
    if (action.status !== 'APPROVED') {
      throw new BadRequestException(`action is ${action.status}, only APPROVED actions can be executed`);
    }

    const executor = this.registry.get(action.kind as ActionKind);
    if (!executor) {
      // AD_CAMPAIGN / CHANNEL_SETUP are later phases — leave the
      // action APPROVED so it can run once its executor ships. Not a failure.
      this.logger.log(`no executor for kind ${action.kind} yet — leaving action ${actionId} APPROVED`);
      return { skipped: 'executor-not-available' };
    }

    await this.prisma.strategyAction.update({
      where: { id: action.id },
      data: { status: 'RUNNING' },
    });

    try {
      const { resultRef } = await executor.run(workspaceId, action.payload);
      await this.prisma.strategyAction.update({
        where: { id: action.id },
        data: { status: 'DONE', resultRef: resultRef ?? null },
      });
      this.logger.log(`action ${actionId} (${action.kind}) DONE${resultRef ? ` → ${resultRef}` : ''}`);
      return { status: 'DONE', resultRef: resultRef ?? null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`action ${actionId} (${action.kind}) FAILED: ${message}`);
      // Record the failure without crashing the approve/execute caller. There is
      // no dedicated error column, so the reason rides in resultRef (`error:…`).
      await this.prisma.strategyAction
        .update({
          where: { id: action.id },
          data: { status: 'FAILED', resultRef: `error:${message}`.slice(0, 500) },
        })
        .catch(() => undefined);
      return { status: 'FAILED', error: message };
    }
  }
}
