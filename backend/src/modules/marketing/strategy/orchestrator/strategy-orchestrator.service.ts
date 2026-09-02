import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ActionKind, Executor } from '../strategy.types';
import { LeadHuntExecutor } from '../executors/lead-hunt.executor';
import { ContentExecutor } from '../executors/content.executor';
import { CommunityEngageExecutor } from '../executors/community-engage.executor';
import { AdCampaignExecutor } from '../executors/ad-campaign.executor';
import { growthAutopilotAutonomyEnabled } from '../../budget/growth-autonomy.flag';
import { SKIP_KILL_SWITCH, SKIP_NO_EXECUTOR, SKIP_RUN_CAP } from './skip-reasons';

export type ExecuteResult =
  | { status: 'DONE'; resultRef: string | null }
  | { status: 'FAILED'; error: string }
  | { skipped: 'executor-not-available' };

/**
 * The outcome of a lane-aware `applyPlan` sweep for one workspace.
 *
 * `applied` USED TO MEAN "we called an executor", which is not a thing anyone
 * wants to be told. It counted the executor-not-available case, the FAILED
 * case, and every `resultRef: undefined` degradation - and three of the four
 * executors degrade on a common, real condition (no AI key, no connected ad
 * account). `setAutonomy` hands this number straight to the console the moment
 * an owner arms autonomy, so "10 applied" could mean ten actions that produced
 * exactly nothing. The counters below say which of those happened, and the
 * daily brief already draws the same line between produced and hollow, so both
 * surfaces now count the same thing.
 *
 * INVARIANT: attempted === applied + noResult + failed + noExecutor.
 */
export interface ApplyPlanResult {
  /** The strategy's autonomy lane ('NONE' when the workspace has no strategy). */
  lane: string;
  /** Ran AND produced something: DONE with a resultRef. The honest headline. */
  applied: number;
  /** Handed to an executor at all. THIS is what MAX_AUTO_ACTIONS bounds - the
   *  blast radius of a sweep is what it tried, not what worked. */
  attempted: number;
  /** Ran and produced nothing (DONE, no resultRef): the executor came back
   *  empty-handed, usually because the tool it needs is not connected. */
  noResult: number;
  /** The executor threw; the reason is recorded on the action. */
  failed: number;
  /** Nothing is registered for this kind, so nothing ran (CHANNEL_SETUP). */
  noExecutor: number;
  /** How many were left un-run by a machine guardrail (kill-switch, run cap). */
  skipped: number;
  /** Why they were left, counted by reason - the readable half of `skipped`. */
  skippedReasons: Record<string, number>;
}

