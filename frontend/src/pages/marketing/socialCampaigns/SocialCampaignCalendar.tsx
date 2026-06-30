import { useTranslation } from 'react-i18next';
import { CalendarRange } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  type SocialCampaignItem,
  type SocialCampaignItemStatus,
} from '../../../features/marketing/api/socialCampaigns.service';

const ITEM_TONE: Record<SocialCampaignItemStatus, BadgeProps['tone']> = {
  PLANNED: 'neutral',
  GENERATING: 'info',
  NEEDS_APPROVAL: 'warning',
  APPROVED: 'info',
  SCHEDULED: 'info',
  PUBLISHED: 'success',
  FAILED: 'danger',
  SKIPPED: 'neutral',
};

export interface SocialCampaignCalendarProps {
  items: SocialCampaignItem[];
}

export function SocialCampaignCalendar({ items }: SocialCampaignCalendarProps) {
  const { t } = useTranslation('marketing');

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<CalendarRange className="h-6 w-6" />}
        title={t('socialCampaign.calendarEmpty', 'No content scheduled yet')}
      />
    );
  }

  const byDay = new Map<string, SocialCampaignItem[]>();
  for (const it of [...items].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))) {
    const day = it.scheduledFor.slice(0, 10); // YYYY-MM-DD
    const bucket = byDay.get(day) ?? [];
    bucket.push(it);
    byDay.set(day, bucket);
  }

  return (
    <div className="space-y-4">
      {[...byDay.entries()].map(([day, dayItems]) => (
        <div key={day} className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">{day}</h3>
          {dayItems.map((it) => (
            <Card key={it.id}>
              <CardContent className="flex items-center justify-between p-3">
                <span className="truncate text-sm">
                  {it.topic ?? t('socialCampaign.untitled', 'Untitled post')}
                </span>
                <Badge tone={ITEM_TONE[it.status]}>{it.status}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}
