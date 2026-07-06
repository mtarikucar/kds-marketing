import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export type CalendarItemType = 'SOCIAL_POST' | 'CAMPAIGN_ITEM';

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
 *
 * Dedupe (2026-07 trim): a confirmed campaign item materializes a scheduled
 * SocialPost carrying `campaignItemId` back to its source item — from then on
 * both rows describe the SAME slot, so the calendar suppresses the item and
 * shows only the post (the real, publishable thing). The WEEKLY_PLAN arm died
 * with the WeeklyPlan feature.
 */
@Injectable()
export class UnifiedCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async range(workspaceId: string, from: Date, to: Date): Promise<CalendarItem[]> {
    const [posts, items] = await Promise.all([
      this.prisma.socialPost.findMany({
        where: { workspaceId, scheduledAt: { gte: from, lte: to } },
        select: { id: true, content: true, status: true, scheduledAt: true, campaignItemId: true },
      }),
      this.prisma.socialCampaignItem.findMany({
        where: { workspaceId, scheduledFor: { gte: from, lte: to } },
        select: { id: true, topic: true, status: true, scheduledFor: true },
      }),
    ]);

    // Campaign items whose post is already scheduled — the post row wins.
    const materializedItemIds = new Set(
      posts.filter((p) => p.scheduledAt && p.campaignItemId).map((p) => p.campaignItemId as string),
    );

    const out: CalendarItem[] = [];
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      out.push({ type: 'SOCIAL_POST', id: p.id, title: title(p.content), scheduledAt: p.scheduledAt, status: p.status });
    }
    for (const it of items) {
      if (materializedItemIds.has(it.id)) continue;
      out.push({ type: 'CAMPAIGN_ITEM', id: it.id, title: it.topic ?? 'Planned content', scheduledAt: it.scheduledFor, status: String(it.status) });
    }
    return out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }
}

function title(content: string): string {
  const t = (content ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 80)}…` : t || 'Untitled post';
}
