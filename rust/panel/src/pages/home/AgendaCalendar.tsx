import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertCircle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CircleDot, Clock, Hourglass, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { listCalls } from '@/api/calls';
import { ApiError } from '@/api/client';
import { listTasks } from '@/api/inbox';
import { listCampaigns } from '@/api/outreach';
import { weeklySummary } from '@/api/posts';
import { Button, cn, IconButton, SegmentedControl } from '@/components/ui';
import {
  callItems, campaignItems, dayKey, inRange, mondays, moduleTone, shiftAnchor, sortAgenda, studioItems, taskItems, viewRange,
  type AgendaItem, type AgendaStatus, type AgendaView, type Words,
} from './agenda';
import type { HomeCopy, HomeCopyKey } from './copy';

interface Props {
  copy: HomeCopy;
  active: boolean;
  /** Installed modules the viewer may see, by blueprint id. */
  modules: ReadonlySet<string>;
  moduleName: (id: string) => string;
  words: Words;
  className?: string;
}

const STATUS_ICON: Record<AgendaStatus, typeof Clock> = {
  done: CheckCircle2, active: CircleDot, waiting: Hourglass, planned: Clock, overdue: AlertCircle, cancelled: XCircle,
};
const STATUS_WORD: Record<AgendaStatus, HomeCopyKey> = {
  done: 'done', active: 'active', waiting: 'waiting', planned: 'planned', overdue: 'overdue2', cancelled: 'cancelled',
};
const STATUS_STYLE: Record<AgendaStatus, string> = {
  done: 'opacity-60', active: '', waiting: 'bg-amber-50 dark:bg-amber-500/10', planned: '',
  overdue: 'bg-red-50 dark:bg-red-500/10', cancelled: 'opacity-50 line-through',
};
const ICON_TONE: Record<AgendaStatus, string> = {
  done: 'text-emerald-600', active: 'text-primary', waiting: 'text-amber-600', planned: 'text-muted-foreground',
  overdue: 'text-red-600', cancelled: 'text-muted-foreground',
};

function initialView(): AgendaView {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches ? 'day' : 'week';
}

