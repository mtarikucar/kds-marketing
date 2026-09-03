import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * How many PUBLISHED posts an angle must carry before it is allowed to rank.
 *
 * Without a floor the first lucky post locks the line: one clip that happened
 * to land at 90% engagement outranks an angle measured over ten, the weighting
 * follows it, and every later batch is biased by a sample of one. Three is the
 * smallest number at which a rate stops being an anecdote; angles below it stay
 * VISIBLE (the panel says "not enough data yet") but carry no weight.
 */
export const MIN_POSTS_FOR_RANKING = 3;

export interface AngleStat {
  angle: string;
  /** Distinct published posts carrying this angle. */
  posts: number;
  impressions: number;
  engagements: number;
  /**
   * `engagements / impressions`, or `null` when nothing was ever shown.
   *
   * Null rather than 0 on purpose: a post with zero impressions has not been
   * measured, and calling that "0% engagement" would rank a never-delivered
   * post below a poorly-performing one, which is a judgement the data does not
   * support.
   */
  rate: number | null;
  /** `posts < MIN_POSTS_FOR_RANKING` — shown, but never ranked or weighted. */
  insufficient: boolean;
}

export interface AnglePerformance {
  /**
   * Nothing has been published yet, so there is no signal at all.
   *
   * Distinct from `angles: []` after measurement. The caller must be able to
   * say "no data yet" rather than rendering an empty list that reads like
   * "measured, and every angle scored nothing" — the same confusion between
   * empty and broken that `.catch(() => 0)` shipped in the morning briefing.
   */
  cold: boolean;
  /** Rankable angles first (best rate first), then the unrankable ones. */
  angles: AngleStat[];
  /** Normalised weights over RANKABLE angles only. Empty while cold. */
  weights: Record<string, number>;
}

/**
 * Reads how each content ANGLE actually performed, by walking the chain from a
 * concept to the daily metrics of the posts it became:
 *
 *   ContentConcept.angle
 *     ← SocialCampaignItem.contentConceptId    soft ref, no Prisma relation
 *     → SocialCampaignItem.socialPostId        soft ref, no Prisma relation
 *       → SocialPostTarget.postId              (PUBLISHED targets only)
 *         → SocialPostMetric.targetId          (daily rows, summed per target)
 *
 * Both concept links are soft references rather than foreign keys, so this
 * cannot be one nested `include`; it is four scoped queries with the ids
 * carried between them. Every query is bounded by `workspaceId` at its own
 * level — not just the first — because a soft reference offers no database-side
 * tenant guarantee to inherit.
 */
@Injectable()
export class AnglePerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async byAngle(workspaceId: string): Promise<AnglePerformance> {
    const concepts = await this.prisma.contentConcept.findMany({
      where: { workspaceId },
      select: { id: true, angle: true },
    });
    if (concepts.length === 0) return COLD;

    const items = await this.prisma.socialCampaignItem.findMany({
      where: {
        workspaceId,
        contentConceptId: { in: concepts.map((c) => c.id) },
        socialPostId: { not: null },
      },
      select: { contentConceptId: true, socialPostId: true },
    });
    if (items.length === 0) return COLD;

    const targets = await this.prisma.socialPostTarget.findMany({
      where: {
        workspaceId,
        postId: { in: items.map((i) => i.socialPostId as string) },
        status: 'PUBLISHED',
      },
      select: { id: true, postId: true },
    });
    if (targets.length === 0) return COLD;

    const sums = await this.prisma.socialPostMetric.groupBy({
      by: ['targetId'],
      where: { workspaceId, targetId: { in: targets.map((t) => t.id) } },
      _sum: { impressions: true, engagements: true },
    });

    // concept id → angle, then post id → angle.
    const angleOfConcept = new Map(concepts.map((c) => [c.id, c.angle]));
    const angleOfPost = new Map<string, string>();
    for (const item of items) {
      const angle = angleOfConcept.get(item.contentConceptId as string);
      if (angle) angleOfPost.set(item.socialPostId as string, angle);
    }

    const totalsOfTarget = new Map(
      sums.map((s) => [
        s.targetId,
        {
          impressions: s._sum?.impressions ?? 0,
          engagements: s._sum?.engagements ?? 0,
        },
      ]),
    );

    // Accumulate per angle. `posts` counts DISTINCT posts, not targets: one post
    // published to four networks is one piece of content that worked or didn't,
    // and counting it four times would let a wide-fanout post clear the ranking
    // floor on its own.
    const acc = new Map<string, { impressions: number; engagements: number; posts: Set<string> }>();
    for (const target of targets) {
      const angle = angleOfPost.get(target.postId);
      if (!angle) continue;
      const bucket =
        acc.get(angle) ?? { impressions: 0, engagements: 0, posts: new Set<string>() };
      const totals = totalsOfTarget.get(target.id);
      bucket.impressions += totals?.impressions ?? 0;
      bucket.engagements += totals?.engagements ?? 0;
      bucket.posts.add(target.postId);
      acc.set(angle, bucket);
    }
    if (acc.size === 0) return COLD;

    const stats: AngleStat[] = [...acc.entries()].map(([angle, b]) => ({
      angle,
      posts: b.posts.size,
      impressions: b.impressions,
      engagements: b.engagements,
      rate: b.impressions > 0 ? b.engagements / b.impressions : null,
      insufficient: b.posts.size < MIN_POSTS_FOR_RANKING,
    }));

    const rankable = stats.filter(isRankable);
    const rest = stats.filter((s) => !isRankable(s));
    rankable.sort((a, b) => (b.rate as number) - (a.rate as number));
    rest.sort((a, b) => b.posts - a.posts);

    const total = rankable.reduce((sum, s) => sum + (s.rate as number), 0);
    const weights: Record<string, number> = {};
    if (total > 0) {
      for (const s of rankable) weights[s.angle] = (s.rate as number) / total;
    }

    return { cold: false, angles: [...rankable, ...rest], weights };
  }
}

/** An angle only ranks when it is both measured and measurable. */
function isRankable(s: AngleStat): boolean {
  return !s.insufficient && s.rate !== null;
}

const COLD: AnglePerformance = { cold: true, angles: [], weights: {} };
