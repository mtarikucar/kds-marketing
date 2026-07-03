import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export type CalendarItemType = 'SOCIAL_POST' | 'CAMPAIGN_ITEM' | 'WEEKLY_PLAN';

export interface CalendarItem {
  type: CalendarItemType;
  id: string;
  title: string;
  scheduledAt: Date;
  status: string;
}

/**
 * The unified content calendar (Faz 4) — one time-ordered view across the
 * previously siloed schedules (social posts + AI social-campaign items). A read
 * model: it aggregates and normalizes; it never mutates. Email/SMS/ad schedules
 * plug in behind the same CalendarItem shape as follow-ups.
 */
@Injectable()
export class UnifiedCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async range(workspaceId: string, from: Date, to: Date): Promise<CalendarItem[]> {
    const [posts, items, planItems] = await Promise.all([
      this.prisma.socialPost.findMany({
        where: { workspaceId, scheduledAt: { gte: from, lte: to } },
        select: { id: true, content: true, status: true, scheduledAt: true },
      }),
      this.prisma.socialCampaignItem.findMany({
        where: { workspaceId, scheduledFor: { gte: from, lte: to } },
        select: { id: true, topic: true, status: true, scheduledFor: true },
      }),
      // Weekly-plan drafts (Faz C) show on the calendar too, except discarded ones.
      this.prisma.weeklyPlanItem.findMany({
        where: { workspaceId, day: { gte: from, lte: to }, status: { not: 'DISCARDED' } },
        select: { id: true, title: true, status: true, day: true },
      }),
    ]);

    const out: CalendarItem[] = [];
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      out.push({ type: 'SOCIAL_POST', id: p.id, title: title(p.content), scheduledAt: p.scheduledAt, status: p.status });
    }
    for (const it of items) {
      out.push({ type: 'CAMPAIGN_ITEM', id: it.id, title: it.topic ?? 'Planned content', scheduledAt: it.scheduledFor, status: String(it.status) });
    }
    for (const pi of planItems) {
      out.push({ type: 'WEEKLY_PLAN', id: pi.id, title: pi.title, scheduledAt: pi.day, status: pi.status });
    }
    return out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }
}

function title(content: string): string {
  const t = (content ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 80)}…` : t || 'Untitled post';
}
