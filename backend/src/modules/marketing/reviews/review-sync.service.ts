import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { anyReviewSyncConfigured, fetchSourceReviews, ReviewSourceRow } from './review-clients';

/** A synced review at or below this rating raises ReviewReceived (workflow). */
const LOW_RATING_THRESHOLD = 4;

/**
 * Hourly review-sync sweep for connected Google Business / Facebook sources
 * (Epic 13, needs-external — INERT until a provider app env + a sealed page/
 * location token are present). Mirrors AdsPullService/RecordingSyncService: a
 * single-replica advisory lock guards the tick. The DUE-source read is the one
 * cross-workspace system read (whitelisted in the scoping fitness test); the
 * upsert is idempotent on (sourceId, externalReviewId) so a re-sync never
 * duplicates, and a low-rating NEW review raises ReviewReceived (deduped by the
 * outbox key) → the review.received workflow trigger.
 */
@Injectable()
export class ReviewSyncService {
  private readonly logger = new Logger(ReviewSyncService.name);
  private static readonly BATCH = 100;
  /** Re-sync a source at most this often (reviews change slowly + API quota). */
  private static readonly SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'reviews-sync' })
  async syncDueSources(): Promise<void> {
    if (!anyReviewSyncConfigured()) return; // no provider app → inert
    await withAdvisoryLock(
      this.prisma,
      'reviews:sync',
      async () => {
        // System-global read: ACTIVE sources with a token, across ALL workspaces
        // (whitelisted in the scoping test). The per-source writes below are
        // workspace-scoped / id-keyed.
        const syncBefore = new Date(Date.now() - ReviewSyncService.SYNC_INTERVAL_MS);
        const due = await this.prisma.reviewSource.findMany({
          where: {
            syncStatus: 'ACTIVE',
            accessToken: { not: null },
            // Staleness watermark (mirrors ads-pull/recording-sync): a source is
            // only re-fetched once it's never been synced or is past the interval,
            // so the hourly tick doesn't burn provider quota on slow-changing data.
            OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: syncBefore } }],
          },
          orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
          take: ReviewSyncService.BATCH,
          select: { id: true, workspaceId: true, type: true, placeId: true, externalRef: true, accessToken: true },
        });
        if (due.length === 0) return;

        let synced = 0;
        for (const source of due) {
          try {
            const reviews = await fetchSourceReviews(source as ReviewSourceRow);
            for (const r of reviews) {
              synced += await this.upsertReview(source.workspaceId, source.id, source.type, r);
            }
            await this.prisma.reviewSource.update({
              where: { id: source.id },
              data: { lastSyncedAt: new Date(), lastError: null },
            });
          } catch (e: any) {
            // markError-style: stamp the failure so the source rotates to the
            // back and one bad source never aborts the sweep.
            await this.prisma.reviewSource
              .update({ where: { id: source.id }, data: { lastSyncedAt: new Date(), lastError: String(e?.message ?? e).slice(0, 500) } })
              .catch(() => undefined);
            this.logger.error(`review source ${source.id} sync failed: ${e?.message ?? e}`);
          }
        }
        if (synced > 0) this.logger.log(`reviews sweep: ${synced} new review(s)`);
      },
      this.logger,
    );
  }

  /** Idempotent upsert of one synced review; returns 1 if newly created. */
  private async upsertReview(
    workspaceId: string,
    sourceId: string,
    type: string,
    r: { externalReviewId: string; rating: number | null; text: string | null; authorName: string | null; authoredAt: Date | null },
  ): Promise<number> {
    const existing = await this.prisma.review.findFirst({
      where: { workspaceId, sourceId, externalReviewId: r.externalReviewId },
      select: { id: true },
    });
    if (existing) {
      // Keep an existing review fresh (text/rating can change), but don't re-emit.
      await this.prisma.review.update({
        where: { id: existing.id },
        data: { rating: r.rating, text: r.text, authorName: r.authorName, authoredAt: r.authoredAt },
      });
      return 0;
    }
    let row: { id: string };
    try {
      row = await this.prisma.review.create({
        data: {
          workspaceId,
          sourceId,
          source: type,
          externalReviewId: r.externalReviewId,
          rating: r.rating,
          text: r.text,
          authorName: r.authorName,
          authoredAt: r.authoredAt,
          status: 'SYNCED',
          token: `syn_${randomBytes(16).toString('hex')}`,
        },
        select: { id: true },
      });
    } catch (e: any) {
      // Lost a race on the (sourceId, externalReviewId) unique — already synced.
      if (e?.code === 'P2002') return 0;
      throw e;
    }
    // A low-rating new review raises the workflow trigger (deduped by the key).
    if (r.rating != null && r.rating < LOW_RATING_THRESHOLD) {
      await this.outbox.append({
        type: MarketingEventTypes.ReviewReceived,
        idempotencyKey: `review-received:${row.id}`,
        payload: { workspaceId, reviewId: row.id, leadId: null, rating: r.rating, public: false, occurredAt: new Date().toISOString() },
      }).catch(() => undefined);
    }
    return 1;
  }
}
