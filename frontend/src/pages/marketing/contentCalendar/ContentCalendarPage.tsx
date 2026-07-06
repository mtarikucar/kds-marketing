import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Share2, CalendarRange, Sparkles, CalendarDays } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { listContentCalendar, type CalendarItem, type CalendarItemType } from '../../../features/marketing/api/contentCalendar.service';

const dayKey = (d: Date | string) => {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const TYPE_STYLE: Record<CalendarItemType, { dot: string; tone: 'info' | 'primary' | 'warning'; icon: typeof Share2 }> = {
  SOCIAL_POST: { dot: 'bg-info', tone: 'info', icon: Share2 },
  CAMPAIGN_ITEM: { dot: 'bg-primary', tone: 'primary', icon: CalendarRange },
};
const typeStyle = (t: CalendarItemType) => TYPE_STYLE[t] ?? { dot: 'bg-muted-foreground', tone: 'info' as const, icon: CalendarDays };

interface Props {
  embedded?: boolean;
  /** Faz C wires the weekly-plan generator to this hero action. */
  onGenerateWeeklyPlan?: () => void;
}

/**
 * The unified content calendar — a full month grid merging EVERYTHING scheduled
 * (social posts + AI campaign items today; weekly-plan drafts in Faz C),
 * color-coded by type. The important first tab of the Growth Studio.
 */
export default function ContentCalendarPage({ embedded, onGenerateWeeklyPlan }: Props = {}) {
  const { t } = useTranslation('marketing');
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(null);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  // 42-cell grid (6 weeks) padded with adjacent-month days.
  const cells = useMemo(() => {
    const startPad = new Date(year, month, 1).getDay();
    const out: { date: Date; inMonth: boolean }[] = [];
    for (let i = startPad - 1; i >= 0; i--) out.push({ date: new Date(year, month, -i), inMonth: false });
    const last = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= last; d++) out.push({ date: new Date(year, month, d), inMonth: true });
    for (let d = 1; out.length < 42; d++) out.push({ date: new Date(year, month + 1, d), inMonth: false });
    return out;
  }, [year, month]);

  const from = dayKey(cells[0].date);
  const to = dayKey(cells[cells.length - 1].date);
  const q = useQuery({ queryKey: ['content-calendar', from, to], queryFn: () => listContentCalendar(from, to) });

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of q.data ?? []) {
      const k = dayKey(it.scheduledAt);
      const arr = m.get(k);
      if (arr) arr.push(it);
      else m.set(k, [it]);
    }
    return m;
  }, [q.data]);

  const monthName = cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const todayKey = dayKey(new Date());
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));
  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader title={t('contentCal.title', 'Content Calendar')} description={t('contentCal.subtitle', 'Everything scheduled — social posts and AI campaign content — in one calendar.')} />
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex items-center gap-1">
            <IconButton aria-label={t('contentCal.prev', 'Previous month')} variant="ghost" onClick={() => setCursor(new Date(year, month - 1, 1))}><ChevronLeft className="h-5 w-5" /></IconButton>
            <IconButton aria-label={t('contentCal.next', 'Next month')} variant="ghost" onClick={() => setCursor(new Date(year, month + 1, 1))}><ChevronRight className="h-5 w-5" /></IconButton>
            <h2 className="ml-1 text-base font-semibold capitalize">{monthName}</h2>
            <Button variant="outline" size="sm" className="ml-2" onClick={() => setCursor(new Date())}>{t('contentCal.today', 'Today')}</Button>
          </div>
          {onGenerateWeeklyPlan && (
            <Button onClick={onGenerateWeeklyPlan}>
              <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />{t('contentCal.weeklyPlan', 'Generate weekly plan')}
            </Button>
          )}
        </CardContent>
      </Card>

      {q.isLoading ? (
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 42 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="grid grid-cols-7 border-b border-border bg-muted/40 text-center text-xs font-medium text-muted-foreground">
            {weekdays.map((w) => <div key={w} className="py-2 capitalize">{w}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map(({ date, inMonth }, i) => {
              const k = dayKey(date);
              const items = byDay.get(k) ?? [];
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(k)}
                  className={`min-h-[92px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-muted/40 ${inMonth ? '' : 'bg-muted/20 text-muted-foreground'} ${selected === k ? 'ring-2 ring-inset ring-primary' : ''}`}
                >
                  <div className={`mb-1 text-xs ${k === todayKey ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground' : ''}`}>{date.getDate()}</div>
                  <div className="space-y-0.5">
                    {items.slice(0, 3).map((it) => {
                      const st = typeStyle(it.type);
                      return (
                        <div key={`${it.type}-${it.id}`} className="flex items-center gap-1 truncate text-[11px]">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} aria-hidden="true" />
                          <span className="truncate">{it.title}</span>
                        </div>
                      );
                    })}
                    {items.length > 3 && <div className="text-[11px] text-muted-foreground">+{items.length - 3}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <LegendDot className="bg-info" label={t('contentCal.type.SOCIAL_POST', 'Social post')} />
        <LegendDot className="bg-primary" label={t('contentCal.type.CAMPAIGN_ITEM', 'Campaign content')} />
      </div>

      {selected && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{new Date(`${selected}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>{t('common.close', 'Close')}</Button>
            </div>
            {selectedItems.length === 0 ? (
              <EmptyState icon={<CalendarDays className="h-5 w-5" />} title={t('contentCal.day.empty', 'Nothing scheduled this day')} />
            ) : (
              selectedItems.map((it) => {
                const st = typeStyle(it.type);
                const Icon = st.icon;
                return (
                  <div key={`${it.type}-${it.id}`} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                    <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{time(it.scheduledAt)}</span>
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm">{it.title}</span>
                    <Badge tone={st.tone}>{t(`contentCal.type.${it.type}`, it.type === 'SOCIAL_POST' ? 'Post' : 'Campaign')}</Badge>
                    <Badge tone="neutral">{it.status}</Badge>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}
