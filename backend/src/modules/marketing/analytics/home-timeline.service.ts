import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';

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
}

/**
 * The home screen's calendar: four sources on one time axis.
 *
 * Each source is read independently and a failure NAMES itself rather than
 * shrinking the list. A short calendar and a broken query look identical to a
 * reader, and this codebase has already paid for that once — the daily brief
 * swallowed eight queries into `catch(() => 0)` and reported "nothing to
 * report" for what was actually "the query threw" (fixed in v2.271.0).
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
        .catch(soft('sistem işleri', [] as Array<{ name: string; nextAt: Date | null }>)),
      this.prisma.marketingTask
        .findMany({
          where: {
            workspaceId,
            dueDate: { gte: from, lte: to },
            status: { in: ['PENDING', 'IN_PROGRESS'] },
          },
          select: { id: true, title: true, dueDate: true, status: true },
        })
        .catch(soft('görevler', [])),
      this.prisma.booking
        .findMany({
          where: { workspaceId, startAt: { gte: from, lte: to }, status: 'CONFIRMED' },
          select: { id: true, name: true, startAt: true },
        })
        .catch(soft('randevular', [])),
      this.prisma.socialCampaign
        .findMany({
          where: { workspaceId, startDate: { gte: from, lte: to } },
          select: { id: true, name: true, startDate: true, status: true },
        })
        .catch(soft('sosyal kampanyalar', [])),
      this.prisma.campaign
        .findMany({
          where: { workspaceId, scheduledAt: { gte: from, lte: to } },
          select: { id: true, name: true, scheduledAt: true, status: true },
        })
        .catch(soft('kampanyalar', [])),
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

    return { from: from.toISOString(), to: to.toISOString(), items, unread };
  }
}
