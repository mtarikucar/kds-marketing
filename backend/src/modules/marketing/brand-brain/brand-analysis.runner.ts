import { Injectable, OnModuleInit } from '@nestjs/common';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { BrandAnalysisService, BRAND_ANALYZE_KIND } from './brand-analysis.service';

/** Registers the brand-brain.analyze handler → delegates to BrandAnalysisService.runAnalysis. */
@Injectable()
export class BrandAnalysisRunnerService implements OnModuleInit {
  constructor(
    private readonly runner: ScheduledJobRunnerService,
    private readonly analysis: BrandAnalysisService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(BRAND_ANALYZE_KIND, (job) => this.handle(job));
  }

  private async handle(job: ClaimedJob): Promise<void> {
    const runId = (job.payload as { runId?: string })?.runId;
    if (runId) await this.analysis.runAnalysis(runId);
  }
}
