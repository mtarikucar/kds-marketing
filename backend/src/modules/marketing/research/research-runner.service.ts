import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { PlatformAiSpendService } from '../ai/platform-ai-spend.service';
import { ResearchJobService } from './research-job.service';
import { ResearchWorkerService } from './research-worker.service';
import { ResearchLeaseService } from './research-lease.service';
import { RESEARCH_RUN_KIND } from './research-kinds';

// Re-exported so every existing importer keeps its `from './research-runner.service'`
// path. The constant itself lives in the import-free `research-kinds.ts` because
// the generic ScheduledJobRunnerService now names it in its claim predicate and
// must not import this file back.
export { RESEARCH_RUN_KIND };

/**
 * Hard ceilings on the UNATTENDED lane, independent of any customer's plan.
 *
 * `hasBackgroundHeadroom` below asks whether the WORKSPACE has allowance left,
 * which is the right question for protecting the customer and the wrong one for
 * protecting us: an unlimited plan answers "yes" forever, so on exactly the
 * workspaces that run the most, the only brake on a nightly Opus tool-loop was
 * the number of profiles somebody happened to create.
 *
 * Measured cost per research turn (AiUsageLog, 90 days): ~$0.094 on Opus, and a
 * run is up to MAX_ITERS=8 turns — call it $0.75 a run. These defaults put the
 * nightly worst case at roughly $30 rather than "however many profiles exist".
 * Tune with real numbers from `jeeta.get_ai_usage` / GET /ai/usage/breakdown.
 */
const MAX_NIGHTLY_RUNS_PER_WORKSPACE = Number(
  process.env.RESEARCH_NIGHTLY_MAX_PER_WORKSPACE ?? 10,
);
const MAX_NIGHTLY_RUNS_TOTAL = Number(process.env.RESEARCH_NIGHTLY_MAX_TOTAL ?? 40);

/**
 * Drives the native AI Research engine: a nightly @Cron enqueues one
 * `research.run` ScheduledJob per active profile (deduped by profileId), and the
 * registered handler runs the bounded ResearchWorkerService for that profile.
 * Also exposes enqueueNow() for the in-product "Run now". Inert end-to-end when
 * no source providers are configured (the worker short-circuits).
 */
@Injectable()
export class ResearchRunnerService implements OnModuleInit {
  private readonly logger = new Logger(ResearchRunnerService.name);

  constructor(
    private readonly scheduledJob: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly jobs: ResearchJobService,
    private readonly worker: ResearchWorkerService,
    private readonly credits: AiCreditsService,
    private readonly platformSpend: PlatformAiSpendService,
    // The lane resolver and the takeover record. NOT a cycle:
    // ResearchLeaseService knows nothing about this file.
    private readonly lease: ResearchLeaseService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(RESEARCH_RUN_KIND, (job) => this.handle(job));
  }

