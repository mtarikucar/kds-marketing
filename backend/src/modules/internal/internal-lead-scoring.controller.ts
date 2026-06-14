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
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';
import { SubmitLeadScoresDto } from './lead-scores.dto';

const DEFAULT_DAILY_CAP = 100;
const SKIP_STATUSES = ['WON', 'LOST'];

/**
 * The lead-scoring routine's surface:
 *
 *   GET  /api/internal/lead-scoring/jobs
 *     One job per ACTIVE workspace with unscored active leads (scoredAt null,
 *     status not WON/LOST), capped per workspace. Carries the lead fields + product
 *     context the routine needs to score fit/value.
 *
 *   POST /api/internal/lead-scoring/:workspaceId/scores
 *     Write aiScore/aiScoreReason/scoredAt onto each lead — guarded so a lead
 *     scored since the GET is never re-scored, and cross-tenant writes can't happen.
 *
 * Guarded by ROUTINE_TOKEN. Advisory score only — never touches priority/status.
 * No sending, no credits.
 */
@Controller('internal/lead-scoring')
@UseGuards(RoutineTokenGuard)
export class InternalLeadScoringController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private dailyCap(): number {
    const raw = parseInt(
      this.config.get<string>('ROUTINE_LEADSCORE_DAILY_CAP') ?? '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
  }

  @Get('jobs')
  async jobs() {
    const cap = this.dailyCap();
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productDescription: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const leads = await this.prisma.lead.findMany({
        where: {
          workspaceId: ws.id,
          scoredAt: null,
          status: { notIn: SKIP_STATUSES },
        },
        orderBy: { createdAt: 'asc' },
        take: cap,
        select: {
          id: true,
          businessName: true,
          businessType: true,
          source: true,
          city: true,
          region: true,
          tableCount: true,
          branchCount: true,
          currentSystem: true,
          notes: true,
        },
      });
      if (leads.length === 0) continue;
      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        productDescription: ws.productDescription,
        leads: leads.map((l) => ({
          leadId: l.id,
          businessName: l.businessName,
          businessType: l.businessType,
          source: l.source,
          city: l.city,
          region: l.region,
          tableCount: l.tableCount,
          branchCount: l.branchCount,
          currentSystem: l.currentSystem,
          notes: l.notes,
        })),
      });
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post(':workspaceId/scores')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitLeadScoresDto,
  ): Promise<{ scored: number; skipped: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    let scored = 0;
    for (const s of dto.scores) {
      // Guarded write: only an as-yet-unscored lead in THIS workspace. Re-scoring
      // and cross-tenant writes are both impossible.
      const res = await this.prisma.lead.updateMany({
        where: { id: s.leadId, workspaceId, scoredAt: null },
        data: { aiScore: s.score, aiScoreReason: s.reason, scoredAt: new Date() },
      });
      scored += res.count;
    }

    return { scored, skipped: dto.scores.length - scored };
  }
}
