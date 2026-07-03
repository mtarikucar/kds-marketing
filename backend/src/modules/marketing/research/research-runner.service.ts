import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
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
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(RESEARCH_RUN_KIND, (job) => this.handle(job));
  }

  /** Nightly: fan out one deduped research job per active profile. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'research-nightly' })
  async nightly(): Promise<void> {
    const jobs = await this.jobs.buildJobs();
    if (jobs.length === 0) return;
    for (const j of jobs) {
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
    this.logger.log(`research-nightly enqueued ${jobs.length} profile run(s)`);
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
