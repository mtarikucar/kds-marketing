import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { ResearchJobService } from './research-job.service';
import { ResearchWorkerService } from './research-worker.service';

export const RESEARCH_RUN_KIND = 'research.run';

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
    const jobs = await this.jobs.buildJobs();
    if (jobs.length === 0) return;
    let skipped = 0;
    for (const j of jobs) {
      if (!(await this.hasBackgroundHeadroom(j.workspaceId))) {
        skipped++;
        continue;
      }
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
    this.logger.log(
      `research-nightly enqueued ${jobs.length - skipped} profile run(s)` +
        (skipped ? `, skipped ${skipped} without credit headroom` : ''),
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
