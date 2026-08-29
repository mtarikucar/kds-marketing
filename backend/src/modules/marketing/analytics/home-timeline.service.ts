import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

/**
 * Per-source row cap. The window comes from the caller, so an unbounded
 * `findMany` here is one wide `from`/`to` away from loading a workspace's
 * whole history into memory. 200 rows a source is far past what a day of
 * calendar can render, and the `orderBy` on each query makes the cut fall on
 * the EARLIEST entries of the window rather than on an arbitrary 200.
 *
 * Each query asks for `CAP + 1` and reports truncation at `> CAP`. Asking for
 * exactly CAP would leave "200 rows with more behind them" and "200 rows and
 * that was all" indistinguishable, and a `truncated` that cries wolf on a
 * source that was in fact complete is the same lie as a silent one.
 */
export const CAP = 200;

/**
 * The user-facing name of each source, in one place. `unread` and `truncated`
 * both report by name, and the same source drifting into two different names
 * across the two lists would be its own small lie.
 *
 * All but `system` are database reads and go through `cut` below, which trims
 * and reports in the same call. `system` is the registry's own in-memory list
 * (~40 entries, no query, no cap), so it is the one name that can appear in
 * `unread` but never in `truncated`.
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
  /** Sources that could not be read, by name. Empty when all five answered. */
  unread: string[];
  /**
   * Sources with more rows in the window than were returned, by name. What came
   * back is the EARLIEST `CAP` of them, not an arbitrary slice — see CAP.
   *
   * Deliberately NOT merged into `unread`: "could not read this source" and
   * "read it, there was more" are different failures needing different fixes,
   * and a reader who cannot tell them apart is back where the daily brief was.
   */
  truncated: string[];
}

/**
 * The home screen's calendar: five sources on one time axis, rendered as four
 * lanes (`system | task | appointment | campaign` — the two campaign sources
 * share a lane).
 *
 * Each source is read independently and a failure NAMES itself rather than
 * shrinking the list. A short calendar and a broken query look identical to a
 * reader, and this codebase has already paid for that once — the daily brief
 * swallowed eight queries into `catch(() => 0)` and reported "nothing to
 * report" for what was actually "the query threw" (fixed in v2.271.0).
 *
 * Cancelled work is left out of all four database sources: the calendar answers
 * "what is coming", and a cancelled campaign is by definition not coming. DRAFT
 * stays — a draft whose date has arrived is exactly the anomaly its owner needs
 * to see.
 *
 * Tenant scope, since the signature leads with `workspaceId` and one source
 * does not use it: the four database reads are all filtered by `workspaceId`.
 * The `system` lane is not, and cannot be — `SchedulerRegistry` is process-wide,
 * so the cron schedule is a property of the deployment rather than of any one
 * workspace, and every workspace sees the same job names. It carries no tenant
 * data: a job name and its next run time, nothing read per customer.
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
          take: CAP + 1,
        })
        .catch(soft(SOURCE.tasks, [])),
      this.prisma.booking
        .findMany({
          where: { workspaceId, startAt: { gte: from, lte: to }, status: 'CONFIRMED' },
          select: { id: true, name: true, startAt: true },
          orderBy: { startAt: 'asc' },
          take: CAP + 1,
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
          take: CAP + 1,
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
          take: CAP + 1,
        })
        .catch(soft(SOURCE.campaigns, [])),
    ]);

    const truncated: string[] = [];
    /**
     * Trim a source to the cap and report it in the same breath. Deliberately
     * called at the point each source is mapped rather than from a table built
     * beside it: a table is a fourth place to remember when a source is added,
     * and forgetting it would mean that source can never report truncation —
     * no type error, no failing test, exactly the silence this file exists to
     * prevent. Here a new source cannot be mapped without passing through it.
     *
     * A source that FAILED fell back to [], so it can never land in both lists:
     * it is unread, not truncated.
     */
    const cut = <T>(label: string, rows: T[]): T[] => {
      if (rows.length > CAP) truncated.push(label);
      return rows.slice(0, CAP);
    };

    const items: TimelineItem[] = [
      ...system
        .filter((c) => c.nextAt && c.nextAt >= from && c.nextAt <= to)
        .map((c) => ({
          kind: 'system' as const,
          id: c.name,
          title: c.name,
          at: c.nextAt!.toISOString(),
        })),
      ...cut(SOURCE.tasks, tasks).map((t) => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        at: t.dueDate.toISOString(),
        status: t.status,
      })),
      ...cut(SOURCE.bookings, bookings).map((b) => ({
        kind: 'appointment' as const,
        id: b.id,
        title: b.name,
        at: b.startAt.toISOString(),
      })),
      ...cut(SOURCE.socials, socials).map((s) => ({
        kind: 'campaign' as const,
        id: s.id,
        title: s.name,
        at: s.startDate.toISOString(),
        status: String(s.status),
      })),
      ...cut(SOURCE.campaigns, campaigns).map((c) => ({
        kind: 'campaign' as const,
        id: c.id,
        title: c.name,
        at: c.scheduledAt!.toISOString(),
        status: c.status,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    // `unread` is sorted because `soft` appends from inside `.catch`, so its
    // push order follows whichever query rejected first — two failures would
    // swap places between refreshes and read as a bug in the list itself.
    // `truncated` is already deterministic (built in a fixed order above); it
    // is sorted only so the two lists read alike.
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      items,
      unread: unread.sort(),
      truncated: truncated.sort(),
    };
  }
}
