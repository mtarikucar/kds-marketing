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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ResearchTokenGuard } from './research-token.guard';
import {
  MarketingLeadsIngestService,
  IngestResult,
} from '../marketing/services/marketing-leads-ingest.service';
import { IngestLeadsDto } from '../marketing/dto/ingest-leads.dto';
import { MintResearchLeadsDto } from './research.dto';

/**
 * The nightly research routine's surface:
 *
 *   GET  /api/internal/research/jobs
 *     One job per ACTIVE profile of every ACTIVE workspace that still has
 *     daily quota left — everything the researcher needs (product context,
 *     ICP brief, geo/language, remaining quota, contract rules) in one call.
 *
 *   POST /api/internal/research/jobs/:workspaceId/leads
 *     Submit candidates for one workspace. Same quota-clipped ingest the
 *     token endpoint uses; additionally stamps the profile's lastRunAt /
 *     lastRunStats so the settings UI can show "what did last night do".
 *
 * Guarded by RESEARCH_ROUTINE_TOKEN (x-research-token) — see the guard for
 * why this is a separate principal from the core service token.
 */
@Controller('internal/research')
@UseGuards(ResearchTokenGuard)
export class InternalResearchController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: MarketingLeadsIngestService,
  ) {}

  @Get('jobs')
  async jobs() {
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        slug: true,
        productName: true,
        productUrl: true,
        productDescription: true,
        defaultLanguage: true,
        settings: true,
      },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const usage = await this.ingest.usageToday(ws.id);
      const remainingToday = usage.remaining;
      // remaining === -1 means unlimited; 0 means exhausted (or quota 0 /
      // suspended workspace per the resolver) — exhausted workspaces are
      // dropped so the routine never wastes research on them.
      if (remainingToday === 0) continue;

      const profiles = await this.prisma.researchProfile.findMany({
        where: { workspaceId: ws.id, status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          icpDescription: true,
          productPitch: true,
          geo: true,
          language: true,
          businessTypes: true,
          exclusions: true,
          lastRunAt: true,
        },
      });

      for (const profile of profiles) {
        jobs.push({
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          productName: ws.productName,
          productUrl: ws.productUrl,
          productDescription: ws.productDescription,
          defaultLanguage: ws.defaultLanguage,
          profile,
          // Quota is workspace-level and shared across its profiles: the
          // server clips on submit regardless of what the researcher does.
          remainingToday,
          maxBatchSize: 50,
          leadRules: {
            externalRef:
              'phone:+<E164> | instagram:@handle | google:<placeId> | domain:<apex> | hash:<sha1(lowercase(businessName|city))>',
            phoneFormat: 'E164',
            requiredFields: ['externalRef', 'businessName', 'businessType', 'painPoint', 'evidence', 'pitch'],
          },
        });
      }
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post('jobs/:workspaceId/leads')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: MintResearchLeadsDto,
  ): Promise<IngestResult> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    const ingestDto: IngestLeadsDto = { leads: dto.leads };
    const result = await this.ingest.ingest(workspaceId, ingestDto);

    if (dto.profileId) {
      // Best-effort run-stat stamp; never fail the submission over it.
      await this.prisma.researchProfile
        .updateMany({
          where: { id: dto.profileId, workspaceId },
          data: {
            lastRunAt: new Date(),
            lastRunStats: {
              posted: dto.leads.length,
              created: result.created,
              skipped: result.skipped,
              clipped: result.clipped,
              at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
    }

    return result;
  }
}
