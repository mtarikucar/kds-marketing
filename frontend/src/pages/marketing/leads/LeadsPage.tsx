import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SortingState } from '@tanstack/react-table';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Download, SlidersHorizontal } from 'lucide-react';

import {
  listLeads,
  bulkAssignLeads,
  bulkDeleteLeads,
  bulkEnrollLeads,
  exportLeadsCsv,
} from '../../../features/marketing/api/leads.service';
import type { LeadListParams } from '../../../features/marketing/api/leads.service';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { BulkActionToolbar } from '../../../features/marketing/components';
import {
  LeadStatus,
  BusinessType,
  LeadSource,
  LEAD_STATUS_LABELS,
  BUSINESS_TYPE_LABELS,
  LEAD_SOURCE_LABELS,
} from '../../../features/marketing/types';
import type { Lead, MarketingUserInfo, PaginatedResponse } from '../../../features/marketing/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

import {
  PageHeader,
  FilterBar,
  DataTable,
  Pagination,
  EmptyState,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  QueryStateBoundary,
  ConfirmDialog,
  Badge,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui';

import { buildLeadsColumns } from './leadsColumns';
import { bulkDeleteToast, bulkAssignToast } from './leadsBulkToast';

type AssignmentStatus = '' | 'unassigned' | 'assigned' | 'mine';

interface RepRow extends MarketingUserInfo {
  status?: string;
  role?: string;
}

const LIMIT = 20;

/** The three named work queues of the Kişiler tab, in the spec's order. */
type Queue = 'waiting' | 'unassigned' | 'all';
const QUEUE_PARAMS: Record<Queue, Pick<LeadListParams, 'assignmentStatus' | 'waitingReply'>> = {
  waiting: { waitingReply: true },
  unassigned: { assignmentStatus: 'unassigned' },
  all: {},
};

/**
 * How many leads one queue would show under the CURRENT other filters — the
 * number on the chip is what you get when you click it.
 *
 * The queue you are already in is never probed: the list query has just
 * counted exactly that set, so a second count is only one more number that can
 * disagree with the rows on screen.
 */
function useQueueCount(
  base: Pick<LeadListParams, 'search' | 'status' | 'source' | 'businessType'>,
  queue: Queue,
  active: Queue | null,
) {
  return useQuery({
    queryKey: ['marketing', 'leads', 'queue-count', queue, base],
    queryFn: () =>
      listLeads({ ...base, ...QUEUE_PARAMS[queue], page: 1, limit: 1 }).then(
        (r) => r.meta.total,
      ),
    enabled: queue !== active,
    staleTime: 30_000,
  });
}

/**
 * The number on a work-queue chip.
 *
 * Three states, and they must not read alike. A count we HAVE is the number; a
 * count we could not fetch is an em dash that says so when you hover or ask a
 * screen reader; a count still in flight is nothing at all. Rendering a failed
 * count as `0` would announce an empty queue when nobody knows whether it is
 * empty — the same "a failed query and no results look identical" bug this
 * repo already paid for in the morning brief.
 */
function QueueCount({
  total,
  isError,
  failedLabel,
}: {
  total?: number;
  isError?: boolean;
  failedLabel: string;
}) {
  if (isError)
    return (
      <span title={failedLabel} aria-label={failedLabel}>
        —
      </span>
    );
  if (typeof total !== 'number') return null;
  return <span>{total}</span>;
}

/**
 * Leads list page — Console design system migration.
 *
 * Behavior (query keys, URL params, mutations, invalidations, pagination,
 * row navigation, bulk-assign) is preserved verbatim from the original
 * LeadsPage.tsx. Presentation is migrated to Console primitives.
 *
 * `embedded` renders it as the Kişiler tab of the merged surface: the host
 * owns the one PageHeader, so this drops its own rather than stacking a second
 * <h1>. The actions do NOT disappear with it — they move into a toolbar row,
 * the arrangement ChannelsSettingsPage and SnippetsPage already use as
 * embedded tabs of the same shell. They stay HERE rather than moving up into
 * the host's header because Export CSV exports the current filters, and the
 * filters live in this component.
 */
export default function LeadsPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [searchParams, setSearchParams] = useSearchParams();

  // URL-driven assignment filter so a manager can share a link like
  // "/leads?assignmentStatus=unassigned" from the dashboard
  // card or paste it into Slack as a triage queue.
  const initialAssignment =
    (searchParams.get('assignmentStatus') as AssignmentStatus) || '';

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [assignmentStatus, setAssignmentStatus] =
    useState<AssignmentStatus>(initialAssignment);
  // Also URL-driven, and for the same two reasons: it is shareable, and Radix
  // unmounts this whole page every time someone visits Konuşmalar and comes
  // back — local state would not survive that trip, the URL does.
  const [waiting, setWaiting] = useState(searchParams.get('waiting') === '1');
  // Server-side sort: the DataTable headers were sortable but uncontrolled, so a
  // click only reordered the 20 visible rows (and reset on paginate). Drive the
  // sort through the query instead so the WHOLE dataset is ordered. Column ids
  // match the backend allow-list (businessName / city / createdAt).
  const [sorting, setSorting] = useState<SortingState>([]);
  const sortBy = sorting[0]?.id;
  const sortOrder: 'asc' | 'desc' | undefined = sorting[0]
    ? sorting[0].desc
      ? 'desc'
      : 'asc'
    : undefined;
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // Sync URL when the queue filters change so deep-links stay current.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (assignmentStatus) next.set('assignmentStatus', assignmentStatus);
    else next.delete('assignmentStatus');
    if (waiting) next.set('waiting', '1');
    else next.delete('waiting');
    // Only update if changed to avoid a render loop with React Router.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentStatus, waiting]);

  // Preserve verbatim query key: ['marketing','leads',{ search, status, source, businessType, assignmentStatus, page }]
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [
      'marketing',
      'leads',
      { search, status, source, businessType, assignmentStatus, waiting, sortBy, sortOrder, page },
    ],
    queryFn: () =>
      listLeads({
        search: search || undefined,
        status: status || undefined,
        source: source || undefined,
        businessType: businessType || undefined,
        assignmentStatus: assignmentStatus || undefined,
        waitingReply: waiting || undefined,
        sortBy,
        sortOrder,
        page,
        limit: LIMIT,
      }),
  });

  // ── Work queue ─────────────────────────────────────────────────────────────
  // Three named queues over the same list. `Bekleyen` is what nobody has
  // answered, `Atanmamış` is what nobody owns, `Hepsi` is everything —
  // including the leads that have never had a conversation, who are invisible
  // on the Konuşmalar tab by construction and are the reason this tab exists.
  //
  // Single-select, and the chips own BOTH dimensions, so picking one never
  // leaves the previous one stacked silently underneath. Choosing "Bana
  // atanmış" from the assignment Select is a view none of the three describes,
  // and then no chip is lit — which is the truth, not a bug.
  const activeQueue: Queue | null = waiting
    ? 'waiting'
    : assignmentStatus === 'unassigned'
      ? 'unassigned'
      : assignmentStatus === ''
        ? 'all'
        : null;

  const selectQueue = (q: Queue) => {
    setWaiting(q === 'waiting');
    setAssignmentStatus(q === 'unassigned' ? 'unassigned' : '');
    setPage(1);
  };

  // The chip promises "click me and you get this many rows", so the count is
  // measured under the SAME other filters as the list. The queue you are
  // already in is not probed at all: the list has just counted it, and asking
  // twice is one more pair of numbers that can disagree.
  const countBase = {
    search: search || undefined,
    status: status || undefined,
    source: source || undefined,
    businessType: businessType || undefined,
  };
  const waitingCount = useQueueCount(countBase, 'waiting', activeQueue);
  const unassignedCount = useQueueCount(countBase, 'unassigned', activeQueue);
  const allCount = useQueueCount(countBase, 'all', activeQueue);

  // Reps used by both AssignCell popovers (per row) and BulkActionToolbar.
  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });

  // Clear stale selection when the visible page changes; otherwise the
  // checkbox state would silently drift across paginations.
  useEffect(() => {
    setSelected(new Set());
  }, [page, search, status, source, businessType, assignmentStatus, waiting, sortBy, sortOrder]);

  // Bulk assign mutation — preserved verbatim (keys + invalidations).
  const bulkAssign = useMutation({
    mutationFn: (repId: string | null) =>
      bulkAssignLeads(Array.from(selected), repId ?? null),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
      // Surface unchanged/not-found so a re-assign of already-owned contacts
      // isn't a bare "0 assigned" no-op (mirrors the bulk-delete signal fix).
      const { text, tone } = bulkAssignToast(res, t);
      (tone === 'info' ? toast.info : toast.success)(text);
      setSelected(new Set());
    },
    onError: () => toast.error(t('leads.bulkAssign.error')),
  });

  // Bulk soft-delete the selected leads.
  const bulkDelete = useMutation({
    mutationFn: () => bulkDeleteLeads(Array.from(selected)),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
      // Surface the backend's `skippedProtected` (WON/converted leads it refuses
      // to delete) so a partial/blocked delete is explained, not a silent no-op.
      const { text, tone } = bulkDeleteToast(res, t);
      (tone === 'info' ? toast.info : toast.success)(text);
      setSelected(new Set());
    },
    onError: () => toast.error(t('leads.bulkDelete.error', { defaultValue: 'Failed to delete leads' })),
  });

  // Manually enroll the selected leads into a workflow.
  const bulkEnroll = useMutation({
    mutationFn: (workflowId: string) => bulkEnrollLeads(Array.from(selected), workflowId),
    onSuccess: (res) => {
      // Enrollment now fans out in a background batch job; the API returns the
      // queued count rather than a synchronous enrolled total.
      toast.success(t('leads.bulkEnroll.success', { defaultValue: 'Enrolling {{count}} lead(s) in the background', count: res?.queued ?? 0 }));
      setSelected(new Set());
    },
    onError: () => toast.error(t('leads.bulkEnroll.error', { defaultValue: 'Failed to enroll leads' })),
  });

  // Workflows for the bulk-enroll picker (manager only).
  const { data: workflows = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['marketing', 'workflows', 'pick'],
    queryFn: () => marketingApi.get('/workflows').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });

  // Export the current filtered list as CSV.
  const exporting = useMutation({
    mutationFn: () =>
      exportLeadsCsv({
        search,
        status,
        source,
        businessType,
        assignmentStatus,
        // The queue is a filter like any other; an export that quietly ignored
        // it would hand back everything under a button sitting next to a chip
        // that says "2".
        waitingReply: waiting || undefined,
      }),
    onError: () => toast.error(t('leads.export.error', { defaultValue: 'Export failed' })),
  });

  const leads = data?.data ?? [];
  const visibleIds = useMemo(() => leads.map((l) => l.id), [leads]);
  const allChecked =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someChecked =
    visibleIds.some((id) => selected.has(id)) && !allChecked;

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) visibleIds.forEach((id) => next.add(id));
      else visibleIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  // Indeterminate header checkbox ref callback.
  const headerCheckboxRef = (node: HTMLInputElement | null) => {
    if (node) node.indeterminate = someChecked;
  };

  // Build columns (stable reference via useMemo).
  const columns = useMemo(
    () => buildLeadsColumns(t, isManager),
    [t, isManager],
  );

  // Prepend a checkbox column when manager.
  const tableColumns = useMemo(() => {
    if (!isManager) return columns;
    return [
      {
        id: '__select',
        header: () => (
          <input
            ref={headerCheckboxRef}
            type="checkbox"
            checked={allChecked}
            onChange={(e) => toggleAll(e.target.checked)}
            className="rounded border-border-strong text-primary focus:ring-primary"
            aria-label={t('common.selectAll', 'Select all')}
          />
        ),
        cell: ({ row }: { row: { original: Lead } }) => (
          <input
            type="checkbox"
            checked={selected.has(row.original.id)}
            onChange={(e) => toggleOne(row.original.id, e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            className="rounded border-border-strong text-primary focus:ring-primary"
            aria-label={t('common.selectRow', 'Select row')}
          />
        ),
        enableSorting: false,
      },
      ...columns,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isManager, allChecked, someChecked, selected]);

  const emptyDescription = assignmentStatus === 'unassigned'
    ? t('leads.emptyUnassigned', 'No unassigned leads — all leads are tracked.')
    : isManager
    ? t(
        'leads.emptyManager',
        'No leads yet. Use "New Lead" or wait for AI Research to create some.',
      )
    : t('leads.empty', 'No leads found.');

  const actions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="md" onClick={() => exporting.mutate()} loading={exporting.isPending}>
        <Download className="w-4 h-4" aria-hidden="true" />
        {t('leads.export.button', { defaultValue: 'Export CSV' })}
      </Button>
      <Button asChild size="md">
        <Link to="/leads/new">
          <Plus className="w-4 h-4" aria-hidden="true" />
          {t('leads.createButton')}
        </Link>
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Page header — suppressed when this is the merged surface's Kişiler
          tab, where the host already rendered one. The actions never go with
          it; they move to the toolbar row below. */}
      {!embedded && (
        <PageHeader
          title={t('leads.title')}
          description={t('leads.subtitle')}
          actions={actions}
        />
      )}

      {/* Work queue + (when embedded) the actions the host's header gave up.
          The chips lead because they are the first decision on this tab: which
          pile am I working. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={t('leads.queue.label', { defaultValue: 'İş kuyruğu' })}
          className="flex flex-wrap items-center gap-2"
        >
          {(
            [
              ['waiting', t('leads.queue.waiting', { defaultValue: 'Bekleyen' }), waitingCount,
                t('leads.queue.waitingHint', {
                  defaultValue: 'Müşteri en son yazan taraf ve kimse yanıtlamadı',
                })],
              ['unassigned', t('leads.queue.unassigned', { defaultValue: 'Atanmamış' }), unassignedCount, undefined],
              ['all', t('leads.queue.all', { defaultValue: 'Hepsi' }), allCount, undefined],
            ] as const
          ).map(([queue, label, count, hint]) => (
            <Button
              key={queue}
              size="sm"
              variant={activeQueue === queue ? 'primary' : 'outline'}
              aria-pressed={activeQueue === queue}
              title={hint}
              onClick={() => selectQueue(queue)}
            >
              {label}
              {/* An explicit space, not just the flex gap: the accessible name
                  is built from text nodes, and without it a screen reader
                  announces "Bekleyen2". */}
              {' '}
              <QueueCount
                total={activeQueue === queue ? data?.meta.total : count.data}
                isError={activeQueue !== queue && count.isError}
                failedLabel={t('leads.queue.countFailed', { defaultValue: 'Sayı alınamadı' })}
              />
            </Button>
          ))}
        </div>

        {/* Embedded (Kişiler tab): the header is the host's, so Export CSV and
            Yeni Lead move into this row — the actions must never be lost. */}
        {embedded && actions}
      </div>

      {/* Filter bar */}
      <FilterBar
        search={{
          value: search,
          onChange: (v) => { setSearch(v); setPage(1); },
          placeholder: t('leads.searchPlaceholder'),
        }}
      >
        {/* Status */}
        <Select
          value={status || '__all__'}
          onValueChange={(v) => { setStatus(v === '__all__' ? '' : v); setPage(1); }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t('leads.filterStatus')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('leads.filterStatus')}</SelectItem>
            {Object.values(LeadStatus).map((s) => (
              <SelectItem key={s} value={s}>
                {t(`leadStatus.${s}`, { defaultValue: LEAD_STATUS_LABELS[s] })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Assignment status — stays visible: it's the target of the dashboard's
            unassigned deep-links (?assignmentStatus=unassigned). */}
        <Select
          value={assignmentStatus || '__all__'}
          onValueChange={(v) => {
            setAssignmentStatus((v === '__all__' ? '' : v) as AssignmentStatus);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t('leads.assignmentStatus.all')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('leads.assignmentStatus.all')}</SelectItem>
            <SelectItem value="unassigned">{t('leads.assignmentStatus.unassigned')}</SelectItem>
            <SelectItem value="assigned">{t('leads.assignmentStatus.assigned')}</SelectItem>
            <SelectItem value="mine">{t('leads.assignmentStatus.mine')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Power filters (Source / Business type) collapse behind "More filters"
            (2026-07 trim) so the daily bar stays lean; the badge keeps active
            hidden filters discoverable. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="md">
              <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
              {t('leads.moreFilters', { defaultValue: 'More filters' })}
              {(source || businessType) && (
                <Badge tone="primary">{[source, businessType].filter(Boolean).length}</Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3">
            {/* Source */}
            <Select
              value={source || '__all__'}
              onValueChange={(v) => { setSource(v === '__all__' ? '' : v); setPage(1); }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('leads.filterSource')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('leads.filterSource')}</SelectItem>
                {Object.values(LeadSource).map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`source.${s}`, { defaultValue: LEAD_SOURCE_LABELS[s] })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Business type */}
            <Select
              value={businessType || '__all__'}
              onValueChange={(v) => { setBusinessType(v === '__all__' ? '' : v); setPage(1); }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('leads.filterBusinessType')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('leads.filterBusinessType')}</SelectItem>
                {Object.values(BusinessType).map((b) => (
                  <SelectItem key={b} value={b}>
                    {t(`businessType.${b}`, { defaultValue: BUSINESS_TYPE_LABELS[b] })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PopoverContent>
        </Popover>
      </FilterBar>

      {/* Bulk action toolbar — sticky once selection exists (manager only) */}
      {isManager && (
        <BulkActionToolbar
          selectedCount={selected.size}
          reps={reps}
          onBulkAssign={(repId) => bulkAssign.mutate(repId)}
          onClear={() => setSelected(new Set())}
          pending={bulkAssign.isPending || bulkDelete.isPending || bulkEnroll.isPending}
          onBulkDelete={() => setBulkDeleteConfirmOpen(true)}
          workflows={workflows}
          onEnroll={(workflowId) => bulkEnroll.mutate(workflowId)}
        />
      )}

      {/* Error state */}
      <QueryStateBoundary
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('leads.loadFailed', 'Could not load leads.')}
        retryLabel={t('common.retry', 'Retry')}
      />

      {/* DataTable */}
      {!isError && (
        <DataTable<Lead>
          columns={tableColumns as import('@tanstack/react-table').ColumnDef<Lead, unknown>[]}
          data={leads}
          isLoading={isLoading}
          loadingRowCount={8}
          sorting={sorting}
          onSortingChange={(s) => {
            setSorting(s);
            setPage(1); // a new sort order is a new first page
          }}
          onRowClick={(lead) => navigate(`/leads/${lead.id}`)}
          emptyState={
            <EmptyState
              title={t('leads.emptyTitle', 'No leads')}
              description={emptyDescription}
              action={
                <Button asChild size="sm">
                  <Link to="/leads/new">
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    {t('leads.createButton')}
                  </Link>
                </Button>
              }
            />
          }
        />
      )}

      {/* Pagination */}
      {data && data.meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {(data.meta.page - 1) * data.meta.limit + 1}–
            {Math.min(data.meta.page * data.meta.limit, data.meta.total)}{' '}
            / {data.meta.total}
          </p>
          <Pagination
            page={page}
            pageCount={data.meta.totalPages}
            onPage={setPage}
          />
        </div>
      )}

      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        onOpenChange={setBulkDeleteConfirmOpen}
        tone="danger"
        title={t('leads.bulkDelete.title', { defaultValue: 'Delete the selected leads?' })}
        description={t('leads.bulkDelete.desc', {
          defaultValue: '{{count}} lead(s) and their timelines are removed from your workspace. This cannot be undone.',
          count: selected.size,
        })}
        confirmLabel={t('leads.bulkDelete.button', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        loading={bulkDelete.isPending}
        onConfirm={() => {
          setBulkDeleteConfirmOpen(false);
          bulkDelete.mutate();
        }}
      />
    </div>
  );
}
