import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';
import { parseWorkflowParts, MAX_WORKFLOW_DEPTH, WorkflowStep, WorkflowGoal } from './workflow-dsl.schema';

const RESUME_KIND = 'workflow.resume';
// Belt against a mis-authored goto cycle: a single advance() can execute at
// most this many steps before yielding (the DSL also hard-caps step COUNT).
const MAX_STEPS_PER_ADVANCE = 200;
// Lifetime cap on goal goto-jumps PER RUN (persisted in context, so it survives
// resumes). MAX_STEPS_PER_ADVANCE only bounds a single advance() — a goto goal
// that loops back across a `wait` step would otherwise reset that counter every
// resume and re-fire forever. This is the cross-checkpoint backstop.
const MAX_GOAL_JUMPS_PER_RUN = 100;
const UNTIL_REPLY_FALLBACK_SEC = 86_400;
/**
 * How long one lead is left alone after a `link.clicked` run, unless the
 * author says otherwise. An hour is short enough that "click here to request a
 * callback" still works the second time somebody means it, and long enough
 * that a scanner prefetch plus the human's own click is one enrolment, not two
 * (`link-clicked-reenroll`).
 */
const LINK_CLICK_COOLDOWN_SEC = 3600;
const MIN_REENTRY_COOLDOWN_SEC = 60;
const MAX_REENTRY_COOLDOWN_SEC = 2_592_000;
/** How often one step may be queued forward by the send window before it just goes. */
const MAX_DEFERRALS_PER_STEP = 3;

interface StartSubject {
  leadId?: string | null;
  conversationId?: string | null;
}

/**
 * Runs a Workflow's step list against a subject. The cursor (WorkflowRun.cursor
 * = {stepIndex}) is a 1-frame program counter; branch/ai_classify move it,
 * `wait` persists WAITING + schedules a `workflow.resume` ScheduledJob, and the
 * runner resumes from the saved cursor. A raw partial-unique index enforces one
 * active run per (workflow, lead); a duplicate start is a no-op.
 */
