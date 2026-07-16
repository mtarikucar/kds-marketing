import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ResearchSpendService } from '../budget/research-spend.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { BrandSynthesisService } from './brand-synthesis.service';
import { BrandSource, BrandSourceInput, BrandSourceResult } from './sources/brand-source';
import { WebsiteBrandSource } from './sources/website.source';
import { SocialBrandSource } from './sources/social.source';
import { GbpBrandSource } from './sources/gbp.source';
import { UploadBrandSource } from './sources/upload.source';

export const BRAND_ANALYZE_KIND = 'brand-brain.analyze';

@Injectable()
export class BrandAnalysisService {
  private readonly logger = new Logger(BrandAnalysisService.name);
  private readonly sources: BrandSource[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly synthesis: BrandSynthesisService,
    private readonly spend: ResearchSpendService,
    private readonly scheduledJob: ScheduledJobService,
    website: WebsiteBrandSource,
    social: SocialBrandSource,
    gbp: GbpBrandSource,
    upload: UploadBrandSource,
  ) {
    this.sources = [website, social, gbp, upload];
  }

  /** Create a QUEUED run + schedule the async analyze job (deduped per workspace). */
  async startAnalysis(workspaceId: string, inputs: BrandSourceInput): Promise<{ runId: string }> {
    const run = await this.prisma.brandAnalysisRun.create({
      data: { workspaceId, status: 'QUEUED', inputs: inputs as any },
    });
    await this.scheduledJob.schedule({
      workspaceId,
      kind: BRAND_ANALYZE_KIND,
      runAt: new Date(),
      payload: { runId: run.id },
      dedupKey: `brand-analyze:${workspaceId}`,
      maxAttempts: 2,
    });
    return { runId: run.id };
  }

  /** Workspace-scoped fetch for polling. */
  getRun(workspaceId: string, runId: string) {
    return this.prisma.brandAnalysisRun.findFirst({ where: { id: runId, workspaceId } });
  }

  /** The job body: QUEUED → RUNNING → collect all sources (isolated) → meter →
   *  synthesize → READY_FOR_REVIEW. Synthesis failure → FAILED. Idempotent: a
   *  non-QUEUED run is a no-op (a retry that already progressed). */
  async runAnalysis(runId: string): Promise<void> {
    const run = await this.prisma.brandAnalysisRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== 'QUEUED') return;
    await this.prisma.brandAnalysisRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
    try {
      const input = (run.inputs ?? {}) as BrandSourceInput;
      const results: BrandSourceResult[] = [];
      for (const src of this.sources) results.push(await src.collect(run.workspaceId, input));

      let costUsd = 0;
      for (const r of results) {
        if (r.firecrawlPages) {
          const s = await this.spend.settle(run.workspaceId, { unit: 'FIRECRAWL_PAGE', quantity: r.firecrawlPages, ref: `brand:${runId}` });
          if (s) costUsd += Number(s.amount);
        }
        if (r.apifyRuns) {
          const s = await this.spend.settle(run.workspaceId, { unit: 'APIFY_RUN', quantity: r.apifyRuns, ref: `brand:${runId}` });
          if (s) costUsd += Number(s.amount);
        }
      }

      const ws = await this.prisma.workspace.findUnique({ where: { id: run.workspaceId }, select: { defaultLanguage: true } });
      const draft = await this.synthesis.synthesize(run.workspaceId, results, ws?.defaultLanguage ?? 'tr');

      await this.prisma.brandAnalysisRun.update({
        where: { id: runId },
        data: { status: 'READY_FOR_REVIEW', sourceResults: results as any, draft: draft as any, costUsd, completedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(`brand analysis ${runId} failed: ${e instanceof Error ? e.message : e}`);
      await this.prisma.brandAnalysisRun.update({
        where: { id: runId },
        data: { status: 'FAILED', error: (e instanceof Error ? e.message : 'analysis failed').slice(0, 500), completedAt: new Date() },
      });
    }
  }
}
