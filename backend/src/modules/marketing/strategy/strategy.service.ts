import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StrategyOrchestrator } from './orchestrator/strategy-orchestrator.service';
import { claimAutopilotDay } from './orchestrator/strategy-apply.cron';
import { workspaceLocalParts } from '../../../common/scheduling/workspace-local-day';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

/** The job the arming path hands its first run to, so a settings write returns
 *  instead of blocking on a plan's worth of executors. */
export const AUTOPILOT_ARM_KIND = 'autopilot.arm';

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
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: StrategyOrchestrator,
    private readonly scheduledJobs: ScheduledJobService,
  ) {}

  /** The workspace's own clock — the day the autopilot claim is keyed on. */
  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    return ws?.timezone || 'UTC';
  }

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

  /**
   * PROPOSED → APPROVED, then (ASSISTED default) hand the action to the
   * orchestrator to execute now. NotFound if missing/other-workspace; BadRequest
   * if the action is not currently PROPOSED. Returns the APPROVED row; execution
   * proceeds decoupled — a dispatch/executor failure is recorded on the action
   * (status FAILED) by the orchestrator and never fails the approval itself.
   *
   * THE FLIP IS THE CLAIM, for the same reason it is in `applyPlan`. The status
   * check above is a read; writing APPROVED unconditionally afterwards is a
   * separate statement, and `execute` only ASSERTS the status it finds — it
   * claims nothing. So a read-then-write here is the second half of the very
   * race `applyPlan` narrows its own update to close, and it is the half a
   * human sits on:
   *
   *  - Two clicks on Approve (a double-click, a retried request, two open tabs)
   *    both read PROPOSED and both dispatch. The executor runs twice: two AI
   *    composes billed to the workspace, two staged drafts, and for
   *    COMMUNITY_ENGAGE with a connected Discord/Reddit channel the same copy
   *    posted into a live community twice.
   *  - Worse against the autonomous sweep: the sweep claims the row, `execute`
   *    moves it to RUNNING and the executor is mid-flight when this
   *    unconditional write puts it BACK to APPROVED — which is exactly the
   *    status `execute` demands, so the second dispatch sails through the guard
   *    that exists to stop it.
   *
   * Narrowing the update by the status we read makes PROPOSED → APPROVED itself
   * the claim: exactly one caller comes back with count 1, and the loser is told
   * what the action is now rather than running it again.
   */
  async approveAction(workspaceId: string, actionId: string) {
    const action = await this.requireAction(workspaceId, actionId);
    if (action.status !== 'PROPOSED') {
      throw new BadRequestException(`action is ${action.status}, only PROPOSED actions can be approved`);
    }
    const claimed = await this.prisma.strategyAction.updateMany({
      where: { id: action.id, status: 'PROPOSED' },
      data: { status: 'APPROVED' },
    });
    if (claimed.count === 0) {
      // Someone else took it between the read and here. Report what it IS now,
      // not what it was when we looked — and dispatch nothing.
      const current = await this.requireAction(workspaceId, actionId);
      throw new BadRequestException(
        `action is ${current.status}, only PROPOSED actions can be approved`,
      );
    }
    const approved = await this.requireAction(workspaceId, actionId);
    // ASSISTED lane: approve → execute. The orchestrator swallows executor errors
    // (marks the action FAILED), so a `.catch` here only guards an unexpected
    // dispatch-time throw — the approval decision must stand regardless.
    await this.orchestrator.execute(workspaceId, action.id).catch((e) => {
      this.logger.error(`approve→execute dispatch failed for action ${action.id}: ${e?.message ?? e}`);
    });
    return approved;
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

  /**
   * Arm the strategy's autonomy lane. Validates the enum; NotFound if the
   * workspace has no strategy yet.
   *
   * ARMING NOW APPLIES THE PLAN THAT ALREADY EXISTS. This used to write the
   * column and return, which made flipping the console to AUTONOMOUS a no-op
   * on every action already sitting in the plan. The only caller of `applyPlan`
   * was the tail of a synthesis run, and synthesis is only re-run by the weekly
   * feedback cron, which skips a workspace unless some action moved since the
   * strategy row was last written - and synthesis deliberately touches that row
   * LAST, so a freshly-seeded plan never qualifies. Nothing moves an action but
   * `applyPlan` or a human. So autonomy was armed only for a synthesis that
   * could not happen: the switch changed a label, and the plan underneath it
   * stayed frozen forever. The live workspace has sat on nine PROPOSED actions
   * since 2026-08-23 for exactly this reason.
   *
   * Two guards on the call, both deliberate:
   *
   *  - ONLY ON THE TRANSITION. A re-save of AUTONOMOUS over AUTONOMOUS - which
   *    a settings screen does every time someone presses Save - must not
   *    re-drive the plan. The daily tick owns the cadence; this owns the moment
   *    the owner says yes.
   *  - THE WRITE STANDS EVEN IF APPLYING FAILS. The column is the owner's
   *    recorded decision. Letting an executor's bad afternoon roll back a
   *    consent gesture would leave the panel showing ASSISTED after the owner
   *    chose AUTONOMOUS, which is the one thing a consent surface may never do.
   *    `applyPlan` already swallows per-action failures; this catch covers an
   *    unexpected dispatch-time throw.
   */
  async setAutonomy(workspaceId: string, level: string) {
    if (!AUTONOMY_LEVELS.includes(level as AutonomyLevel)) {
      throw new BadRequestException(`invalid autonomy level: ${level}`);
    }
    const strategy = await this.prisma.marketingStrategy.findUnique({ where: { workspaceId } });
    if (!strategy) throw new NotFoundException('no strategy for this workspace');
    const wasArmed = String((strategy as { autonomyLevel?: string }).autonomyLevel ?? '') === 'AUTONOMOUS';
    const updated = await this.prisma.marketingStrategy.update({
      where: { workspaceId },
      data: { autonomyLevel: level },
    });
    if (level !== 'AUTONOMOUS' || wasArmed) return updated;

    /**
     * Arming applies the plan — but NOT inside this request.
     *
     * `applyPlan` dispatches up to MAX_AUTO_ACTIONS executors serially, and one
     * LEAD_HUNT alone is budgeted at two minutes. Awaited here, arming a plan
     * with a couple of those blocks the POST past the edge proxy's timeout: the
     * owner sees an error toast and a control still reading ASSISTED while the
     * machine is in fact running their plan. Arming is a settings write, and a
     * settings write returns.
     *
     * So the row is written, the workspace's local day is CLAIMED with the same
     * row the cron uses — otherwise the next hourly tick finds the day free and
     * drives the same plan a second time, and day one runs twice the per-run cap
     * — and the work is handed to the scheduled-job runner, which picks it up
     * within the minute.
     */
    const { date } = workspaceLocalParts(await this.workspaceTimezone(workspaceId), new Date());
    const claimed = await claimAutopilotDay(this.prisma, workspaceId, date).catch(() => false);
    if (!claimed) return { ...updated, applyPlan: { queued: false, reason: 'already-run-today' } };

    await this.scheduledJobs
      .schedule({
        kind: AUTOPILOT_ARM_KIND,
        runAt: new Date(),
        dedupKey: `autopilot-arm:${workspaceId}:${date}`,
        payload: { workspaceId },
        workspaceId,
      })
      .catch((e) => {
        // The consent write stands regardless: an owner who chose AUTONOMOUS must
        // not find the panel back on ASSISTED because a queue write failed. The
        // hourly tick is the backstop — except this day is now claimed, so log
        // loudly rather than leaving it silently unrun.
        this.logger.error(`setAutonomy: could not queue the first run for ws ${workspaceId}: ${e?.message ?? e}`);
      });

    return { ...updated, applyPlan: { queued: true } };
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
