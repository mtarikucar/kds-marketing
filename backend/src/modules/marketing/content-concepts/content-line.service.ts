import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { walkConceptMetrics } from './concept-metrics';

/** How many batches the hub asks for by default. */
export const DEFAULT_BATCH_LIMIT = 20;
export const MAX_BATCH_LIMIT = 100;

export interface BatchSummary {
  batchId: string;
  /** The idea exactly as it was pasted — the card's title is the ask itself. */
  sourceIdea: string;
  createdAt: Date;
  /** Where the CONCEPTS stand: has a human looked at them yet. */
  concepts: {
    total: number;
    awaitingReview: number;
    approved: number;
    discarded: number;
  };
  /** Where the approved concepts stand once they became campaign items. */
  production: {
    generating: number;
    needsApproval: number;
    scheduled: number;
    published: number;
    failed: number;
  };
  /**
   * Reach across everything this batch published, or `null` when it has
   * published nothing.
   *
   * Null rather than 0 on purpose: zero says "measured, and nobody saw it",
   * which on unpublished work reads as a failure that has not happened yet.
   */
  reach: number | null;
}

/**
 * One card per idea: what was proposed, what was approved, what is being made,
 * what went out, and what it earned.
 *
 * `ContentConcept.batchId` has grouped "these N concepts came from that one
 * idea" since the concept machinery shipped, and appeared NOWHERE in the
 * frontend — the database knew the grouping and no screen did, so a fikir's
 * life was spread across five surfaces (concepts in MCP only, production in
 * social campaigns, posts in the calendar, outreach in distribution, numbers in
 * reports). This read model is what lets one screen tell the whole story.
 *
 * It deliberately returns COUNTS and a link key, not the concepts themselves:
 * the hub is a branching point, and re-rendering concept or campaign detail
 * here would be the second implementation of a surface that already exists.
 */
@Injectable()
export class ContentLineService {
  constructor(private readonly prisma: PrismaService) {}

  async batches(workspaceId: string, limit = DEFAULT_BATCH_LIMIT): Promise<BatchSummary[]> {
    const take = Math.min(Math.max(1, Math.trunc(limit)), MAX_BATCH_LIMIT);

    // Concepts carry the batch, so they are the spine. Ordered newest-first here
    // so the grouping below inherits that order without a second sort.
    const concepts = await this.prisma.contentConcept.findMany({
      where: { workspaceId },
      select: { id: true, batchId: true, sourceIdea: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (concepts.length === 0) return [];

    const conceptIds = concepts.map((c) => c.id);

    // Production status per concept. This is a second read of the item table —
    // `walkConceptMetrics` reads it too, for the post ids — because the two
    // answers are wanted at different grains and merging them would push the
    // walk's shape into this service's needs. Both are small, workspace-bounded
    // reads on an indexed column, and this runs on page load, not per request in
    // a loop.
    const items = await this.prisma.socialCampaignItem.findMany({
      where: { workspaceId, contentConceptId: { in: conceptIds } },
      select: { contentConceptId: true, status: true },
    });
    const itemStatusOfConcept = new Map(
      items.map((i) => [i.contentConceptId as string, String(i.status)]),
    );

    const perConcept = await walkConceptMetrics(this.prisma, workspaceId, conceptIds);

    const byBatch = new Map<string, BatchSummary>();
    for (const concept of concepts) {
      const batch =
        byBatch.get(concept.batchId) ??
        {
          batchId: concept.batchId,
          sourceIdea: concept.sourceIdea,
          createdAt: concept.createdAt,
          concepts: { total: 0, awaitingReview: 0, approved: 0, discarded: 0 },
          production: {
            generating: 0,
            needsApproval: 0,
            scheduled: 0,
            published: 0,
            failed: 0,
          },
          reach: null,
        };

      batch.concepts.total += 1;
      if (concept.status === 'PROPOSED') batch.concepts.awaitingReview += 1;
      else if (concept.status === 'APPROVED') batch.concepts.approved += 1;
      else if (concept.status === 'DISCARDED') batch.concepts.discarded += 1;

      switch (itemStatusOfConcept.get(concept.id)) {
        case 'GENERATING':
          batch.production.generating += 1;
          break;
        case 'NEEDS_APPROVAL':
          batch.production.needsApproval += 1;
          break;
        // An APPROVED item is waiting for its slot exactly as a SCHEDULED one
        // is: from the card's point of view both are "planned, not out yet".
        case 'APPROVED':
        case 'SCHEDULED':
          batch.production.scheduled += 1;
          break;
        case 'PUBLISHED':
          batch.production.published += 1;
          break;
        case 'FAILED':
          batch.production.failed += 1;
          break;
        default:
          break;
      }

      const metrics = perConcept.get(concept.id);
      if (metrics) batch.reach = (batch.reach ?? 0) + metrics.reach;

      // The oldest concept in a batch dates it — they were all created in one
      // call, but a clock skew of milliseconds should not reorder the list.
      if (concept.createdAt < batch.createdAt) batch.createdAt = concept.createdAt;

      byBatch.set(concept.batchId, batch);
    }

    // Sorted HERE rather than inherited from the concept query's `orderBy`.
    // The loop above pulls each batch's date back to its oldest concept, so a
    // batch can end up dated earlier than the row that introduced it — insertion
    // order and final order are not the same list. Sorting the grouped result is
    // the only place the "newest first" contract can actually hold.
    return [...byBatch.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, take);
  }
}
