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
import { SubmitReviewDraftsDto } from './routine-reviews.dto';

const DEFAULT_DAILY_CAP = 50;

/**
 * The review-draft routine's surface:
 *
 *   GET  /api/internal/reviews/pending-drafts
 *     One job per ACTIVE workspace that has private-feedback reviews still
 *     awaiting a reply — each with the workspace context the routine needs to
 *     write a good draft. Clipped to ROUTINE_REVIEW_DAILY_CAP per workspace.
 *
 *   POST /api/internal/reviews/:workspaceId/drafts   (added in Task 4)
 *
 * Guarded by ROUTINE_TOKEN (x-routine-token). The routine WRITES the draft text
 * itself (no Anthropic call here); we only serve jobs and persist results.
 */
@Controller('internal/reviews')
@UseGuards(RoutineTokenGuard)
export class InternalReviewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private dailyCap(): number {
    const raw = parseInt(
      this.config.get<string>('ROUTINE_REVIEW_DAILY_CAP') ?? '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
  }

  @Get('pending-drafts')
  async pendingDrafts() {
    const cap = this.dailyCap();
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        slug: true,
        productName: true,
        productDescription: true,
        defaultLanguage: true,
      },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const reviews = await this.prisma.review.findMany({
        where: {
          workspaceId: ws.id,
          status: 'PRIVATE_FEEDBACK',
          replyText: null,
          replyDraft: null,
          // not-null AND non-empty: an empty-text review has nothing to reply to
          text: { not: null },
          NOT: { text: '' },
        },
        orderBy: { createdAt: 'asc' },
        take: cap,
        select: { id: true, rating: true, text: true, authorName: true },
      });
      if (reviews.length === 0) continue;
      jobs.push({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        productName: ws.productName,
        productDescription: ws.productDescription,
        defaultLanguage: ws.defaultLanguage,
        reviews: reviews.map((r) => ({
          reviewId: r.id,
          rating: r.rating,
          text: r.text,
          authorName: r.authorName,
        })),
      });
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post(':workspaceId/drafts')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitReviewDraftsDto,
  ): Promise<{ written: number; skipped: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    let written = 0;
    for (const d of dto.drafts) {
      // Guarded write: only fill a STILL-empty draft, scoped to this workspace.
      // Putting replyDraft/replyText/workspaceId in the WHERE means a draft a
      // human (or the interactive button) wrote since the GET is never
      // clobbered, and a cross-workspace write is impossible.
      const res = await this.prisma.review.updateMany({
        where: {
          id: d.reviewId,
          workspaceId,
          replyDraft: null,
          replyText: null,
        },
        data: { replyDraft: d.replyDraft },
      });
      written += res.count;
    }

    return { written, skipped: dto.drafts.length - written };
  }
}
