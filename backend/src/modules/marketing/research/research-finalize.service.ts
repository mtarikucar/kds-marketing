import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ResearchCandidateService } from './research-candidate.service';
import { ResearchSpendService } from '../budget/research-spend.service';
import { ResearchJob } from './research-job.service';
import { researchBatchCap, validateResearchCandidates } from './research-contract';

export interface ResearchFinalizeResult {
  /** How many of the submitted candidates survived validation and the cap. */
  researched: number;
  staged: number;
  duplicates: number;
}

/**
 * The tail of a research run, shared by both drainers.
 *
 * Validate the model's list → clip it to what the workspace can still accept →
 * stage it for review → meter the leads that actually landed → stamp the
 * profile with when it last ran and what it found.
 *
 * This is five statements, which is exactly the size of thing that gets
 * copy-pasted into the second caller and then quietly diverges. The second
 * caller here is `submit_research_candidates` over MCP, and each of the five
 * fails differently if it is dropped: no validation lets a model we do not
 * control write a malformed row the review queue ranks on; no clip stages past
 * the daily lead quota the whole pipeline is bounded by; no meter means real
 * vendor spend is never billed; no `workspaceId` on the profile stamp writes
 * into a neighbouring tenant's row.
 *
 * Staging itself is NOT reimplemented — `ResearchCandidateService.stage` stays
 * the only path into the queue, with its cross-ref contact dedup intact.
 */
@Injectable()
export class ResearchFinalizeService {
  private readonly logger = new Logger(ResearchFinalizeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: ResearchCandidateService,
    private readonly spend: ResearchSpendService,
  ) {}

  async finalize(job: ResearchJob, runId: string | null, raw: unknown[]): Promise<ResearchFinalizeResult> {
    // Bound volume relative to what can actually be accepted (cost guard).
    const list = validateResearchCandidates(raw).slice(0, researchBatchCap(job));

    const { staged, duplicates } = await this.candidates.stage(
      job.workspaceId,
      job.profile.id,
      runId,
      list,
    );
    if (staged > 0) {
      await this.spend.settle(job.workspaceId, {
        unit: 'RESEARCH_LEAD',
        quantity: staged,
        ref: runId,
      });
    }

    // Bookkeeping, not the product: the candidates are already in the review
    // queue by this point, and throwing here would strand real prospects
    // behind a failed timestamp write.
    await this.prisma.researchProfile
      .updateMany({
        where: { id: job.profile.id, workspaceId: job.workspaceId },
        data: {
          lastRunAt: new Date(),
          lastRunStats: {
            posted: list.length,
            staged,
            duplicates,
            at: new Date().toISOString(),
          },
        },
      })
      .catch((e) =>
        this.logger.warn(
          `research profile stamp failed for ${job.profile.id} (ws ${job.workspaceId}): ${(e as Error)?.message ?? e}`,
        ),
      );

    return { researched: list.length, staged, duplicates };
  }
}
