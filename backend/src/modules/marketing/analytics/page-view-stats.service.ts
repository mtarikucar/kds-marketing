import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/** A route pattern is short. Anything longer is not one. */
const MAX_ROUTE_LEN = 120;

/**
 * Segments that look like data rather than structure. A caller is supposed to
 * send the router PATTERN, but the client is not the security boundary: a bug
 * (or a curious caller) sending `/leads/9f2c…` would both leak a record id into
 * analytics and explode the row count, so anything id-shaped is collapsed here.
 */
const IDISH = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{21,})$/i;

/**
 * Aggregated page-open counters.
 *
 * See the PageViewStat model comment for why this exists and why it is
 * deliberately anonymous. The service's only jobs are to make the route safe
 * to store and to keep the write cheap enough that it can sit on every
 * navigation without anyone noticing.
 */
@Injectable()
export class PageViewStatsService {
  private readonly logger = new Logger(PageViewStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `YYYY-MM` in UTC — the bucket a view is counted into. */
  static periodOf(at: Date = new Date()): string {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Strip a path down to something safe and bounded: no query string, no
   * fragment, no id-shaped segments, one leading slash, length-capped.
   * Returns null when nothing usable survives.
   */
  static normalise(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const path = raw.split('?')[0].split('#')[0].trim();
    if (!path.startsWith('/')) return null;

    const segments = path
      .split('/')
      .filter(Boolean)
      .map((s) => (IDISH.test(s) ? ':id' : s.toLowerCase()));

    const route = '/' + segments.join('/');
    if (route.length > MAX_ROUTE_LEN) return null;
    return route;
  }

  /**
   * Count one view. Best-effort by design: analytics must never be able to
   * fail a navigation, so the caller gets a resolved promise either way and
   * the loss of a counter tick is not worth an error surface.
   */
  async record(workspaceId: string, rawRoute: unknown, at: Date = new Date()): Promise<void> {
    const route = PageViewStatsService.normalise(rawRoute);
    if (!route) return;
    const period = PageViewStatsService.periodOf(at);

    try {
      await this.prisma.pageViewStat.upsert({
        where: { workspaceId_route_period: { workspaceId, route, period } },
        create: { workspaceId, route, period, count: 1 },
        update: { count: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(`page-view counter failed for ${route}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * What this workspace opened, busiest first. `sinceMonths` counts back from
   * the current month inclusive, so 3 means "this month and the two before".
   */
  async summary(workspaceId: string, sinceMonths = 3) {
    const periods = PageViewStatsService.recentPeriods(sinceMonths);
    const rows = await this.prisma.pageViewStat.groupBy({
      by: ['route'],
      where: { workspaceId, period: { in: periods } },
      _sum: { count: true },
    });
    return {
      periods,
      routes: rows
        .map((r) => ({ route: r.route, count: r._sum.count ?? 0 }))
        .sort((a, b) => b.count - a.count),
    };
  }

  static recentPeriods(months: number, from: Date = new Date()): string[] {
    const n = Math.min(Math.max(Math.trunc(months), 1), 24);
    const out: string[] = [];
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    for (let i = 0; i < n; i++) {
      out.push(PageViewStatsService.periodOf(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    return out;
  }
}
