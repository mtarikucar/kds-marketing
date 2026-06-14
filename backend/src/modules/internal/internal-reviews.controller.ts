import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';

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
          text: { not: null },
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
}
