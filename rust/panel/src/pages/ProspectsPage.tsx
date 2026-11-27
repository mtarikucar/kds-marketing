import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { getPlaybook, listProspects } from '@/api/prospects';
import {
  SCORE_BUCKETS,
  type NextPage,
  type ProspectListQuery,
  type ProspectRow,
  type ProspectStatus,
  type ScoreBucket,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
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
  toast,
} from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { can } from '@/lib/roles';
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
import { PoolHeader, tabClass } from './prospects/PoolHeader';
import { ProspectFormDialog } from './prospects/ProspectFormDialog';
import { countOf, filterChoices, keyWords, shortDate, type FilterChoice } from './prospects/purpose';
import { usePoolPurposes, usePoolSegments } from './prospects/segments';
import { useTaskCopy } from './research/copy';
import { useAllTasks, useSegmentNames } from './research/data';
import { taskName } from './research/words';

export { promoteOutcomeText } from './prospects/words';
export { segmentOptions, type SegmentOption } from './prospects/segments';

/** Prospects per page; the server pages by `(created_at, id)`, newest first. */
export const PROSPECTS_PAGE = 50;

interface Filters {
  status: ProspectStatus | '';
  bucket: ScoreBucket | '';
  city: string;
  segment: string;
  /** The purpose: an ICP entry key. */
  purpose: string;
  task: string;
}

const NO_FILTERS: Filters = { status: '', bucket: '', city: '', segment: '', purpose: '', task: '' };

/** The score bands, the best first: the order a person works through them. */
const BUCKETS_BEST_FIRST: readonly ScoreBucket[] = [...SCORE_BUCKETS].reverse();

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

/**
 * One compact filter of the header: its name while nothing is chosen (choosing it again clears
 * the filter), each choice with how many prospects it holds under the other filters.
 */
function FilterSelect({
  label,
  placeholder,
  value,
  choices,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  choices: readonly FilterChoice[];
  onChange: (value: string) => void;
}) {
  const copy = usePoolCopy();
  return (
    <select
      aria-label={label}
      className={cn(selectClass, 'w-auto max-w-[12rem] py-1', value ? 'border-primary font-medium text-foreground' : 'text-muted-foreground')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.count === null ? c.label : copy('withCount', { label: c.label, n: c.count })}
        </option>
      ))}
    </select>
  );
}

