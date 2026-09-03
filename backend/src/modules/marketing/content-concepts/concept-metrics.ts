import { PrismaService } from '../../../prisma/prisma.service';

/** What one concept's published posts actually earned. */
export interface ConceptMetrics {
  /** DISTINCT posts that reached at least one PUBLISHED target. */
  postIds: Set<string>;
  impressions: number;
  engagements: number;
}

/**
 * Walks the chain from concepts to the daily metrics of the posts they became,
 * and returns the totals keyed by concept id.
 *
 *   ContentConcept.id
 *     ← SocialCampaignItem.contentConceptId    soft ref, no Prisma relation
 *     → SocialCampaignItem.socialPostId        soft ref, no Prisma relation
 *       → SocialPostTarget.postId              (PUBLISHED targets only)
 *         → SocialPostMetric.targetId          (daily rows, summed per target)
 *
 * Lives here rather than inside either caller because two read models need the
 * same walk grouped differently — `AnglePerformanceService` groups by angle,
 * `ContentLineService` by batch — and a tenant-scoped five-level join copied
 * into two files is precisely where a `workspaceId` goes missing from one copy
 * and nobody notices. Both concept links are soft references, so there is no
 * database-side tenant guarantee to inherit: every query below is bounded by
 * `workspaceId` at its own level.
 *
 * Returns an EMPTY map when the chain runs dry at any level. Callers decide what
 * empty means for them — "no data yet" is a different sentence from "measured
 * and found nothing", and only the caller knows which one it is telling.
 */
export async function walkConceptMetrics(
  prisma: PrismaService,
  workspaceId: string,
  conceptIds: string[],
): Promise<Map<string, ConceptMetrics>> {
  const empty = new Map<string, ConceptMetrics>();
  if (conceptIds.length === 0) return empty;

  const items = await prisma.socialCampaignItem.findMany({
    where: { workspaceId, contentConceptId: { in: conceptIds }, socialPostId: { not: null } },
    select: { contentConceptId: true, socialPostId: true },
  });
  if (items.length === 0) return empty;

  const targets = await prisma.socialPostTarget.findMany({
    where: {
      workspaceId,
      postId: { in: items.map((i) => i.socialPostId as string) },
      status: 'PUBLISHED',
    },
    select: { id: true, postId: true },
  });
  if (targets.length === 0) return empty;

  const sums = await prisma.socialPostMetric.groupBy({
    by: ['targetId'],
    where: { workspaceId, targetId: { in: targets.map((t) => t.id) } },
    _sum: { impressions: true, engagements: true },
  });

  const conceptOfPost = new Map<string, string>();
  for (const item of items) {
    conceptOfPost.set(item.socialPostId as string, item.contentConceptId as string);
  }

  const totalsOfTarget = new Map(
    sums.map((s) => [
      s.targetId,
      { impressions: s._sum?.impressions ?? 0, engagements: s._sum?.engagements ?? 0 },
    ]),
  );

  // One post published to four networks is ONE piece of content that worked or
  // did not; counting its targets separately would let a wide fanout clear a
  // ranking floor on its own. Reach still sums across targets — that part is
  // genuinely per-network — but the post count does not.
  const out = new Map<string, ConceptMetrics>();
  for (const target of targets) {
    const conceptId = conceptOfPost.get(target.postId);
    if (!conceptId) continue;
    const bucket =
      out.get(conceptId) ?? { postIds: new Set<string>(), impressions: 0, engagements: 0 };
    const totals = totalsOfTarget.get(target.id);
    bucket.impressions += totals?.impressions ?? 0;
    bucket.engagements += totals?.engagements ?? 0;
    bucket.postIds.add(target.postId);
    out.set(conceptId, bucket);
  }
  return out;
}
