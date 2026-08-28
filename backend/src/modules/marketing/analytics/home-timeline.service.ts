import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

/**
 * Per-source row cap. The window comes from the caller, so an unbounded
 * `findMany` here is one wide `from`/`to` away from loading a workspace's
 * whole history into memory. 200 rows a source is far past what a day of
 * calendar can render, and the `orderBy` on each query makes the cut fall on
 * the LAST entries of the window rather than on an arbitrary 200.
 */
export const CAP = 200;

/**
 * The user-facing name of each source, in one place. `unread` and `truncated`
 * both report by name, and the same source drifting into two different names
 * across the two lists would be its own small lie.
 */
const SOURCE = {
  system: 'sistem işleri',
  tasks: 'görevler',
  bookings: 'randevular',
  socials: 'sosyal kampanyalar',
  campaigns: 'kampanyalar',
} as const;

export type TimelineKind = 'system' | 'task' | 'appointment' | 'campaign';

export interface TimelineItem {
  kind: TimelineKind;
  at: string;
  title: string;
  id: string;
  status?: string;
}

export interface HomeTimeline {
  from: string;
  to: string;
  items: TimelineItem[];
  /** Sources that could not be read, by name. Empty when all four answered. */
  unread: string[];
  /**
   * Sources that hit the row cap, by name. Their rows are the EARLIEST in the
   * window, not an arbitrary slice — see CAP.
   *
   * Deliberately NOT merged into `unread`: "could not read this source" and
   * "read it, there was more" are different failures needing different fixes,
   * and a reader who cannot tell them apart is back where the daily brief was.
   */
  truncated: string[];
}

/**
 * The home screen's calendar: four sources on one time axis.
 *
 * Each source is read independently and a failure NAMES itself rather than
 * shrinking the list. A short calendar and a broken query look identical to a
 * reader, and this codebase has already paid for that once — the daily brief
 * swallowed eight queries into `catch(() => 0)` and reported "nothing to
 * report" for what was actually "the query threw" (fixed in v2.271.0).
 *
 * Cancelled work is left out of all four sources: the calendar answers "what is
 * coming", and a cancelled campaign is by definition not coming. DRAFT stays —
 * a draft whose date has arrived is exactly the anomaly its owner needs to see.
 */
@Injectable()
export class HomeTimelineService {
  private readonly logger = new Logger(HomeTimelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ScheduledJobService,
  ) {}

  async timeline(workspaceId: string, from: Date, to: Date): Promise<HomeTimeline> {
    const unread: string[] = [];
    const soft =
      <T>(label: string, fallback: T) =>
      (e: unknown): T => {
        unread.push(label);
        this.logger.warn(
          `timeline source "${label}" failed for ${workspaceId}: ${e instanceof Error ? e.message : e}`,
        );
        return fallback;
      };

    const [system, tasks, bookings, socials, campaigns] = await Promise.all([
      this.jobs
        .listCronHeartbeats()
        .then((r) => r.registered)
        .catch(soft(SOURCE.system, [] as Array<{ name: string; nextAt: Date | null }>)),
      this.prisma.marketingTask
        .findMany({
          where: {
            workspaceId,
            dueDate: { gte: from, lte: to },
            status: { in: ['PENDING', 'IN_PROGRESS'] },
          },
          select: { id: true, title: true, dueDate: true, status: true },
          orderBy: { dueDate: 'asc' },
          take: CAP,
        })
        .catch(soft(SOURCE.tasks, [])),
      this.prisma.booking
        .findMany({
          where: { workspaceId, startAt: { gte: from, lte: to }, status: 'CONFIRMED' },
          select: { id: true, name: true, startAt: true },
          orderBy: { startAt: 'asc' },
          take: CAP,
        })
        .catch(soft(SOURCE.bookings, [])),
      this.prisma.socialCampaign
        .findMany({
          where: {
            workspaceId,
            startDate: { gte: from, lte: to },
            status: { not: 'CANCELLED' },
          },
          select: { id: true, name: true, startDate: true, status: true },
          orderBy: { startDate: 'asc' },
          take: CAP,
        })
        .catch(soft(SOURCE.socials, [])),
      this.prisma.campaign
        .findMany({
          where: {
            workspaceId,
            scheduledAt: { gte: from, lte: to },
            status: { not: 'CANCELLED' },
          },
          select: { id: true, name: true, scheduledAt: true, status: true },
          orderBy: { scheduledAt: 'asc' },
          take: CAP,
        })
        .catch(soft(SOURCE.campaigns, [])),
    ]);

    const items: TimelineItem[] = [
      ...system
        .filter((c) => c.nextAt && c.nextAt >= from && c.nextAt <= to)
        .map((c) => ({
          kind: 'system' as const,
          id: c.name,
          title: c.name,
          at: c.nextAt!.toISOString(),
        })),
      ...tasks.map((t) => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        at: t.dueDate.toISOString(),
        status: t.status,
      })),
      ...bookings.map((b) => ({
        kind: 'appointment' as const,
        id: b.id,
        title: b.name,
        at: b.startAt.toISOString(),
      })),
      ...socials.map((s) => ({
        kind: 'campaign' as const,
        id: s.id,
        title: s.name,
        at: s.startDate.toISOString(),
        status: String(s.status),
      })),
      ...campaigns.map((c) => ({
        kind: 'campaign' as const,
        id: c.id,
        title: c.name,
        at: c.scheduledAt!.toISOString(),
        status: c.status,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    // A source that FAILED fell back to [], which is under the cap, so it can
    // never appear in both lists — it is unread, not truncated.
    const truncated = (
      [
        [SOURCE.tasks, tasks.length],
        [SOURCE.bookings, bookings.length],
        [SOURCE.socials, socials.length],
        [SOURCE.campaigns, campaigns.length],
      ] as const
    )
      .filter(([, n]) => n >= CAP)
      .map(([label]) => label as string)
      .sort();

    // Both lists are sorted, not push-ordered: `soft` appends from inside
    // `.catch`, so its order follows which query rejected first. Two failures
    // would otherwise swap places between refreshes and read as a bug in the
    // list itself.
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      items,
      unread: unread.sort(),
      truncated,
    };
  }
}