/** What the modules planned, are doing and did, by day: which module, who, when, what. */
export function AgendaCalendar({ copy, active, modules, moduleName, words, className }: Props) {
  const language = copy.isTurkish ? 'tr-TR' : 'en-GB';
  const [view, setView] = useState<AgendaView>(initialView);
  const [anchor, setAnchor] = useState(() => new Date());
  const { from, until, days } = viewRange(view, anchor);
  const now = new Date();

  const studioOn = active && modules.has('social');
  const studio = useQueries({ queries: (studioOn ? mondays(from, until) : []).map(week => ({
    queryKey: ['home', 'studio-summary', week], queryFn: () => weeklySummary(week), retry: false,
  })) });
  const tasks = useQuery({ queryKey: ['home', 'inbox-tasks'], queryFn: () => listTasks('all'), enabled: active && modules.has('inbox'), retry: false });
  const calls = useQuery({ queryKey: ['home', 'calls'], queryFn: () => listCalls({ limit: 200 }), enabled: active && modules.has('calls'), retry: false });
  const campaigns = useQuery({ queryKey: ['home', 'campaigns'], queryFn: () => listCampaigns({ limit: 100 }), enabled: active && modules.has('outreach'), retry: false });

  // A module that has nothing to show yet (no approved strategy) is quiet, not broken.
  const broken = (error: unknown) => !!error && !(error instanceof ApiError && error.code === 'STRATEGY_REQUIRED');
  const failed = [
    studio.some(q => broken(q.error)) && 'social', broken(tasks.error) && 'inbox', broken(calls.error) && 'calls', broken(campaigns.error) && 'outreach',
  ].filter((m): m is string => !!m);

  const items = sortAgenda([
    ...studio.flatMap(q => q.data ? studioItems(q.data, words, now) : []),
    ...(tasks.data ? taskItems(tasks.data, words, now) : []),
    ...(calls.data ? callItems(calls.data, words) : []),
    ...(campaigns.data ? campaignItems(campaigns.data.items, words) : []),
  ].filter(item => inRange(item.at, from, until)));

  const byDay = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const key = dayKey(new Date(item.at));
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }
  const todayKey = dayKey(now);
  const time = (iso: string) => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const weekday = (d: Date) => new Intl.DateTimeFormat(language, { weekday: 'short' }).format(d);
  const rangeLabel = view === 'day'
    ? new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long' }).format(from)
    : view === 'week'
      ? `${new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short' }).format(from)} – ${new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(until.getTime() - 1))}`
      : new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(anchor);
  const legend = [...new Set(items.map(item => item.module))];

  const entry = (item: AgendaItem, compact = false) => {
    const Icon = STATUS_ICON[item.status];
    return <Link to={item.href} title={`${time(item.at)} · ${item.title} · ${item.who} · ${copy(STATUS_WORD[item.status])}`}
      className={cn('block min-w-0 rounded-md border border-border/70 border-s-[3px] bg-surface px-1.5 py-1 text-[11px] leading-tight transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        moduleTone(item.module).edge, STATUS_STYLE[item.status])}>
      <span className="flex items-center gap-1 font-medium tabular-nums"><Icon className={cn('h-3 w-3 shrink-0', ICON_TONE[item.status])} aria-label={copy(STATUS_WORD[item.status])} />{time(item.at)}</span>
      <span className={cn('block font-medium text-foreground', compact ? 'truncate' : 'line-clamp-2')}>{item.title}</span>
      {!compact && <span className="block truncate text-muted-foreground">{item.who}</span>}
    </Link>;
  };

  return <section aria-labelledby="home-calendar" className={cn('flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4', className)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2 id="home-calendar" className="flex items-center gap-2 text-sm font-medium"><CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{copy('calendar')}</h2>
        <span className="truncate text-xs text-muted-foreground" aria-live="polite">{rangeLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <IconButton size="sm" variant="ghost" aria-label={copy('previous')} onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}><ChevronLeft className="h-4 w-4" /></IconButton>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(new Date())}>{copy('today')}</Button>
        <IconButton size="sm" variant="ghost" aria-label={copy('next')} onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}><ChevronRight className="h-4 w-4" /></IconButton>
        <SegmentedControl aria-label={copy('calendar')} value={view} onChange={setView}
          options={[{ value: 'day', label: copy('day') }, { value: 'week', label: copy('week') }, { value: 'month', label: copy('month') }]} />
      </div>
    </div>

    {view === 'day' && <ol className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
      {(byDay.get(dayKey(from)) ?? []).map(item => <li key={item.id}>{entry(item)}</li>)}
    </ol>}

    {view === 'week' && <div className="grid min-h-0 flex-1 grid-cols-7 gap-1.5 overflow-x-auto">
      {days.map(d => {
        const key = dayKey(d);
        return <div key={key} className={cn('flex min-h-0 min-w-[5.5rem] flex-col gap-1 rounded-lg border p-1.5',
          key === todayKey ? 'border-primary-200 bg-primary-50/60 dark:border-primary-800 dark:bg-primary-950/40' : 'border-border/60 bg-surface-muted/30')}>
          <button type="button" onClick={() => { setAnchor(d); setView('day'); }}
            className={cn('text-start text-[11px] font-semibold hover:underline', key === todayKey ? 'text-primary' : 'text-muted-foreground')}>
            {weekday(d)} {d.getDate()}{key === todayKey && ` · ${copy('today')}`}
          </button>
          <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {(byDay.get(key) ?? []).map(item => <li key={item.id}>{entry(item)}</li>)}
          </ol>
        </div>;
      })}
    </div>}

    {view === 'month' && <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 gap-1">
      {days.slice(0, 7).map(d => <div key={`h-${dayKey(d)}`} className="px-1 text-[11px] font-semibold text-muted-foreground">{weekday(d)}</div>)}
      {days.map(d => {
        const key = dayKey(d);
        const list = byDay.get(key) ?? [];
        const outside = d.getMonth() !== anchor.getMonth();
        return <div key={key} className={cn('flex min-h-[4.5rem] min-w-0 flex-col gap-0.5 rounded-md border p-1',
          key === todayKey ? 'border-primary-200 bg-primary-50/60 dark:border-primary-800 dark:bg-primary-950/40' : 'border-border/60', outside && 'opacity-50')}>
          <button type="button" onClick={() => { setAnchor(d); setView('day'); }} className="text-start text-[11px] font-semibold text-muted-foreground hover:underline">{d.getDate()}</button>
          {list.slice(0, 2).map(item => <div key={item.id}>{entry(item, true)}</div>)}
          {list.length > 2 && <button type="button" onClick={() => { setAnchor(d); setView('day'); }} className="text-start text-[10px] text-muted-foreground hover:underline">{copy('more', { n: list.length - 2 })}</button>}
        </div>;
      })}
    </div>}

    {items.length === 0 && <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{copy('emptyRange')}</span> {copy('emptyRangeBody')}</p>}
    {failed.length > 0 && <p className="text-xs text-muted-foreground">{copy('unavailable', { names: failed.map(moduleName).join(', ') })}</p>}
    {legend.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {legend.map(module => <span key={module} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', moduleTone(module).dot)} aria-hidden="true" />{moduleName(module)}</span>)}
    </div>}
  </section>;
}
