import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { walkConceptMetrics } from './concept-metrics';

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
 * The walk itself lives in `walkConceptMetrics` because `ContentLineService`
 * needs the same one grouped by batch instead of by angle; this service only
 * regroups its result and decides what ranks.
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

    const perConcept = await walkConceptMetrics(
      this.prisma,
      workspaceId,
      concepts.map((c) => c.id),
    );
    if (perConcept.size === 0) return COLD;

    // Regroup the per-concept totals by ANGLE. `posts` stays a set across the
    // concepts sharing an angle so one post counts once for that angle even if
    // it somehow arrives twice.
    const acc = new Map<string, { impressions: number; engagements: number; posts: Set<string> }>();
    for (const concept of concepts) {
      const metrics = perConcept.get(concept.id);
      if (!metrics) continue;
      const bucket =
        acc.get(concept.angle) ?? { impressions: 0, engagements: 0, posts: new Set<string>() };
      bucket.impressions += metrics.impressions;
      bucket.engagements += metrics.engagements;
      for (const postId of metrics.postIds) bucket.posts.add(postId);
      acc.set(concept.angle, bucket);
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
