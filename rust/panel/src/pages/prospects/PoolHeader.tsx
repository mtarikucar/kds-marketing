import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { poolReport } from '@/api/prospects';
import { cn } from '@/components/ui';
import { useLeadsKey } from '../LeadsShared';
import { useTaskCopy } from '../research/copy';
import { usePoolCopy, type PoolCopyKey } from './copy';

/** A filter tab of the pool's module: the pool's status tabs and the tasks' chips look alike. */
export function tabClass(pressed: boolean): string {
  return cn(
    'shrink-0 rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    pressed ? 'bg-primary-50 font-semibold text-foreground dark:bg-primary-950/60' : 'text-muted-foreground hover:text-foreground',
  );
}

/** This month's funnel in one line, from the pool's report; nothing while it cannot be read. */
function Funnel() {
  const copy = usePoolCopy();
  const key = useLeadsKey();
  const [from, to] = useMemo(() => {
    const now = new Date();
    return [
      new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
    ];
  }, []);
  const report = useQuery({ queryKey: [...key, 'prospects', 'report', from, to], queryFn: () => poolReport(from, to), retry: false });
  if (!report.data) return null;
  const sum = (field: 'created' | 'qualified' | 'promoted' | 'replied' | 'won') =>
    report.data.groups.reduce((total, group) => total + group[field], 0);
  const parts: [number, PoolCopyKey][] = [
    [sum('created'), 'found'],
    [sum('qualified'), 'qualified'],
    [sum('promoted'), 'inContact'],
    [sum('replied'), 'replied'],
    [sum('won'), 'won'],
  ];
  return (
    <p className="hidden min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm text-muted-foreground md:flex" aria-label={copy('funnel')}>
      <span>{copy('thisMonth')}:</span>
      {parts.map(([n, label], i) => (
        <span key={label}>
          <span className="font-semibold tabular-nums text-foreground">{n}</span> {copy(label)}
          {i < parts.length - 1 && <span aria-hidden="true"> ·</span>}
        </span>
      ))}
    </p>
  );
}

/**
 * The prospect pool's header, the same on its two pages: the title, the switch between the
 * prospects and their research tasks, this month's funnel, and the page's own actions.
 */
export function PoolHeader({ actions, className, framed = false }: { actions?: ReactNode; className?: string; framed?: boolean }) {
  const { t } = useTranslation();
  const copy = useTaskCopy();
  const { pathname } = useLocation();
  const onTasks = pathname === '/prospects/tasks';
  return (
    <header
      data-page-header=""
      className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5', framed && '-mx-4', className)}
    >
      <h1 className="font-display text-xl font-medium">{t('leads.prospects.title')}</h1>
      <nav aria-label={copy('navLabel')} className="flex gap-0.5">
        <Link to="/prospects" aria-current={onTasks ? undefined : 'page'} className={tabClass(!onTasks)}>
          {copy('navProspects')}
        </Link>
        <Link to="/prospects/tasks" aria-current={onTasks ? 'page' : undefined} className={tabClass(onTasks)}>
          {copy('navTasks')}
        </Link>
      </nav>
      <Funnel />
      {actions && <div className="ms-auto flex items-center gap-1">{actions}</div>}
    </header>
  );
}