@Injectable()
export class WorkflowExecutorService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handler: WorkflowActionHandler,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(RESUME_KIND, (job) => this.resume(job));
  }

  /** Start a run. Returns the runId, or null if a live run already exists (or
   *  this exact trigger event already started one — durable idempotency for
   *  leadless enrollment). `triggerEventId` is the source domain-event id;
   *  omit it for child workflows (they aren't event-triggered). */
  async start(
    workflow: { id: string; workspaceId: string; version: number; trigger: unknown; steps: unknown },
    subject: StartSubject,
    triggerPayload: Record<string, unknown>,
    depth = 0,
    triggerEventId?: string | null,
  ): Promise<string | null> {
    if (depth > MAX_WORKFLOW_DEPTH) {
      this.logger.warn(`workflow ${workflow.id} exceeded max chain depth ${MAX_WORKFLOW_DEPTH}`);
      return null;
    }
    // Only a root enrolment is re-entry-governed: a child start is the
    // parent's decision, already made.
    if (depth === 0 && (await this.reentryBlocked(workflow, subject))) return null;
    let run;
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          leadId: subject.leadId ?? null,
          conversationId: subject.conversationId ?? null,
          triggerEventId: triggerEventId ?? null,
          status: 'RUNNING',
          cursor: { stepIndex: 0 },
          context: { _trigger: triggerPayload } as Prisma.InputJsonValue,
          depth,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Either a live run for this (workflow, lead) already exists, OR this
        // exact source event already started a run (workflow_runs_trigger_event)
        // — a redelivered event must be a no-op, not a duplicate enrollment.
        return null;
      }
      throw e;
    }
    // Count the run as started only once it actually exists (the P2002 no-op
    // above is NOT counted). Stats are best-effort: never fail a run on them.
    await this.bumpStat(workflow.workspaceId, workflow.id, 'started').catch(() => undefined);
    await this.advance(run.id);
    return run.id;
  }

  private async resume(job: ClaimedJob): Promise<void> {
    await this.advance(job.payload.runId);
  }

  /**
   * Has this lead been enrolled too recently to be enrolled again?
   *
   * Asked of `link.clicked` alone, because it is the one trigger a single lead
   * fires over and over: every other trigger type fires once per real-world
   * event, and a blanket cooldown would break the ones that legitimately
   * repeat (a status flipped back and forth, a second booking).
   *
   * The two existing guards do not cover it. `workflow_runs_active_per_lead`
   * frees the moment the prior run finishes, and a one-step send workflow
   * finishes inside `start()` in milliseconds; `workflow_runs_trigger_event`
   * keys on the source event id, and every click is a new `TriggerLinkClick`
   * and so a new id. Result: a scanner prefetch plus the human's own click
   * sent two codes, and a link INSIDE the mail re-enrolled the lead every time
   * it was followed (`link-clicked-reenroll`).
   *
   * `cooldown` is the default and `once_per_lead` is an author's choice, never
   * ours: "click here to request a callback" is a legitimate repeat-use
   * pattern that once-per-lead would break forever. A LEADLESS click has
   * nothing to key on and is left exactly as it was — the source-event id
   * still dedupes a redelivery.
   */
  private async reentryBlocked(
    workflow: { id: string; workspaceId: string; trigger: unknown },
    subject: StartSubject,
  ): Promise<boolean> {
    const trigger = (workflow.trigger ?? {}) as {
      type?: string;
      reentry?: { mode?: string; cooldownSeconds?: number };
    };
    if (trigger.type !== 'link.clicked') return false;
    const leadId = subject.leadId;
    if (!leadId) return false;

    const mode = trigger.reentry?.mode ?? 'cooldown';
    if (mode === 'always') return false;

    // Only the time window is hoisted. `workspaceId` is spelled out inside the
    // findFirst argument below because workspace-scoping.arch.spec.ts reads the
    // call's literal argument object and cannot follow a hoisted `where`.
    const window: Prisma.WorkflowRunWhereInput = {};
    if (mode !== 'once_per_lead') {
      const seconds = Math.min(
        MAX_REENTRY_COOLDOWN_SEC,
        Math.max(MIN_REENTRY_COOLDOWN_SEC, Number(trigger.reentry?.cooldownSeconds) || LINK_CLICK_COOLDOWN_SEC),
      );
      window.createdAt = { gte: new Date(Date.now() - seconds * 1000) };
    }

    try {
      const prior = await this.prisma.workflowRun.findFirst({
        where: { workspaceId: workflow.workspaceId, workflowId: workflow.id, leadId, ...window },
        select: { id: true },
      });
      if (!prior) return false;
      this.logger.warn(
        `workflow ${workflow.id} skipped re-enrolling lead ${leadId} (${mode}); prior run ${prior.id}`,
      );
      return true;
    } catch (e: any) {
      // A guard we cannot read is not a reason to stop enrolling — that would
      // turn a transient DB hiccup into silently dead automations.
      this.logger.warn(`re-entry check failed for workflow ${workflow.id}: ${e?.message ?? e}`);
      return false;
    }
  }

  private async advance(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run || (run.status !== 'RUNNING' && run.status !== 'WAITING')) return;

    const workflow = await this.prisma.workflow.findFirst({
      where: { id: run.workflowId, workspaceId: run.workspaceId },
    });
    if (!workflow) {
      await this.finish(runId, 'FAILED', 'workflow deleted mid-run');
      return;
    }

    let steps: WorkflowStep[];
    let goal: WorkflowGoal | undefined;
    try {
      const dsl = parseWorkflowParts(workflow.trigger, workflow.steps, (workflow as any).goal ?? undefined);
      steps = dsl.steps;
      goal = dsl.goal;
    } catch (e: any) {
      await this.finish(runId, 'FAILED', `invalid DSL: ${e?.message ?? e}`);
      return;
    }

    const ctxObj = (run.context ?? {}) as Record<string, any>;
    // Exclude a lead bulk-deleted (deletedAt) or merged-away (mergedIntoId) since
    // the run started: a workflow waits between steps, so a lead can vanish mid-
    // flight, and bulk-delete means "stop contacting".
    const lead = run.leadId
      ? await this.prisma.lead.findFirst({
          where: { id: run.leadId, workspaceId: run.workspaceId, deletedAt: null, mergedIntoId: null },
        })
      : null;
    // A lead-scoped run whose lead is gone has no live subject to act on — stop
    // it (parallel to the 'workflow deleted mid-run' guard) so it can't keep
    // sending / tasking against a hidden contact across resumes.
    if (run.leadId && !lead) {
      await this.finish(runId, 'STOPPED', 'lead deleted or merged mid-run');
      return;
    }
    const ctx: WorkflowContext = {
      workspaceId: run.workspaceId,
      lead,
      trigger: (ctxObj._trigger ?? {}) as Record<string, any>,
      context: ctxObj,
    };

    let stepIndex = ((run.cursor as any)?.stepIndex ?? 0) as number;
    if (run.status === 'WAITING') {
      await this.prisma.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
    }

    for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
      // Goal short-circuit (GHL parity): before each step, if the subject has
      // reached the goal's target state, leave the workflow ('exit') or jump
      // ahead ('goto'). Checked here — not just at start — so a state change
      // between waits is honoured at the next resume checkpoint. The skip when
      // already AT the goto target prevents the trivial same-step re-jump loop;
      // a backward goto whose condition persists is bounded by the per-run
      // MAX_GOAL_JUMPS_PER_RUN cap (which survives resumes), and within a single
      // advance also by the per-advance step ceiling below.
      if (goal && !(goal.onMet === 'goto' && stepIndex === goal.gotoStep)) {
        if (this.handler.matchesAll(goal.filters, ctx)) {
          if (goal.onMet === 'goto' && goal.gotoStep != null) {
            // Lifetime per-run jump cap (persisted in context → survives the
            // wait/resume cycle that resets the per-advance step counter). A
            // goto goal looping back across a `wait` is the only path that can
            // re-fire across checkpoints; this is its backstop.
            const jumps = (Number(ctx.context.__goalJumps) || 0) + 1;
            if (jumps > MAX_GOAL_JUMPS_PER_RUN) {
              await this.recordStep(run.workspaceId, runId, stepIndex, 'goal', 'FAILED', null, 'goal goto-jump cap exceeded (cycle?)');
              await this.finish(runId, 'FAILED', `goal exceeded ${MAX_GOAL_JUMPS_PER_RUN} goto-jumps (cycle?)`);
              return;
            }
            ctx.context.__goalJumps = jumps;
            await this.recordStep(run.workspaceId, runId, stepIndex, 'goal', 'DONE', { jumpedTo: goal.gotoStep });
            stepIndex = goal.gotoStep;
            await this.persistContext(runId, ctx, stepIndex);
            continue;
          }
          await this.recordStep(run.workspaceId, runId, stepIndex, 'goal', 'DONE', { met: true });
          await this.persistContext(runId, ctx, stepIndex);
          await this.finish(runId, 'DONE', stepFailure(ctx));
          return;
        }
      }
      if (stepIndex >= steps.length) {
        await this.persistContext(runId, ctx, stepIndex);
        await this.finish(runId, 'DONE', stepFailure(ctx));
        return;
      }
      const step = steps[stepIndex];
      // Which run and which step this is. A mail needs both: they are its
      // idempotency key, so a replayed advance() after a crash re-sends
      // nothing (the gateway dedupes on it).
      ctx.run = { id: runId, workflowId: run.workflowId, stepIndex };
      let outcome;
      try {
        outcome = await this.handler.execute(step, ctx);
      } catch (e: any) {
        await this.recordStep(run.workspaceId, runId, stepIndex, step.type, 'FAILED', null, e?.message);
        await this.finish(runId, 'FAILED', `step ${stepIndex} (${step.type}): ${e?.message ?? e}`);
        return;
      }
      // A leaf action that could not do its job says so in its OUTPUT rather
      // than throwing (a missing assignee is not worth failing the whole
      // automation over), and there are two different ways it can fail to do
      // it. `skipped (…)` is policy — nothing was supposed to happen. `ok:
      // false` is a failure — something was supposed to happen and didn't.
      // Both were recorded DONE: an operator armed "create a follow-up task",
      // the run reported DONE, every step showed green and no task existed;
      // and worse, SMTP could be broken for a week while the list read
      // "120 → 120 completed" (`failed-automation-done`). The flag is
      // structural on purpose — the status must never be derived by matching
      // English prose, which is what caused this in the first place.
      // A deferral is not a step that happened. It is recorded WAITING so the
      // run drawer says "held until 09:00" rather than showing a green step
      // for a mail still sitting in the queue.
      const deferral = this.deferralFor(outcome, ctx, stepIndex);

      const output = (outcome.output ?? null) as { result?: unknown; ok?: unknown; error?: unknown } | null;
      const result = output?.result;
      const failed = output?.ok === false;
      const skipped = !failed && typeof result === 'string' && result.startsWith('skipped');
      const stepError = failed ? String(output?.error ?? result ?? 'step failed') : undefined;
      if (failed) {
        this.logger.warn(
          `workflow run ${runId} step ${stepIndex} (${step.type}) FAILED: ${stepError}`,
        );
        // The breadcrumb the runs list reads. A run that completes with a
        // failed step used to end DONE / lastError: null, so the one run an
        // owner needed to find looked exactly like the 119 that worked. First
        // error wins: it is the one that explains the rest.
        if (!ctx.context.__lastStepError) {
          ctx.context.__lastStepError = `step ${stepIndex} (${step.type}): ${stepError}`.slice(0, 500);
        }
        ctx.context.__hadFailures = true;
      } else if (skipped) {
        this.logger.warn(
          `workflow run ${runId} step ${stepIndex} (${step.type}) did nothing: ${result as string}`,
        );
      }
      await this.recordStep(
        run.workspaceId,
        runId,
        stepIndex,
        step.type,
        deferral ? 'WAITING' : failed ? 'FAILED' : skipped ? 'SKIPPED' : 'DONE',
        outcome.output ?? null,
        stepError,
      );

      if (deferral) {
        // Resume at THIS step, not the next one: nothing was sent, so nothing
        // has been done.
        ctx.context.__resumeIndex = stepIndex;
        await this.persistContext(runId, ctx, stepIndex);
        await this.prisma.workflowRun.update({ where: { id: runId }, data: { status: 'WAITING' } });
        await this.scheduledJobs.schedule({
          workspaceId: run.workspaceId,
          kind: RESUME_KIND,
          runAt: deferral,
          dedupKey: runId,
          payload: { runId },
        });
        return;
      }

      if (outcome.stop) {
        await this.persistContext(runId, ctx, stepIndex);
        await this.finish(runId, 'STOPPED', stepFailure(ctx));
        return;
      }
      if (outcome.startWorkflowId) {
        await this.startChild(workflow.workspaceId, outcome.startWorkflowId, { leadId: run.leadId }, ctx, run.depth + 1);
      }
      if (outcome.wait) {
        const seconds = outcome.wait.untilReply
          ? outcome.wait.timeoutSeconds ?? UNTIL_REPLY_FALLBACK_SEC
          : outcome.wait.seconds ?? 3600;
        ctx.context.__resumeIndex = stepIndex + 1;
        await this.persistContext(runId, ctx, stepIndex + 1);
        await this.prisma.workflowRun.update({ where: { id: runId }, data: { status: 'WAITING' } });
        await this.scheduledJobs.schedule({
          workspaceId: run.workspaceId,
          kind: RESUME_KIND,
          runAt: new Date(Date.now() + seconds * 1000),
          dedupKey: runId,
          payload: { runId },
        });
        return;
      }
      stepIndex = outcome.goto != null ? outcome.goto : stepIndex + 1;
      // Persist the cursor after EVERY completed step (not just at wait/stop/
      // end). Otherwise a hard crash mid-advance leaves the run RUNNING with a
      // stale cursor; the reaper re-runs advance() and REPLAYS every step since
      // the last persist — re-sending SMS/email, re-creating tasks, re-POSTing
      // webhooks. With this, a replay re-fires at most the single step that was
      // in-flight at crash time (inherent at-least-once for external effects).
      await this.persistContext(runId, ctx, stepIndex);
    }
    // Hit the per-advance step ceiling — yield as FAILED to avoid a hot loop.
    await this.finish(runId, 'FAILED', `exceeded ${MAX_STEPS_PER_ADVANCE} steps in one advance (goto cycle?)`);
  }

  private async startChild(
    workspaceId: string, childId: string, subject: StartSubject, _ctx: WorkflowContext, depth: number,
  ): Promise<void> {
    const child = await this.prisma.workflow.findFirst({
      where: { id: childId, workspaceId, status: 'ACTIVE' },
    });
    if (child) await this.start(child as any, subject, {}, depth).catch(() => undefined);
  }

  private async persistContext(runId: string, ctx: WorkflowContext, stepIndex: number): Promise<void> {
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { context: ctx.context as Prisma.InputJsonValue, cursor: { stepIndex } },
    });
  }

  private async finish(runId: string, status: string, error: string | null): Promise<void> {
    const updated = await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status, lastError: error, completedAt: new Date() },
      select: { workspaceId: true, workflowId: true },
    });
    // DONE/STOPPED both count as completed; FAILED as failed. advance() is
    // guarded against re-entry on a terminal run, so finish() runs once per run.
    const key = status === 'FAILED' ? 'failed' : status === 'DONE' || status === 'STOPPED' ? 'completed' : null;
    if (key) await this.bumpStat(updated.workspaceId, updated.workflowId, key).catch(() => undefined);
  }

  /**
   * Atomic per-row JSON counter bump on Workflow.stats. A raw UPDATE with
   * jsonb_set under the row lock is race-free under concurrent finishes of the
   * same workflow — a read-modify-write on the JSON column would lose updates.
   * The whitelisted `key` is interpolated as an identifier-safe literal only.
   */
  private async bumpStat(workspaceId: string, workflowId: string, key: 'started' | 'completed' | 'failed'): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "workflows"
      SET "stats" = jsonb_set(
        COALESCE("stats", '{}'::jsonb),
        ARRAY[${key}]::text[],
        to_jsonb(COALESCE(("stats" ->> ${key})::int, 0) + 1)
      )
      WHERE "id" = ${workflowId} AND "workspaceId" = ${workspaceId}
    `;
  }

  /**
   * When a deferred step should be tried again, or `null` to let it fall
   * through as an ordinary result.
   *
   * Bounded, because a deferral re-runs the same step and an unbounded one is a
   * loop that never sends and never stops. `clampToSendWindow` always answers
   * with the next OPENING, so a healthy window costs exactly one deferral; the
   * cap is only ever reached by a window that moved under the run, and when it
   * is, the step goes ahead rather than being dropped — the customer getting
   * their mail an hour early beats never getting it.
   */
  private deferralFor(outcome: { retryStep?: { at: Date } }, ctx: WorkflowContext, stepIndex: number): Date | null {
    const at = outcome.retryStep?.at;
    if (!at) return null;
    const key = `__deferrals_${stepIndex}`;
    const seen = Number((ctx.context as Record<string, unknown>)[key] ?? 0);
    if (seen >= MAX_DEFERRALS_PER_STEP) {
      this.logger.warn(`workflow step ${stepIndex} deferred ${seen} times; sending anyway`);
      return null;
    }
    (ctx.context as Record<string, unknown>)[key] = seen + 1;
    // Never behind the clock: a retryAt in the past would have the runner pick
    // the job straight back up and spin.
    return at.getTime() > Date.now() ? at : new Date(Date.now() + 60_000);
  }

  private async recordStep(
    workspaceId: string, runId: string, stepIndex: number, stepType: string,
    status: string, output: any, error?: string,
  ): Promise<void> {
    await this.prisma.workflowStepRun.create({
      data: { workspaceId, runId, stepIndex, stepType, status, output: output ?? undefined, error: error?.slice(0, 500) ?? null },
    });
  }
}

/**
 * The first failed step's error, carried onto the run even when the run itself
 * finishes DONE.
 *
 * A run that sent nothing because SMTP was down still completes — every later
 * step has to keep working — so without this breadcrumb the one run an owner
 * needs to find looks exactly like the hundred that worked. `GET
 * /workflows/:id/runs` already selects `lastError`; it simply had nothing to
 * show (`failed-automation-done`).
 */
function stepFailure(ctx: WorkflowContext): string | null {
  const err = ctx.context?.__lastStepError;
  return typeof err === 'string' && err ? err : null;
}
