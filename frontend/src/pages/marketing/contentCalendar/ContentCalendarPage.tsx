import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarRange, Share2, CalendarDays } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { listContentCalendar, type CalendarItem } from '../../../features/marketing/api/contentCalendar.service';

const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const TYPE_META: Record<CalendarItem['type'], { icon: typeof Share2; toneKey: string }> = {
  SOCIAL_POST: { icon: Share2, toneKey: 'info' },
  CAMPAIGN_ITEM: { icon: CalendarRange, toneKey: 'primary' },
};

const STATUS_FALLBACK: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  QUEUED: 'Queued',
  FAILED: 'Failed',
};

/**
 * Unified content calendar (Faz 4) — one agenda across social posts + AI
 * social-campaign items, grouped by day. A read model; scheduling still happens
 * in each source tool.
 */
export default function ContentCalendarPage() {
  const { t } = useTranslation('marketing');
  const q = useQuery({ queryKey: ['content-calendar'], queryFn: () => listContentCalendar() });

  const byDay = useMemo(() => {
    const groups = new Map<string, CalendarItem[]>();
    for (const item of q.data ?? []) {
      const k = dayKey(item.scheduledAt);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(item);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [q.data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('contentCal.title', 'Content Calendar')}
        description={t('contentCal.subtitle', 'Everything scheduled — social posts and AI campaign content — in one timeline.')}
      />

      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {!q.data?.length ? (
          <EmptyState
            icon={<CalendarDays className="h-6 w-6" />}
            title={t('contentCal.empty.title', 'Nothing scheduled')}
            description={t('contentCal.empty.desc', 'Scheduled social posts and AI campaign items will appear here as a single agenda.')}
          />
        ) : (
          <div className="space-y-6">
            {byDay.map(([day, items]) => (
              <div key={day}>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">{dayLabel(day)}</h2>
                <div className="space-y-2">
                  {items.map((item) => {
                    const meta = TYPE_META[item.type];
                    const Icon = meta.icon;
                    return (
                      <Card key={`${item.type}-${item.id}`}>
                        <CardContent className="flex items-center gap-3 py-3">
                          <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{time(item.scheduledAt)}</span>
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                          <Badge tone={meta.toneKey as 'info' | 'primary'}>
                            {t(`contentCal.type.${item.type}`, item.type === 'SOCIAL_POST' ? 'Post' : 'Campaign')}
                          </Badge>
                          <Badge tone="neutral">
                            {t(`contentCal.status.${item.status}`, STATUS_FALLBACK[item.status] ?? item.status)}
                          </Badge>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </QueryStateBoundary>
    </div>
  );
}
