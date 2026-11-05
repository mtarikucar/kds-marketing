import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { getPlaybook, listProspects, promoteProspects } from '@/api/prospects';
import { listTasks } from '@/api/research';
import {
  PROSPECT_STATUSES,
  SCORE_BUCKETS,
  type NextPage,
  type PromoteOutcome,
  type ProspectListQuery,
  type ProspectRow,
  type ProspectStatus,
  type ResearchTask,
  type ScoreBucket,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, DataTable, Disclosure, EmptyState, Input, PageHeader, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDraftKey } from '@/lib/leads';
import { can } from '@/lib/roles';
import { selectClass } from './InboxShared';
import {
  BulkOutcomes,
  DncDialog,
  ProspectStatusBadge,
  RejectDialog,
  useLeadsKey,
  useLeadsRefresh,
  type BulkOutcome,
  type DecisionTarget,
} from './LeadsShared';

/** Prospects per page; the server pages by `(created_at, id)`, newest first. */
export const PROSPECTS_PAGE = 50;

interface Filters {
  status: ProspectStatus | '';
  bucket: ScoreBucket | '';
  city: string;
  segment: string;
  task: string;
}

/** A promotion outcome in the panel's words. */
export function promoteOutcomeText(t: TFunction, o: PromoteOutcome): string {
  switch (o.outcome) {
    case 'promoted':
      return t('leads.outcome.promoted');
    case 'already_promoted':
      return t('leads.outcome.alreadyPromoted');
    case 'refused':
      return isPromoteRefusal(o.reason) ? t(`leads.promoteRefused.${o.reason}`) : t('leads.promoteRefused.other');
  }
}

/** The refusal reasons of `prospects.promote` the panel has its own words for. */
const PROMOTE_REFUSALS = [
  'not_found',
  'not_qualified',
  'daily_cap',
  'no_contact_identity',
  'do_not_contact',
  'erased_identity',
  'identity_split',
  'lost_journey_exists',
  'person_already_linked',
  'already_promoted',
] as const;

function isPromoteRefusal(reason: string): reason is (typeof PROMOTE_REFUSALS)[number] {
  return (PROMOTE_REFUSALS as readonly string[]).includes(reason);
}

/** What a research task is called in a list: its ICP entry, or its brief's sectors. */
export function taskLabel(t: TFunction, task: ResearchTask): string {
  return task.kind.type === 'standing'
    ? t('leads.tasks.kind.standing', { key: task.kind.icp_key })
    : t('leads.tasks.kind.ad_hoc', { sectors: task.brief.sectors.join(', ') });
}

/** Whether a prospect may still be promoted, rejected or marked from its row. */
const open = (p: ProspectRow) => p.status === 'new' || p.status === 'qualified';