/** A sweep that did nothing at all, for the lanes that return early. */
const idleResult = (lane: string): ApplyPlanResult => ({
  lane, applied: 0, attempted: 0, noResult: 0, failed: 0, noExecutor: 0, skipped: 0, skippedReasons: {},
});

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
    if (!strategy) return idleResult('NONE');

    const lane = String((strategy as { autonomyLevel?: string }).autonomyLevel ?? 'ASSISTED');
    // SHADOW = observe; ASSISTED = approval-gated (approveAction already wired).
    // Neither auto-executes here — the common path is untouched.
    if (lane !== 'AUTONOMOUS') return idleResult(lane);

    const proposedActions = await this.prisma.strategyAction.findMany({
      where: { workspaceId, strategyId: strategy.id, status: 'PROPOSED' },
      orderBy: { createdAt: 'asc' },
    });

    const killSwitchOn = growthAutopilotAutonomyEnabled();
    let applied = 0;
    let attempted = 0;
    let noResult = 0;
    let failed = 0;
    let noExecutor = 0;
    let skipped = 0;
    const skippedReasons: Record<string, number> = {};
    const note = (reason: string) => {
      skipped += 1;
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    };
    for (const action of proposedActions) {
      const kind = action.kind as ActionKind;
      // Machine guardrail: spend/publish kinds are inert unless the env flag arms them.
      //
      // CHECKED BEFORE THE CAP, and the order is the whole point of stamping a
      // reason at all. A kill-switched action never consumes an attempt, so
      // which test runs first cannot change what executes - it changes only
      // what the owner is TOLD. Test the cap first and an action the switch
      // blocks gets stamped `run-cap`, whose owner-facing wording is "these
      // will be handled on the next run" - a promise the next run cannot keep,
      // because the switch is still off and will be off tomorrow too. The
      // owner is sent to wait when the one thing that would unblock them is to
      // arm the switch. The standing blocker is the honest reason; the cap is
      // incidental to it.
      if (SPEND_OR_PUBLISH_KINDS.has(kind) && !killSwitchOn) {
        note(SKIP_KILL_SWITCH);
        await this.stampSkip(action, SKIP_KILL_SWITCH); // leave PROPOSED
        continue;
      }
      // Per-run cap. The loop no longer `break`s: the remaining actions are
      // still walked so each one gets told WHY it is waiting. Nothing is
      // executed past the cap - they are only stamped.
      // Bounded by what was ATTEMPTED, not by what produced. `applied` now
      // counts only actions that came back with something, and a cap on that
      // is not a cap: a plan of fifty actions whose executors all degrade
      // (no AI key, no connected account) would dispatch all fifty, burning a
      // compose apiece and posting whatever the ones that DO work produce -
      // the blast radius this cap exists to bound, opened by making the
      // headline number honest.
      if (attempted >= MAX_AUTO_ACTIONS) {
        note(SKIP_RUN_CAP);
        await this.stampSkip(action, SKIP_RUN_CAP);
        continue;
      }
      // ATOMIC CLAIM, not a plain write. Until now `applyPlan` had exactly one
      // caller, at the tail of a synthesis run that was itself under an
      // advisory lock. It now has two more that are not: the hourly driver, and
      // the arming handler on an HTTP request a browser can fire twice. Nothing
      // else claims the row - `execute` only asserts the status it finds - so a
      // read-then-write here lets two runners both see PROPOSED, both flip it
      // to APPROVED and both dispatch. The executor then runs twice: two AI
      // composes billed to the workspace's credits, two staged drafts, and for
      // COMMUNITY_ENGAGE with a connected Discord/Reddit channel the same copy
      // posted to a live community twice. Narrowing the update by the status we
      // read makes the PROPOSED -> APPROVED transition itself the claim, so
      // exactly one writer comes back with count 1.
      const claimed = await this.prisma.strategyAction.updateMany({
        where: { id: action.id, status: 'PROPOSED' },
        data: { status: 'APPROVED' },
      });
      // Someone else took it between the read and here (a concurrent sweep, or
      // a human pressing Approve in the console). Theirs is running it; ours
      // must not run it a second time, and must not count it as its own work.
      if (claimed.count === 0) continue;
      attempted += 1;
      const outcome = await this.execute(workspaceId, action.id).catch((e) => {
        // execute() records executor failures on the action itself; this guards
        // only an unexpected dispatch-time throw so one bad action can't halt the sweep.
        this.logger.error(`applyPlan: dispatch failed for action ${action.id}: ${(e as Error)?.message ?? e}`);
        // A dispatch that threw is a failure like any other, and counting it as
        // anything else is how a number nobody can act on gets reported as work.
        return { status: 'FAILED', error: 'dispatch' } as ExecuteResult;
      });
      if ('skipped' in outcome) noExecutor += 1;
      else if (outcome.status === 'FAILED') failed += 1;
      else if (outcome.resultRef) applied += 1;
      else noResult += 1;
    }
    this.logger.log(
      `applyPlan ws ${workspaceId}: AUTONOMOUS attempted ${attempted} - ${applied} produced, ` +
        `${noResult} came back empty, ${failed} failed, ${noExecutor} had no executor; ` +
        `guardrail-skipped ${skipped} (kill-switch ${killSwitchOn ? 'ON' : 'OFF'})`,
    );
    return { lane, applied, attempted, noResult, failed, noExecutor, skipped, skippedReasons };
  }

  /**
   * Write a skip reason onto an action - but ONLY when it differs from the one
   * already there.
   *
   * The conditional is not a micro-optimisation, it is the cost control. Every
   * write to a StrategyAction bumps its `updatedAt` above `strategy.updatedAt`,
   * which is precisely the predicate the weekly feedback cron uses to decide
   * whether a workspace has a new outcome worth paying for a re-synthesis
   * (`strategy.controller.ts` documents the ordering this depends on, and names
   * `applyPlan` as the one legitimate writer). Stamping unconditionally on a
   * DAILY tick would hand that cron a fresh "something moved" every single week
   * for a workspace where, in fact, nothing moved - billing the most expensive
   * action in the product to re-learn "the kill-switch is still off".
   *
   * A reason that CHANGES is genuinely new information and re-opening the gate
   * for it is correct. A reason that repeats is not, and stays silent.
   */
  private async stampSkip(
    action: { id: string; resultRef: string | null },
    reason: string,
  ): Promise<void> {
    if (action.resultRef === reason) return;
    await this.prisma.strategyAction
      .update({ where: { id: action.id }, data: { resultRef: reason } })
      .catch((e) => {
        // A missing reason must never cost the sweep an action it could run.
        this.logger.warn(`applyPlan: could not stamp ${reason} on ${action.id}: ${(e as Error)?.message ?? e}`);
      });
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
      // Not nothing, either: without a stamp an action parked here forever
      // looks exactly like one the sweep has not got to yet, and the brief
      // cannot name it.
      await this.stampSkip(action, SKIP_NO_EXECUTOR);
      return { skipped: 'executor-not-available' };
    }

    await this.prisma.strategyAction.update({
      where: { id: action.id },
      data: { status: 'RUNNING' },
    });

    try {
      const { resultRef } = await executor.run(workspaceId, action.payload, {
        title: action.title,
        rationale: action.rationale,
      });
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
