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
import { RoutineTokenGuard } from './routine-token.guard';
import { SubmitInsightDigestDto } from './insight-digest.dto';

const PERIOD_DAYS = 7;
const DUE_AFTER_DAYS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review statuses that represent a received (responded-to) review, not just a
 * request. A Review row is created at REQUEST time (status 'REQUESTED',
 * createdAt=now) before any response; the rating/answer arrives later via
 * submitRating which bumps only updatedAt and sets one of these statuses.
 * Counting by createdAt+no-status-filter inflates the KPI with pending requests.
 */
const RECEIVED_STATUSES = ['PUBLIC_ROUTED', 'PRIVATE_FEEDBACK', 'REPLIED'] as const;

/**
 * The insight-digest routine's surface:
 *
 *   GET  /api/internal/insights/jobs
 *     One job per ACTIVE workspace that (a) has NOT been digested in the last
 *     DUE_AFTER_DAYS (weekly-due) and (b) had activity in the trailing
 *     PERIOD_DAYS. The backend computes the KPI snapshot; the routine writes the
 *     narrative from it.
 *
 *   POST /api/internal/insights/:workspaceId/digest
 *     Persist the AI digest (metrics snapshot + body). The new row is what drops
 *     the workspace out of "weekly-due" next run.
 *
 * Guarded by ROUTINE_TOKEN. No sending, no credits.
 */
@Controller('internal/insights')
@UseGuards(RoutineTokenGuard)
export class InternalInsightsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('jobs')
  async jobs() {
    const now = Date.now();
    const periodStart = new Date(now - PERIOD_DAYS * DAY_MS);
    const periodEnd = new Date(now);
    const dueCutoff = new Date(now - DUE_AFTER_DAYS * DAY_MS);

    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, defaultLanguage: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const recent = await this.prisma.insightDigest.findFirst({
        where: { workspaceId: ws.id, createdAt: { gte: dueCutoff } },
        select: { id: true },
      });
      if (recent) continue; // weekly-due: already digested this week

      const [leadsNew, leadsTotal, reviewsNew, ratingAgg, campaignsSent] =
        await Promise.all([
          this.prisma.lead.count({ where: { workspaceId: ws.id, createdAt: { gte: periodStart } } }),
          this.prisma.lead.count({ where: { workspaceId: ws.id } }),
          // Count RECEIVED reviews (status set by submitRating), not requests.
          // A Review is created at request time (REQUESTED, createdAt=now);
          // submitRating sets the status and bumps updatedAt — use updatedAt + status filter.
          this.prisma.review.count({
            where: {
              workspaceId: ws.id,
              status: { in: [...RECEIVED_STATUSES] },
              updatedAt: { gte: periodStart },
            },
          }),
          this.prisma.review.aggregate({
            _avg: { rating: true },
            where: {
              workspaceId: ws.id,
              status: { in: [...RECEIVED_STATUSES] },
              updatedAt: { gte: periodStart },
              rating: { not: null },
            },
          }),
          this.prisma.campaign.count({ where: { workspaceId: ws.id, status: 'SENT', completedAt: { gte: periodStart } } }),
        ]);

      if (leadsNew === 0 && reviewsNew === 0 && campaignsSent === 0) continue; // activity gate

      const rawAvg = ratingAgg._avg.rating;
      const avgRating =
        rawAvg === null || rawAvg === undefined ? null : Math.round(rawAvg * 10) / 10;

      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        defaultLanguage: ws.defaultLanguage,
        metrics: { leadsNew, leadsTotal, reviewsNew, avgRating, campaignsSent },
      });
    }

    return {
      generatedAt: periodEnd.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      jobs,
    };
  }

  @Post(':workspaceId/digest')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitInsightDigestDto,
  ): Promise<{ id: string }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    // ── idempotency guard ──────────────────────────────────────────────────
    // Best-effort: if a digest was already created in the last DUE_AFTER_DAYS,
    // return its id instead of inserting a duplicate. Narrows the dup window on
    // overlapping re-fires without needing a unique constraint migration.
    const recentCutoff = new Date(Date.now() - DUE_AFTER_DAYS * DAY_MS);
    const existing = await this.prisma.insightDigest.findFirst({
      where: { workspaceId, createdAt: { gte: recentCutoff } },
      select: { id: true },
    });
    if (existing) return { id: existing.id };

    const digest = await this.prisma.insightDigest.create({
      data: {
        workspaceId,
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
        metrics: dto.metrics as Prisma.InputJsonValue,
        body: dto.body,
      },
      select: { id: true },
    });

    return { id: digest.id };
  }
}
