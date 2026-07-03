import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** Provider-reported organic counts for one published target on one UTC day. */
export interface OrganicInsights {
  impressions?: number;
  reach?: number;
  engagements?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  videoViews?: number;
  leads?: number;
  raw?: unknown;
}

const COUNT_FIELDS = [
  'impressions',
  'reach',
  'engagements',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'videoViews',
  'leads',
] as const;

/**
 * Organic performance of published social posts — the organic mirror of
 * AdMetric. The `(targetId, date)` unique index makes a re-pull idempotent
 * (upsert, never duplicate), exactly like ads-pull. The Performance Loop reads
 * these to attribute reach/engagement to a specific piece of content.
 */
@Injectable()
export class SocialPostMetricService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalize any date/ISO-day to UTC midnight (matches the @db.Date column). */
  static utcDay(d: Date | string): Date {
    const iso = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
    return new Date(`${iso}T00:00:00.000Z`);
  }

  /** Idempotent upsert of one target's insights for one UTC day. */
  async upsert(workspaceId: string, targetId: string, date: Date | string, m: OrganicInsights): Promise<void> {
    const day = SocialPostMetricService.utcDay(date);
    if (Number.isNaN(day.getTime())) return;
    const counts: Record<string, number> = {};
    for (const f of COUNT_FIELDS) counts[f] = clampCount((m as Record<string, unknown>)[f]);
    const raw = (m.raw ?? undefined) as Prisma.InputJsonValue | undefined;

    await this.prisma.socialPostMetric.upsert({
      where: { targetId_date: { targetId, date: day } },
      create: { workspaceId, targetId, date: day, ...counts, ...(raw !== undefined ? { raw } : {}) },
      update: { ...counts, ...(raw !== undefined ? { raw } : {}), pulledAt: new Date() },
    });
  }

  /** Bulk idempotent ingest (best-effort per row; a bad row never aborts the batch). */
  async ingestBatch(
    workspaceId: string,
    rows: Array<{ targetId: string; date: Date | string; insights: OrganicInsights }>,
  ): Promise<number> {
    let ok = 0;
    for (const r of rows) {
      try {
        await this.upsert(workspaceId, r.targetId, r.date, r.insights);
        ok++;
      } catch {
        /* skip the bad row, keep ingesting */
      }
    }
    return ok;
  }

  /** Latest-day metric row per target for a post (for the content report). */
  latestForPost(workspaceId: string, postId: string) {
    return this.prisma.socialPostMetric.findMany({
      where: { workspaceId, target: { postId } },
      orderBy: { date: 'desc' },
    });
  }
}

/** Coerce an untrusted value to a non-negative integer count. */
function clampCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
