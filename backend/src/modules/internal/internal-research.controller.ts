import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ResearchRoutineTokenGuard } from './research-routine-token.guard';
import { ResearchJobService } from '../marketing/research/research-job.service';
import { MarketingLeadsIngestService } from '../marketing/services/marketing-leads-ingest.service';
import { IngestLeadsDto } from '../marketing/dto/ingest-leads.dto';
import { IsString, IsNotEmpty } from 'class-validator';

class SubmitResearchLeadsDto extends IngestLeadsDto {
  @IsString() @IsNotEmpty()
  profileId: string;
}

/**
 * External research routine surface — re-exposes ResearchJobService's work-list
 * and the quota-clipped ingest path over HTTP so a cloud-hosted research agent
 * can operate without in-process AI credentials.
 *
 *   GET  /api/internal/research/jobs
 *     One job per ACTIVE ResearchProfile of every ACTIVE, quota-remaining
 *     workspace. Carries the same shape ResearchJob used before the native
 *     in-process engine was introduced.
 *
 *   POST /api/internal/research/jobs/:workspaceId/leads
 *     Ingest a batch of qualified candidates directly as Leads (quota-clipped,
 *     deduped, auto-assigned). Returns { created, skipped, clipped, errors, quota }.
 *
 * Guarded by RESEARCH_ROUTINE_TOKEN (x-research-token header) — a separate
 * principal from ROUTINE_TOKEN and INTERNAL_SERVICE_TOKEN.
 */
@Controller('internal/research')
@UseGuards(ResearchRoutineTokenGuard)
export class InternalResearchController {
  constructor(
    private readonly jobs: ResearchJobService,
    private readonly ingest: MarketingLeadsIngestService,
  ) {}

  @Get('jobs')
  async listJobs() {
    const jobs = await this.jobs.buildJobs();
    return {
      generatedAt: new Date().toISOString(),
      jobs: jobs.map((j) => ({
        ...j,
        // leadRules: null — placeholder for future workspace-level rule config
        leadRules: null,
      })),
    };
  }

  @Post('jobs/:workspaceId/leads')
  @HttpCode(200)
  async submitLeads(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitResearchLeadsDto,
  ) {
    const job = await this.jobs.buildJob(workspaceId, dto.profileId);
    if (!job) {
      throw new NotFoundException('Workspace or profile not found, or quota exhausted');
    }
    return this.ingest.ingest(workspaceId, { leads: dto.leads });
  }
}