/** One prospect as a compact row: the name opens it (the link covers the row), the box selects it. */
function Row({
  row,
  segment,
  current,
  showStatus,
  checked,
  onToggle,
}: {
  row: ProspectRow;
  /** What the row is for: its purpose's name, else its audience segment's, when it has one. */
  segment?: string;
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
        <span className="truncate text-xs text-muted-foreground">{[segment, row.sector, place].filter(Boolean).join(' · ') || '—'}</span>
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
  const linkedTask = params.get('task') ?? '';
  const [filters, setFilters] = useState<Filters>(() => ({ ...NO_FILTERS, task: linkedTask }));
  // The cursors of the pages before this one: empty on the first page.
  const [cursors, setCursors] = useState<NextPage[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rejecting, setRejecting] = useState<DecisionTarget[] | null>(null);
  const [blocking, setBlocking] = useState<DecisionTarget[] | null>(null);
  const [outcomes, setOutcomes] = useState<BulkOutcome[] | null>(null);
  const [playbook, setPlaybook] = useState(false);
  const [adding, setAdding] = useState(false);
  const session = useSession();
  const navigate = useNavigate();
  const canAdd = can(session.data, 'prospects.work');

  const page = cursors.at(-1);
  const filtered: ProspectListQuery = {
    status: filters.status || undefined,
    bucket: filters.bucket || undefined,
    city: filters.city.trim() || undefined,
    segment_key: filters.segment.trim() || undefined,
    icp_key: filters.purpose || undefined,
    research_task_id: filters.task || undefined,
  };
  const query: ProspectListQuery = {
    ...filtered,
    limit: PROSPECTS_PAGE,
    before_at: page?.before_at,
    before_id: page?.before_id,
  };
  const list = useQuery({
    queryKey: [...key, 'prospects', 'list', query],
    queryFn: () => listProspects(query),
    placeholderData: keepPreviousData,
  });
  // How full each class is, every filter counted under the others: one small read per filter set.
  const counted = useQuery({
    queryKey: [...key, 'prospects', 'counts', filtered],
    queryFn: () => listProspects({ ...filtered, limit: 1, counts: true }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const counts = counted.data?.counts;
  const tasks = useAllTasks();
  const taskCopy = useTaskCopy();
  const segmentNames = useSegmentNames();
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  // The classes are this workspace's own segments and ICP entries, never a fixed list.
  const segments = usePoolSegments(
    rows.map((r) => r.segment_key),
    filters.segment,
  );
  const purposes = usePoolPurposes(
    rows.map((r) => r.icp_key),
    filters.purpose,
  );
  const language = taskCopy.language;
  const purposeName = (icpKey: string) => purposes.find((x) => x.key === icpKey)?.name ?? keyWords(icpKey, language);
  const segmentName = (segmentKey: string | null) => segments.find((s) => s.key === segmentKey)?.name;
  const rowClass = (r: ProspectRow) => (r.icp_key ? purposeName(r.icp_key) : (segmentName(r.segment_key) ?? r.segment_key ?? undefined));

  // A link to a task's prospects (`?task=`) chooses that task, also while the page is open.
  useEffect(() => {
    if (!linkedTask) return;
    setFilters((f) => (f.task === linkedTask ? f : { ...f, task: linkedTask }));
    setCursors([]);
    setSelected(new Set());
  }, [linkedTask]);

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

  const classFilters = [filters.purpose, filters.segment, filters.bucket, filters.city, filters.task].filter(Boolean).length;
  const hasFilters = Object.values(filters).some(Boolean);
  const clearFilters = () => {
    setFilters(NO_FILTERS);
    setCursors([]);
    setSelected(new Set());
  };
  const clearClasses = () => {
    setFilters((f) => ({ ...NO_FILTERS, status: f.status }));
    setCursors([]);
    setSelected(new Set());
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const blockable = chosen.filter((r) => r.status !== 'promoted' && r.status !== 'do_not_contact');

  // Each filter's choices: the workspace's own values first, then whatever the pool holds.
  const allTasks = (tasks.data?.pages ?? []).flatMap((p) => p.items.map((x) => x.task));
  const countedTasks = new Set((counts?.research_task_id ?? []).map((c) => c.key));
  const taskLabel = (id: string) => {
    const task = allTasks.find((x) => x.id === id);
    if (task) return `${taskName(taskCopy, task, segmentNames)} · ${shortDate(task.created_at, language)}`;
    return id === filters.task ? t('leads.prospects.filters.thisTask') : copy('olderTask');
  };
  const choices = {
    purpose: filterChoices(
      purposes.map((x) => x.key),
      counts?.icp_key,
      filters.purpose,
      purposeName,
    ),
    segment: filterChoices(
      segments.map((x) => x.key),
      counts?.segment_key,
      filters.segment,
      (k) => segmentName(k) ?? k,
    ),
    bucket: filterChoices(BUCKETS_BEST_FIRST, counts?.bucket, filters.bucket, (b) => b),
    city: filterChoices(
      (counts?.city ?? []).flatMap((c) => (c.key ? [c.key] : [])).sort((a, b) => a.localeCompare(b, language)),
      counts?.city,
      filters.city,
      (c) => c,
    ),
    task: filterChoices(
      allTasks.filter((x) => x.status === 'open' || countedTasks.has(x.id)).map((x) => x.id),
      counts?.research_task_id,
      filters.task,
      taskLabel,
    ),
  };
  const statusCount = (status: ProspectStatus | '') =>
    status === '' ? (counts ? counts.status.reduce((n, c) => n + c.count, 0) : null) : countOf(counts?.status, status);

  return (
    <div className="flex min-w-0 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[36rem]">
      <PoolHeader
        className={cn(prospectId && 'hidden lg:flex')}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setPlaybook(true)}>
              {t('leads.prospects.playbook')}
            </Button>
            {canAdd && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {copy('addProspect')}
              </Button>
            )}
          </>
        }
      />

      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2', prospectId && 'hidden lg:flex')}>
        <div role="group" aria-label={copy('tabs')} className="flex min-w-0 gap-0.5 overflow-x-auto">
          {TABS.map(({ status, label }) => {
            const n = statusCount(status);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={filters.status === status}
                onClick={() => setFilter('status', status)}
                className={tabClass(filters.status === status)}
              >
                {copy(label)}
                {n !== null && <span className="ms-1 text-xs font-normal tabular-nums text-muted-foreground"> {n}</span>}
              </button>
            );
          })}
        </div>
        <div role="group" aria-label={copy('filters')} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <FilterSelect
            label={t('leads.prospects.filters.purpose')}
            placeholder={copy('fltPurpose')}
            value={filters.purpose}
            choices={choices.purpose}
            onChange={(v) => setFilter('purpose', v)}
          />
          <FilterSelect
            label={t('leads.prospects.filters.segment')}
            placeholder={copy('fltSegment')}
            value={filters.segment}
            choices={choices.segment}
            onChange={(v) => setFilter('segment', v)}
          />
          <FilterSelect
            label={t('leads.prospects.filters.bucket')}
            placeholder={copy('fltScore')}
            value={filters.bucket}
            choices={choices.bucket}
            onChange={(v) => setFilter('bucket', v as ScoreBucket | '')}
          />
          <FilterSelect
            label={t('leads.prospects.filters.city')}
            placeholder={copy('fltCity')}
            value={filters.city}
            choices={choices.city}
            onChange={(v) => setFilter('city', v)}
          />
          <FilterSelect
            label={t('leads.prospects.filters.task')}
            placeholder={copy('fltTask')}
            value={filters.task}
            choices={choices.task}
            onChange={(v) => setFilter('task', v)}
          />
          {classFilters > 0 && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={clearClasses}>
              {copy('fltClear')}
            </Button>
          )}
        </div>
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
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button asChild variant="outline">
                          <Link to="/prospects/tasks">{t('leads.prospects.tasksLink')}</Link>
                        </Button>
                        {canAdd && <Button onClick={() => setAdding(true)}>{copy('addProspect')}</Button>}
                      </div>
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
                    segment={rowClass(row)}
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
      {adding && (
        <ProspectFormDialog
          segments={segments}
          onClose={() => setAdding(false)}
          onSaved={(saved) => navigate(`/prospects/${encodeURIComponent(saved.id)}`)}
        />
      )}
      {rejecting && rejecting.length > 0 && (
        <RejectDialog key={rejecting.map((x) => x.id).join()} targets={rejecting} onClose={() => setRejecting(null)} onDone={finished} />
      )}
      {blocking && blocking.length > 0 && (
        <DncDialog key={blocking.map((x) => x.id).join()} targets={blocking} onClose={() => setBlocking(null)} onDone={finished} />
      )}
    </div>
  );
}
