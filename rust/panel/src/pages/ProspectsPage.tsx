import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { getPlaybook, listProspects, poolReport } from '@/api/prospects';
import { listTasks } from '@/api/research';
import {
  SCORE_BUCKETS,
  type NextPage,
  type ProspectListQuery,
  type ProspectRow,
  type ProspectStatus,
  type ScoreBucket,
} from '@/api/types';
import { QueryState } from '@/components/QueryState';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconButton,
  Input,
  toast,
} from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { selectClass } from './InboxShared';
import {
  BulkOutcomes,
  DncDialog,
  ProspectStatusBadge,
  RejectDialog,
  useLeadsKey,
  type BulkOutcome,
  type DecisionTarget,
} from './LeadsShared';
import { ProspectPane } from './ProspectDetail';
import { usePoolCopy, type PoolCopyKey } from './prospects/copy';
import { taskLabel } from './prospects/words';

export { promoteOutcomeText, taskLabel } from './prospects/words';

/** Prospects per page; the server pages by `(created_at, id)`, newest first. */
export const PROSPECTS_PAGE = 50;

interface Filters {
  status: ProspectStatus | '';
  bucket: ScoreBucket | '';
  city: string;
  segment: string;
  task: string;
}

/** The status tabs, in the order a prospect moves through them. */
const TABS: readonly { status: ProspectStatus | ''; label: PoolCopyKey }[] = [
  { status: '', label: 'tabAll' },
  { status: 'new', label: 'tabNew' },
  { status: 'qualified', label: 'tabQualified' },
  { status: 'promoted', label: 'tabContact' },
  { status: 'rejected', label: 'tabRejected' },
  { status: 'do_not_contact', label: 'tabBlocked' },
];

/** Whether a prospect may still be rejected from the list. */
const open = (p: ProspectRow) => p.status === 'new' || p.status === 'qualified';

const SCORE_TONE: Record<ScoreBucket, string> = {
  '75-100': 'bg-success-subtle text-success',
  '50-74': 'bg-warning-subtle text-warning',
  '25-49': 'bg-surface-muted text-muted-foreground',
  '0-24': 'bg-surface-muted text-muted-foreground',
};

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

/** The agents' playbook as served (`prospects.playbook`), read when its dialog opens. */
function PlaybookDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const playbook = useQuery({ queryKey: [...key, 'prospects', 'playbook'], queryFn: getPlaybook });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('leads.prospects.playbook')}</DialogTitle>
          <DialogDescription>
            {playbook.data
              ? t('leads.prospects.playbookFacts', {
                  version: playbook.data.version,
                  recorded: playbook.data.workspace.caps.recorded_today,
                  cap: playbook.data.workspace.caps.daily_prospects,
                })
              : ' '}
          </DialogDescription>
        </DialogHeader>
        <QueryState query={playbook}>
          {playbook.data && (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-3 font-sans text-sm">{playbook.data.text}</pre>
          )}
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}

