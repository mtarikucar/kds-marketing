import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { PlatformAiSpendService } from '../ai/platform-ai-spend.service';
import { ResearchJobService } from './research-job.service';
import { ResearchWorkerService } from './research-worker.service';

export const RESEARCH_RUN_KIND = 'research.run';

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

  private async handle(job: ClaimedJob): Promise<void> {
    const profileId = (job.payload as { profileId?: string })?.profileId;
    if (!profileId) return;
    const built = await this.jobs.buildJob(job.workspaceId, profileId);
    if (!built) return; // profile paused/deleted or quota exhausted since enqueue
    await this.worker.runProfile(built);
  }
}