/** One row's promote button: its own mutation, so its pending state is its own (bug class "per-row mutation loading"). */
function PromoteButton({ prospect }: { prospect: ProspectRow }) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const draft = useDraftKey();
  const promote = useMutation({
    mutationFn: () =>
      promoteProspects({ prospect_ids: [prospect.id], request_key: draft.keyFor({ ids: [prospect.id] }) }),
    onSuccess: async (out) => {
      const outcome = out.items[0];
      if (outcome?.outcome === 'refused') toast.error(promoteOutcomeText(t, outcome));
      else toast.success(t('leads.outcome.promoted'));
      draft.reset();
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  return (
    <Button size="sm" variant="outline" loading={promote.isPending} onClick={() => !promote.isPending && promote.mutate()}>
      {t('leads.actions.promote')}
    </Button>
  );
}

/** `/prospects`: the pool, filtered and paged, with per-row and bulk actions (spec §9). */
export function ProspectsPage() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const key = useLeadsKey();
  const refresh = useLeadsRefresh();
  const canPromote = can(session.data, 'inbox.work');
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
  const bulkKey = useDraftKey();

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

  const bulkPromote = useMutation({
    mutationFn: (ids: string[]) => promoteProspects({ prospect_ids: ids, request_key: bulkKey.keyFor({ ids }) }),
    onSuccess: async (out) => {
      const names = new Map(rows.map((r) => [r.id, r.business_name]));
      setOutcomes(
        out.items.map((o) => ({
          id: o.prospect_id,
          name: names.get(o.prospect_id) ?? o.prospect_id,
          ok: o.outcome !== 'refused',
          text: promoteOutcomeText(t, o),
        })),
      );
      setSelected(new Set());
      bulkKey.reset();
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const hasFilters = Object.values(filters).some(Boolean);
  const clearFilters = () => {
    setFilters({ status: '', bucket: '', city: '', segment: '', task: '' });
    setCursors([]);
    setSelected(new Set());
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const columns = useMemo<ColumnDef<ProspectRow, unknown>[]>(
    () => [
      {
        id: 'select',
        enableSorting: false,
        header: () => (
          <input
            type="checkbox"
            aria-label={t('leads.prospects.selectPage')}
            checked={allOnPage}
            onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={t('leads.prospects.selectRow', { name: row.original.business_name })}
            checked={selected.has(row.original.id)}
            onChange={() => toggle(row.original.id)}
          />
        ),
      },
      {
        id: 'business',
        header: t('leads.prospects.columns.business'),
        accessorFn: (p) => p.business_name,
        cell: ({ row }) => (
          <Link to={`/prospects/${encodeURIComponent(row.original.id)}`} className="font-medium text-foreground hover:underline">
            {row.original.business_name}
          </Link>
        ),
      },
      { id: 'sector', header: t('leads.prospects.columns.sector'), accessorFn: (p) => p.sector ?? '—' },
      { id: 'city', header: t('leads.prospects.columns.city'), accessorFn: (p) => p.city ?? '—' },
      {
        id: 'score',
        header: t('leads.prospects.columns.score'),
        accessorFn: (p) => p.latest_score?.score ?? -1,
        cell: ({ row }) => <span className="tabular-nums">{row.original.latest_score?.score ?? '—'}</span>,
      },
      {
        id: 'status',
        header: t('leads.prospects.columns.status'),
        accessorFn: (p) => p.status,
        cell: ({ row }) => <ProspectStatusBadge status={row.original.status} />,
      },
      {
        id: 'origin',
        header: t('leads.prospects.columns.origin'),
        accessorFn: (p) => (p.research_task_id ? 'task' : 'direct'),
        cell: ({ row }) =>
          row.original.research_task_id ? t('leads.prospects.origin.task') : t('leads.prospects.origin.direct'),
      },
      {
        id: 'created',
        header: t('leads.prospects.columns.created'),
        accessorFn: (p) => p.created_at,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.created_at, i18n.language)}</span>
        ),
      },
      {
        id: 'actions',
        enableSorting: false,
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="flex flex-wrap justify-end gap-1">
              {open(p) && canPromote && <PromoteButton prospect={p} />}
              {open(p) && (
                <Button size="sm" variant="ghost" onClick={() => setRejecting(targets([p]))}>
                  {t('leads.actions.reject')}
                </Button>
              )}
              {p.status !== 'promoted' && p.status !== 'do_not_contact' && (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => setBlocking(targets([p]))}>
                  {t('leads.actions.dnc')}
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [t, i18n.language, rows, selected, allOnPage, canPromote],
  );

  const taskItems = tasks.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={t('leads.prospects.title')}
        description={t('leads.prospects.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/prospects/tasks">{t('leads.prospects.tasksLink')}</Link>
          </Button>
        }
      />
      <div className="border-y border-border py-2">
        <Disclosure title={t('leads.prospects.playbook')}>
          <Playbook />
        </Disclosure>
      </div>
      <section className="flex min-w-0 flex-col gap-4" aria-label={t('leads.prospects.title')}>
          <div className="border-b border-border pb-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.prospects.filters.status')}
              <select
                className={selectClass}
                value={filters.status}
                onChange={(e) => setFilter('status', e.target.value as ProspectStatus | '')}
              >
                <option value="">{t('leads.prospects.filters.all')}</option>
                {PROSPECT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`leads.status.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.prospects.filters.bucket')}
              <select
                className={selectClass}
                value={filters.bucket}
                onChange={(e) => setFilter('bucket', e.target.value as ScoreBucket | '')}
              >
                <option value="">{t('leads.prospects.filters.all')}</option>
                {SCORE_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" aria-expanded={moreFilters} aria-controls="prospect-more-filters"
            className="mt-3 text-sm font-medium text-primary hover:underline"
            onClick={() => setMoreFilters((open) => !open)}>
            {moreFilters ? t('leads.ux.hideFilters', { defaultValue: 'Hide extra filters' }) : t('leads.ux.moreFilters', { defaultValue: 'More filters' })}
            {[filters.task, filters.city, filters.segment].filter(Boolean).length > 0 && ` (${[filters.task, filters.city, filters.segment].filter(Boolean).length})`}
          </button>
          <div id="prospect-more-filters" hidden={!moreFilters} className={moreFilters ? "mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" : "hidden"}>
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
          </div>

          {chosen.length > 0 && (
            <div
              role="toolbar"
              aria-label={t('leads.bulk.label')}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm"
            >
              <span>{t('leads.bulk.selected', { n: chosen.length })}</span>
              {canPromote && (
                <Button
                  size="sm"
                  loading={bulkPromote.isPending}
                  disabled={!chosen.some(open)}
                  onClick={() => !bulkPromote.isPending && bulkPromote.mutate(chosen.filter(open).map((r) => r.id))}
                >
                  {t('leads.bulk.promote')}
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={!chosen.some(open)} onClick={() => setRejecting(targets(chosen.filter(open)))}>
                {t('leads.bulk.reject')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-danger"
                onClick={() =>
                  setBlocking(targets(chosen.filter((r) => r.status !== 'promoted' && r.status !== 'do_not_contact')))
                }
              >
                {t('leads.bulk.dnc')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t('leads.bulk.clear')}
              </Button>
            </div>
          )}
          {outcomes && <BulkOutcomes outcomes={outcomes} onDismiss={() => setOutcomes(null)} />}

          <QueryState query={list}>
            <DataTable
              columns={columns}
              data={rows}
              emptyState={hasFilters ? (
                <EmptyState title={t('leads.filteredEmpty.title')} description={t('leads.filteredEmpty.body')}
                  action={<Button variant="outline" onClick={clearFilters}>{t('leads.filteredEmpty.clear')}</Button>} />
              ) : (
                <EmptyState icon={<img src="/brand/scenes/prospects.svg" width="120" height="96" alt="" />}
                  title={t('leads.prospects.empty')} description={t('leads.prospects.emptyBody')}
                  action={<Button asChild variant="outline"><Link to="/prospects/tasks">{t('leads.prospects.tasksLink')}</Link></Button>} />
              )}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                {t('leads.prospects.previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!list.data?.next}
                onClick={() => {
                  const next = list.data?.next;
                  if (next) {
                    setCursors((c) => [...c, next]);
                    setSelected(new Set());
                  }
                }}
              >
                {t('leads.prospects.next')}
              </Button>
            </div>
          </QueryState>
      </section>
      {rejecting && rejecting.length > 0 && (
        <RejectDialog key={rejecting.map((x) => x.id).join()} targets={rejecting} onClose={() => setRejecting(null)} onDone={finished} />
      )}
      {blocking && blocking.length > 0 && (
        <DncDialog key={blocking.map((x) => x.id).join()} targets={blocking} onClose={() => setBlocking(null)} onDone={finished} />
      )}
    </>
  );
}

/** The agents' playbook as served (`prospects.playbook`), fetched only when opened. */
function Playbook() {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const playbook = useQuery({ queryKey: [...key, 'prospects', 'playbook'], queryFn: getPlaybook });
  return (
    <QueryState query={playbook}>
      {playbook.data && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">
            {t('leads.prospects.playbookFacts', {
              version: playbook.data.version,
              recorded: playbook.data.workspace.caps.recorded_today,
              cap: playbook.data.workspace.caps.daily_prospects,
            })}
          </p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-3 font-sans text-sm">
            {playbook.data.text}
          </pre>
        </div>
      )}
    </QueryState>
  );
}
