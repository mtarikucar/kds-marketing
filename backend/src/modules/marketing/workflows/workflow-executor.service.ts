import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';
import { parseWorkflowParts, MAX_WORKFLOW_DEPTH, WorkflowStep } from './workflow-dsl.schema';

const RESUME_KIND = 'workflow.resume';
// Belt against a mis-authored goto cycle: a single advance() can execute at
// most this many steps before yielding (the DSL also hard-caps step COUNT).
const MAX_STEPS_PER_ADVANCE = 200;
const UNTIL_REPLY_FALLBACK_SEC = 86_400;

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

  /** Start a run. Returns the runId, or null if a live run already exists. */
  async start(
    workflow: { id: string; workspaceId: string; version: number; trigger: unknown; steps: unknown },
    subject: StartSubject,
    triggerPayload: Record<string, unknown>,
    depth = 0,
  ): Promise<string | null> {
    if (depth > MAX_WORKFLOW_DEPTH) {
      this.logger.warn(`workflow ${workflow.id} exceeded max chain depth ${MAX_WORKFLOW_DEPTH}`);
      return null;
    }
    let run;
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          leadId: subject.leadId ?? null,
          conversationId: subject.conversationId ?? null,
          status: 'RUNNING',
          cursor: { stepIndex: 0 },
          context: { _trigger: triggerPayload } as Prisma.InputJsonValue,
          depth,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return null; // a live run for this (workflow, lead) already exists
      }
      throw e;
    }
    await this.advance(run.id);
    return run.id;
  }

  private async resume(job: ClaimedJob): Promise<void> {
    await this.advance(job.payload.runId);
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
    try {
      steps = parseWorkflowParts(workflow.trigger, workflow.steps).steps;
    } catch (e: any) {
      await this.finish(runId, 'FAILED', `invalid DSL: ${e?.message ?? e}`);
      return;
    }

    const ctxObj = (run.context ?? {}) as Record<string, any>;
    const lead = run.leadId
      ? await this.prisma.lead.findFirst({ where: { id: run.leadId, workspaceId: run.workspaceId } })
      : null;
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
      if (stepIndex >= steps.length) {
        await this.persistContext(runId, ctx, stepIndex);
        await this.finish(runId, 'DONE', null);
        return;
      }
      const step = steps[stepIndex];
      let outcome;
      try {
        outcome = await this.handler.execute(step, ctx);
      } catch (e: any) {
        await this.recordStep(run.workspaceId, runId, stepIndex, step.type, 'FAILED', null, e?.message);
        await this.finish(runId, 'FAILED', `step ${stepIndex} (${step.type}): ${e?.message ?? e}`);
        return;
      }
      await this.recordStep(run.workspaceId, runId, stepIndex, step.type, 'DONE', outcome.output ?? null);

      if (outcome.stop) {
        await this.persistContext(runId, ctx, stepIndex);
        await this.finish(runId, 'STOPPED', null);
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
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status, lastError: error, completedAt: new Date() },
    });
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