/** One prospect as a compact row: the name opens it (the link covers the row), the box selects it. */
function Row({
  row,
  current,
  showStatus,
  checked,
  onToggle,
}: {
  row: ProspectRow;
  current: boolean;
  showStatus: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation();
  const copy = usePoolCopy();
  const place = [row.district, row.city].filter(Boolean).join(', ');
  return (
    <li
      className={cn(
        'relative flex items-center gap-2.5 border-b border-border/60 px-3 py-2',
        current ? 'bg-primary-50 shadow-[inset_3px_0_0_var(--primary)] dark:bg-primary-950/50' : 'hover:bg-surface-muted',
      )}
      data-testid="prospect-row"
    >
      <input
        type="checkbox"
        className="relative z-10 shrink-0"
        aria-label={t('leads.prospects.selectRow', { name: row.business_name })}
        checked={checked}
        onChange={onToggle}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          to={`/prospects/${encodeURIComponent(row.id)}`}
          aria-current={current ? 'page' : undefined}
          className="truncate text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {row.business_name}
        </Link>
        <span className="truncate text-xs text-muted-foreground">{[row.sector, place].filter(Boolean).join(' · ') || '—'}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className={cn('rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums', row.bucket ? SCORE_TONE[row.bucket] : 'text-muted-foreground')}
          title={row.latest_score ? copy('score', { score: row.latest_score.score }) : copy('noScore')}
        >
          {row.latest_score?.score ?? '—'}
        </span>
        {showStatus ? (
          <ProspectStatusBadge status={row.status} />
        ) : (
          <span className="text-[11px] text-muted-foreground">{formatRelative(row.created_at, i18n.language)}</span>
        )}
      </div>
    </li>
  );
}

/**
 * `/prospects` and `/prospects/:prospectId`: the pool as one working surface (spec
 * 2026-11-10-prospects-pool-redesign-design.md). The list on the left, filtered and paged, with
 * bulk reject and do-not-contact; the chosen prospect on the right. On a narrow screen the list
 * comes first and a chosen prospect replaces it.
 */
export function ProspectsPage() {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const key = useLeadsKey();
  const { prospectId } = useParams();
  const [params] = useSearchParams();
  const [moreFilters, setMoreFilters] = useState(() => Boolean(params.get('task')));
  const [filters, setFilters] = useState<Filters>(() => ({
    status: '',
    bucket: '',
    city: '',
    segment: '',
    task: params.get('task') ?? '',
  }));
  // The cursors of the pages before this one: empty on the first page.
  const [cursors, setCursors] = useState<NextPage[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rejecting, setRejecting] = useState<DecisionTarget[] | null>(null);
  const [blocking, setBlocking] = useState<DecisionTarget[] | null>(null);
  const [outcomes, setOutcomes] = useState<BulkOutcome[] | null>(null);
  const [playbook, setPlaybook] = useState(false);

  const page = cursors.at(-1);
  const query: ProspectListQuery = {
    status: filters.status || undefined,
    bucket: filters.bucket || undefined,
    city: filters.city.trim() || undefined,
    segment_key: filters.segment.trim() || undefined,
    research_task_id: filters.task || undefined,
    limit: PROSPECTS_PAGE,
    before_at: page?.before_at,
    before_id: page?.before_id,
  };
  const list = useQuery({
    queryKey: [...key, 'prospects', 'list', query],
    queryFn: () => listProspects(query),
    placeholderData: keepPreviousData,
  });
  const tasks = useQuery({ queryKey: [...key, 'research', 'list', 'open'], queryFn: () => listTasks({ status: 'open' }) });
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);

  const setFilter = <K extends keyof Filters>(name: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [name]: value }));
    setCursors([]);
    setSelected(new Set());
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const chosen = rows.filter((r) => selected.has(r.id));
  const targets = (from: ProspectRow[]): DecisionTarget[] =>
    from.map((r) => ({ id: r.id, business_name: r.business_name, revision: r.revision }));
  const finished = (out: BulkOutcome[]) => {
    setRejecting(null);
    setBlocking(null);
    setSelected(new Set());
    if (out.length > 1) setOutcomes(out);
    else if (out[0]) toast.success(out[0].text);
  };

  const extraFilters = [filters.bucket, filters.task, filters.city, filters.segment].filter(Boolean).length;
  const hasFilters = Object.values(filters).some(Boolean);
  const clearFilters = () => {
    setFilters({ status: '', bucket: '', city: '', segment: '', task: '' });
    setCursors([]);
    setSelected(new Set());
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const taskItems = tasks.data?.items ?? [];
  const blockable = chosen.filter((r) => r.status !== 'promoted' && r.status !== 'do_not_contact');

  return (
    <div className="flex min-w-0 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[36rem]">
      <header className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5', prospectId && 'hidden lg:flex')}>
        <h1 className="font-display text-xl font-medium">{t('leads.prospects.title')}</h1>
        <Funnel />
        <div className="ms-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setPlaybook(true)}>
            {t('leads.prospects.playbook')}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/prospects/tasks">{t('leads.prospects.tasksLink')}</Link>
          </Button>
        </div>
      </header>

      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2', prospectId && 'hidden lg:flex')}>
        <div role="group" aria-label={copy('tabs')} className="flex min-w-0 gap-0.5 overflow-x-auto">
          {TABS.map(({ status, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={filters.status === status}
              onClick={() => setFilter('status', status)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filters.status === status ? 'bg-primary-50 font-semibold text-foreground dark:bg-primary-950/60' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {copy(label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={moreFilters}
          aria-controls="prospect-more-filters"
          className="ms-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setMoreFilters((v) => !v)}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          {moreFilters ? t('leads.ux.hideFilters', { defaultValue: 'Hide extra filters' }) : t('leads.ux.moreFilters', { defaultValue: 'More filters' })}
          {extraFilters > 0 && ` (${extraFilters})`}
        </button>
      </div>

      <div
        id="prospect-more-filters"
        hidden={!moreFilters}
        className={moreFilters ? cn('grid gap-3 border-b border-border px-4 py-3 sm:grid-cols-2 xl:grid-cols-4', prospectId && 'hidden lg:grid') : 'hidden'}
      >
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.prospects.filters.bucket')}
          <select className={selectClass} value={filters.bucket} onChange={(e) => setFilter('bucket', e.target.value as ScoreBucket | '')}>
            <option value="">{t('leads.prospects.filters.all')}</option>
            {SCORE_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.prospects.filters.task')}
          <select className={selectClass} value={filters.task} onChange={(e) => setFilter('task', e.target.value)}>
            <option value="">{t('leads.prospects.filters.all')}</option>
            {filters.task && !taskItems.some((x) => x.task.id === filters.task) && (
              <option value={filters.task}>{t('leads.prospects.filters.thisTask')}</option>
            )}
            {taskItems.map(({ task }) => (
              <option key={task.id} value={task.id}>
                {taskLabel(t, task)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.prospects.filters.city')}
          <Input value={filters.city} autoComplete="off" onChange={(e) => setFilter('city', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.prospects.filters.segment')}
          <Input value={filters.segment} autoComplete="off" onChange={(e) => setFilter('segment', e.target.value)} />
        </label>
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section
          aria-label={copy('listLabel')}
          className={cn('flex min-h-0 min-w-0 flex-col border-border lg:border-e', prospectId && 'hidden lg:flex')}
        >
          {chosen.length > 0 && (
            <div role="toolbar" aria-label={t('leads.bulk.label')} className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-muted px-3 py-2 text-sm">
              <span className="me-auto">{t('leads.bulk.selected', { n: chosen.length })}</span>
              <Button size="sm" variant="outline" disabled={!chosen.some(open)} onClick={() => setRejecting(targets(chosen.filter(open)))}>
                {t('leads.bulk.reject')}
              </Button>
              <Button size="sm" variant="outline" className="text-danger" disabled={blockable.length === 0} onClick={() => setBlocking(targets(blockable))}>
                {t('leads.bulk.dnc')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t('leads.bulk.clear')}
              </Button>
            </div>
          )}
          {outcomes && (
            <div className="border-b border-border p-3">
              <BulkOutcomes outcomes={outcomes} onDismiss={() => setOutcomes(null)} />
            </div>
          )}
          <QueryState query={list}>
            {rows.length === 0 ? (
              <div className="p-4">
                {hasFilters ? (
                  <EmptyState
                    title={t('leads.filteredEmpty.title')}
                    description={t('leads.filteredEmpty.body')}
                    action={
                      <Button variant="outline" onClick={clearFilters}>
                        {t('leads.filteredEmpty.clear')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<img src="/brand/scenes/prospects.svg" width="120" height="96" alt="" />}
                    title={t('leads.prospects.empty')}
                    description={t('leads.prospects.emptyBody')}
                    action={
                      <Button asChild variant="outline">
                        <Link to="/prospects/tasks">{t('leads.prospects.tasksLink')}</Link>
                      </Button>
                    }
                  />
                )}
              </div>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={copy('listLabel')}>
                {rows.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    current={row.id === prospectId}
                    showStatus={filters.status === ''}
                    checked={selected.has(row.id)}
                    onToggle={() => toggle(row.id)}
                  />
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label={t('leads.prospects.selectPage')}
                  disabled={rows.length === 0}
                  checked={allOnPage}
                  onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))}
                />
                <span aria-hidden="true">{t('leads.prospects.selectPage')}</span>
              </label>
              <span className="ms-auto flex items-center gap-1">
                <IconButton size="sm" variant="ghost" aria-label={t('leads.prospects.previous')} disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={t('leads.prospects.next')}
                  disabled={!list.data?.next}
                  onClick={() => {
                    const next = list.data?.next;
                    if (next) {
                      setCursors((c) => [...c, next]);
                      setSelected(new Set());
                    }
                  }}
                >
                  <ChevronRight className="h-4 w-4" />
                </IconButton>
              </span>
            </div>
          </QueryState>
        </section>

        <section className={cn('flex min-h-0 min-w-0 flex-col', !prospectId && 'hidden lg:flex')}>
          {prospectId ? (
            <ProspectPane prospectId={prospectId} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
              <p className="text-sm font-medium">{copy('choose')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{copy('chooseBody')}</p>
            </div>
          )}
        </section>
      </div>

      {playbook && <PlaybookDialog onClose={() => setPlaybook(false)} />}
      {rejecting && rejecting.length > 0 && (
        <RejectDialog key={rejecting.map((x) => x.id).join()} targets={rejecting} onClose={() => setRejecting(null)} onDone={finished} />
      )}
      {blocking && blocking.length > 0 && (
        <DncDialog key={blocking.map((x) => x.id).join()} targets={blocking} onClose={() => setBlocking(null)} onDone={finished} />
      )}
    </div>
  );
}
