import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { BrandAnalysisService, BRAND_ANALYZE_KIND } from './brand-analysis.service';

/** Registers the brand-brain.analyze handler → delegates to BrandAnalysisService.runAnalysis.
 *  Also owns the time-based stale-run reaper (crash recovery) — see reapStaleRuns(). */
@Injectable()
export class BrandAnalysisRunnerService implements OnModuleInit {
  private readonly logger = new Logger(BrandAnalysisRunnerService.name);

  constructor(
    private readonly runner: ScheduledJobRunnerService,
    private readonly analysis: BrandAnalysisService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(BRAND_ANALYZE_KIND, (job) => this.handle(job));
  }

  private async handle(job: ClaimedJob): Promise<void> {
    const runId = (job.payload as { runId?: string })?.runId;
    if (runId) await this.analysis.runAnalysis(runId);
  }

  /** Crash recovery: a run stuck RUNNING far longer than any legitimate
   *  analysis (worst case ~33min: sequential Firecrawl+Apify+synthesis) means
   *  the process died mid-run. Flip it to FAILED so the wizard stops polling.
   *  Raw SQL (conflict-safe, cross-workspace sweep) — deliberately NOT a Prisma
   *  delegate call, mirroring the ScheduledJob stuck-reaper. Best-effort. */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'brand-analysis-reaper' })
  async reapStaleRuns(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "brand_analysis_runs"
        SET "status" = 'FAILED',
            "error" = 'Analysis timed out — please try again',
            "completedAt" = NOW()
        WHERE "status" = 'RUNNING'
          AND "createdAt" < NOW() - INTERVAL '45 minutes'
      `;
    } catch (e) {
      this.logger.warn(`brand-analysis reaper failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