  /**
   * Nightly: fan out one deduped research job per active profile — but only for
   * workspaces that still have credit headroom.
   *
   * A research run is the most expensive thing in the product: a per-turn Opus
   * tool-loop plus live crawl spend, roughly 30 credits at a typical four
   * turns. Run unattended every night per profile, it can consume a plan's
   * ENTIRE monthly allowance on its own — and then every interactive AI
   * surface the customer actually asked for starts refusing, having spent
   * their credits on a cron they never touched.
   *
   * So the background lane yields first: it stops once the allowance is mostly
   * gone, leaving the remainder for whatever the customer does by hand. It
   * never touches prepaid credits either — those were bought deliberately, and
   * spending them on a background job while the customer sleeps is not a
   * decision this cron gets to make.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'research-nightly' })
  async nightly(): Promise<void> {
    // OUR ceiling, checked before the customer's. Every other guard here asks
    // whether the workspace has allowance left, which an unlimited plan always
    // answers yes to — so this is the only thing standing between a nightly
    // Opus fan-out and the vendor bill.
    if (!(await this.platformSpend.mayRunBackground())) return;

    const jobs = await this.jobs.buildJobs();
    if (jobs.length === 0) return;
    let skipped = 0;
    let cappedWorkspace = 0;
    let cappedTotal = 0;
    let enqueued = 0;
    const perWorkspace = new Map<string, number>();
    for (const j of jobs) {
      if (!(await this.hasBackgroundHeadroom(j.workspaceId))) {
        skipped++;
        continue;
      }
      // The plan-based check above cannot say no to an unlimited plan, so the
      // absolute ceilings do. Skipped profiles are not lost — they are picked
      // up on a later night, and "Run now" is unaffected.
      if (enqueued >= MAX_NIGHTLY_RUNS_TOTAL) {
        cappedTotal++;
        continue;
      }
      const used = perWorkspace.get(j.workspaceId) ?? 0;
      if (used >= MAX_NIGHTLY_RUNS_PER_WORKSPACE) {
        cappedWorkspace++;
        continue;
      }
      perWorkspace.set(j.workspaceId, used + 1);
      enqueued++;
      await this.scheduledJob
        .schedule({
          workspaceId: j.workspaceId,
          kind: RESEARCH_RUN_KIND,
          runAt: new Date(),
          payload: { profileId: j.profile.id },
          dedupKey: `research:${j.profile.id}`,
          maxAttempts: 2,
        })
        .catch((e) => this.logger.warn(`enqueue failed for profile ${j.profile.id}: ${e?.message ?? e}`));
    }
    // Never let a cap truncate silently: a quietly halved research night looks
    // exactly like "the engine found nothing".
    this.logger.log(
      `research-nightly enqueued ${enqueued}/${jobs.length} profile run(s)` +
        (skipped ? `, skipped ${skipped} without credit headroom` : '') +
        (cappedWorkspace
          ? `, deferred ${cappedWorkspace} over the ${MAX_NIGHTLY_RUNS_PER_WORKSPACE}/workspace cap`
          : '') +
        (cappedTotal
          ? `, deferred ${cappedTotal} over the ${MAX_NIGHTLY_RUNS_TOTAL} nightly cap`
          : ''),
    );
  }

  /**
   * Is there room for a BACKGROUND run without eating the customer's month?
   *
   * Reserves the last quarter of the monthly allowance for interactive use.
   * Unlimited plans always pass; a plan with no allowance never runs the cron
   * (its prepaid balance is not this job's to spend).
   */
  private async hasBackgroundHeadroom(workspaceId: string): Promise<boolean> {
    try {
      // MONEY first, then credits. The credit question below is the right one
      // for protecting the customer's allowance and the wrong one for
      // protecting the bill: `limit === -1` returns true forever, so on exactly
      // the workspaces that run the most there was no brake at all. Ten nightly
      // runs at roughly $0.25 each is about $75 a month from a single
      // workspace, and nothing anywhere said no.
      if (!(await this.platformSpend.mayWorkspaceRunBackground(workspaceId))) return false;

      const { limit, used } = await this.credits.usage(workspaceId);
      if (limit === -1) return true;
      if (limit <= 0) return false;
      return used < limit * 0.75;
    } catch (e) {
      // Never let a metering hiccup silently stop research for everyone.
      this.logger.warn(`headroom check failed for ${workspaceId}: ${(e as Error)?.message ?? e}`);
      return true;
    }
  }

  /** On-demand "Run now" for a single profile. */
  async enqueueNow(workspaceId: string, profileId: string): Promise<void> {
    await this.scheduledJob.schedule({
      workspaceId,
      kind: RESEARCH_RUN_KIND,
      runAt: new Date(),
      payload: { profileId },
      dedupKey: `research:${profileId}`,
      maxAttempts: 2,
    });
  }

  /**
   * Run one queued profile — and, if this job was reserved for somebody else,
   * say so.
   *
   * Reaching this handler on a workspace whose effective lane is `MCP` means
   * exactly one thing: the owner's Claude was offered the job first and did not
   * take it inside `RESEARCH_MCP_GRACE_HOURS`, so the grace window in
   * `ScheduledJobRunnerService.claimBatch` expired and the job was handed to us
   * anyway. That fallback is what makes defaulting to MCP safe — research can
   * no longer silently stop — but an UNRECORDED fallback is the same trap from
   * the other side: research keeps appearing, the owner never discovers their
   * scheduled task died, and the bill this feature exists to move stays with us
   * indefinitely. So the takeover is stamped on the job with what it cost, and
   * the home timeline reads it back by name.
   *
   * The stamp is written in a `finally`, for two reasons. A run that THREW
   * still spent vendor money before it threw, and its retry accumulates onto
   * the same row, so recording only on success would report a takeover night as
   * free. And the recording is best-effort: a failed JSON stamp must never turn
   * a completed research night into a retry, and three of those into a DLQ.
   */
  private async handle(job: ClaimedJob): Promise<void> {
    const profileId = (job.payload as { profileId?: string })?.profileId;
    if (!profileId) return;
    const built = await this.jobs.buildJob(job.workspaceId, profileId);
    if (!built) return; // profile paused/deleted or quota exhausted since enqueue

    // Read AFTER buildJob: a job that can produce nothing is not a takeover of
    // anything, and flagging it would put a "your drainer is broken" line on
    // the panel for a night where no work — and no cost — ever existed.
    const takeover = (await this.lease.modeFor(job.workspaceId)) === 'MCP';
    const startedAt = new Date();
    try {
      await this.worker.runProfile(built);
    } finally {
      if (takeover) {
        await this.lease
          .recordPlatformTakeover(job.workspaceId, job.id, startedAt)
          .catch((e) =>
            this.logger.warn(
              `takeover record failed for job ${job.id} (ws ${job.workspaceId}): ${(e as Error)?.message ?? e}`,
            ),
          );
      }
    }
  }
}
