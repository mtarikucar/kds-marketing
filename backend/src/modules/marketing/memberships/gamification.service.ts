import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type PointSource = 'LESSON_COMPLETE' | 'COURSE_COMPLETE' | 'POST_CREATED' | 'COMMENT';
export type BadgeRule = 'POINTS' | 'LESSONS' | 'COURSES';

/** Default award values per source (kept here so the rules live in one place). */
export const POINTS: Record<PointSource, number> = {
  LESSON_COMPLETE: 10,
  COURSE_COMPLETE: 50,
  POST_CREATED: 5,
  COMMENT: 2,
};

/**
 * Epic 10c — membership gamification. Points accrue to a Lead (member) in an
 * append-only ledger; each award is idempotent per (lead, source, refId) so the
 * same lesson/course can't double-award. After an award, badge rules are
 * re-evaluated and any newly-met badge is granted (idempotent per lead+badge).
 * All reads/writes are workspace-scoped.
 */
@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Award points for an activity and re-evaluate badges. Idempotent: a duplicate
   * (workspace, lead, source, refId) is a no-op (the unique index rejects it).
   * Best-effort by design — the caller's primary action (e.g. completing a
   * lesson) must not fail because gamification hiccupped.
   */
  async award(workspaceId: string, leadId: string, source: PointSource, refId: string | null, points = POINTS[source]): Promise<void> {
    try {
      await this.prisma.pointsLedger.create({
        data: { workspaceId, leadId, source, refId, points },
      });
    } catch (e) {
      // Already awarded for this (lead, source, refId) — nothing to do.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
    await this.evaluateBadges(workspaceId, leadId);
  }

  /** Grant any badge whose rule the lead now meets (idempotent per lead+badge). */
  async evaluateBadges(workspaceId: string, leadId: string): Promise<void> {
    const badges = await this.prisma.badge.findMany({ where: { workspaceId } });
    if (badges.length === 0) return;
    const metrics = await this.metrics(workspaceId, leadId);
    for (const b of badges) {
      const value =
        b.ruleType === 'POINTS' ? metrics.points
          : b.ruleType === 'LESSONS' ? metrics.lessons
            : b.ruleType === 'COURSES' ? metrics.courses
              : 0;
      if (value < b.threshold) continue;
      try {
        await this.prisma.earnedBadge.create({ data: { workspaceId, leadId, badgeId: b.id } });
      } catch (e) {
        // Already earned — idempotent.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        this.logger.warn(`badge grant failed (lead=${leadId}, badge=${b.id}): ${(e as any)?.message ?? e}`);
      }
    }
  }

  /** A lead's gamification metrics: total points + distinct lessons/courses done. */
  private async metrics(workspaceId: string, leadId: string): Promise<{ points: number; lessons: number; courses: number }> {
    const [sum, lessons, courses] = await Promise.all([
      this.prisma.pointsLedger.aggregate({ where: { workspaceId, leadId }, _sum: { points: true } }),
      this.prisma.pointsLedger.count({ where: { workspaceId, leadId, source: 'LESSON_COMPLETE' } }),
      this.prisma.pointsLedger.count({ where: { workspaceId, leadId, source: 'COURSE_COMPLETE' } }),
    ]);
    return { points: sum._sum.points ?? 0, lessons, courses };
  }

  /** Member-facing profile: points total + earned badges (with their definitions). */
  async profile(workspaceId: string, leadId: string) {
    const [m, earned] = await Promise.all([
      this.metrics(workspaceId, leadId),
      this.prisma.earnedBadge.findMany({ where: { workspaceId, leadId }, orderBy: { earnedAt: 'desc' } }),
    ]);
    const badgeIds = earned.map((e) => e.badgeId);
    const defs = badgeIds.length
      ? await this.prisma.badge.findMany({ where: { workspaceId, id: { in: badgeIds } } })
      : [];
    const defById = new Map(defs.map((d) => [d.id, d]));
    return {
      leadId,
      points: m.points,
      lessons: m.lessons,
      courses: m.courses,
      badges: earned.map((e) => ({ ...defById.get(e.badgeId), earnedAt: e.earnedAt })).filter((b) => b.id),
    };
  }

  /**
   * Workspace leaderboard: leads ranked by total points (paginated). A second
   * lookup attaches lead display names without an unscoped join.
   */
  async leaderboard(workspaceId: string, page = 1, pageSize = 20) {
    const take = Math.min(Math.max(pageSize, 1), 100);
    const skip = Math.max(page - 1, 0) * take;
    // A soft-deleted (deletedAt) or merged-away (mergedIntoId) lead keeps its
    // points_ledger rows, so a plain groupBy would rank a HIDDEN member on the
    // public board (and consume a rank + page slot a real member should get).
    // points_ledger carries a SOFT leadId (no Lead relation), so Prisma groupBy
    // can't filter by lead.deletedAt — JOIN leads and exclude BEFORE limit/offset
    // (post-filtering the page would leave gaps + wrong ranks). leadId is the
    // deterministic tiebreaker (tied totals can't duplicate/drop across pages).
    const grouped = await this.prisma.$queryRawUnsafe<Array<{ leadId: string; points: number | bigint }>>(
      `SELECT pl."leadId" AS "leadId", SUM(pl."points")::int AS points
         FROM points_ledger pl
         JOIN leads l ON l.id = pl."leadId"
        WHERE pl."workspaceId" = $1 AND l."deletedAt" IS NULL AND l."mergedIntoId" IS NULL
        GROUP BY pl."leadId"
        ORDER BY SUM(pl."points") DESC, pl."leadId" ASC
        LIMIT $2 OFFSET $3`,
      workspaceId,
      take,
      skip,
    );
    const leadIds = grouped.map((g) => g.leadId);
    const leads = leadIds.length
      ? await this.prisma.lead.findMany({
          where: { id: { in: leadIds }, workspaceId },
          select: { id: true, contactPerson: true, businessName: true },
        })
      : [];
    const leadById = new Map(leads.map((l) => [l.id, l]));
    return grouped.map((g, i) => {
      const lead = leadById.get(g.leadId);
      return {
        rank: skip + i + 1,
        leadId: g.leadId,
        name: lead?.contactPerson || lead?.businessName || g.leadId,
        points: Number(g.points) || 0,
      };
    });
  }

  /**
   * Grant a single (new or rule-changed) badge to every member who already
   * qualifies — so creating or lowering a badge is retroactive (mirrors the
   * certificate backfill). Idempotent per lead+badge; bounded by member count.
   */
  async backfillBadge(workspaceId: string, badge: { id: string; ruleType: string; threshold: number }): Promise<void> {
    let qualifying: string[];
    if (badge.ruleType === 'POINTS') {
      const groups = await this.prisma.pointsLedger.groupBy({
        by: ['leadId'],
        where: { workspaceId },
        _sum: { points: true },
      });
      qualifying = groups.filter((g) => (g._sum.points ?? 0) >= badge.threshold).map((g) => g.leadId);
    } else {
      const source = badge.ruleType === 'LESSONS' ? 'LESSON_COMPLETE' : 'COURSE_COMPLETE';
      const groups = await this.prisma.pointsLedger.groupBy({
        by: ['leadId'],
        where: { workspaceId, source },
        _count: { _all: true },
      });
      qualifying = groups.filter((g) => (g._count._all ?? 0) >= badge.threshold).map((g) => g.leadId);
    }
    for (const leadId of qualifying) {
      try {
        await this.prisma.earnedBadge.create({ data: { workspaceId, leadId, badgeId: badge.id } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        this.logger.warn(`badge backfill grant failed (lead=${leadId}, badge=${badge.id}): ${(e as any)?.message ?? e}`);
      }
    }
  }

  // ── Badge admin (manager) ───────────────────────────────────────────────────

  listBadges(workspaceId: string) {
    return this.prisma.badge.findMany({ where: { workspaceId }, orderBy: [{ ruleType: 'asc' }, { threshold: 'asc' }] });
  }

  async createBadge(workspaceId: string, dto: { key: string; name: string; ruleType: string; threshold: number; iconUrl?: string }) {
    let badge;
    try {
      badge = await this.prisma.badge.create({
        data: {
          workspaceId,
          key: dto.key,
          name: dto.name,
          ruleType: dto.ruleType,
          threshold: dto.threshold,
          iconUrl: dto.iconUrl ?? null,
        },
      });
    } catch (e) {
      // Badge.key is unique per (workspaceId, key). There's no pre-check, so even
      // a SEQUENTIAL duplicate key would 500 without this — map it to a clean 409.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException(`Badge key "${dto.key}" already exists`);
      }
      throw e;
    }
    // Retroactively grant to members who already qualify.
    await this.backfillBadge(workspaceId, badge);
    return badge;
  }

  async updateBadge(workspaceId: string, id: string, dto: { name?: string; ruleType?: string; threshold?: number; iconUrl?: string | null }) {
    // updateMany with the workspace guard so a cross-tenant id can't be touched.
    await this.prisma.badge.updateMany({
      where: { id, workspaceId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.ruleType !== undefined && { ruleType: dto.ruleType }),
        ...(dto.threshold !== undefined && { threshold: dto.threshold }),
        ...(dto.iconUrl !== undefined && { iconUrl: dto.iconUrl }),
      },
    });
    const updated = await this.prisma.badge.findFirst({ where: { id, workspaceId } });
    // A rule/threshold change can make new members qualify — re-grant retroactively.
    if (updated && (dto.threshold !== undefined || dto.ruleType !== undefined)) {
      await this.backfillBadge(workspaceId, updated);
    }
    return updated;
  }

  async deleteBadge(workspaceId: string, id: string) {
    await this.prisma.badge.deleteMany({ where: { id, workspaceId } });
    await this.prisma.earnedBadge.deleteMany({ where: { badgeId: id, workspaceId } });
    return { id };
  }
}
