import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Download } from 'lucide-react';

import {
  listLeads,
  bulkAssignLeads,
  bulkDeleteLeads,
  bulkEnrollLeads,
  exportLeadsCsv,
} from '../../../features/marketing/api/leads.service';
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
  Card,
  CardContent,
} from '@/components/ui';

import { buildLeadsColumns } from './leadsColumns';

type AssignmentStatus = '' | 'unassigned' | 'assigned' | 'mine';

interface RepRow extends MarketingUserInfo {
  status?: string;
  role?: string;
}

const LIMIT = 20;

/**
 * Leads list page — Console design system migration.
 *
 * Behavior (query keys, URL params, mutations, invalidations, pagination,
 * row navigation, bulk-assign) is preserved verbatim from the original
 * LeadsPage.tsx. Presentation is migrated to Console primitives.
 */
export default function LeadsPage() {
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
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Sync URL when assignmentStatus changes so deep-links stay current.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (assignmentStatus) next.set('assignmentStatus', assignmentStatus);
    else next.delete('assignmentStatus');
    // Only update if changed to avoid a render loop with React Router.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentStatus]);

  // Preserve verbatim query key: ['marketing','leads',{ search, status, source, businessType, assignmentStatus, page }]
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [
      'marketing',
      'leads',
      { search, status, source, businessType, assignmentStatus, page },
    ],
    queryFn: () =>
      listLeads({
        search: search || undefined,
        status: status || undefined,
        source: source || undefined,
        businessType: businessType || undefined,
        assignmentStatus: assignmentStatus || undefined,
        page,
        limit: LIMIT,
      }),
  });

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
  }, [page, search, status, source, businessType, assignmentStatus]);

  // Bulk assign mutation — preserved verbatim (keys + invalidations).
  const bulkAssign = useMutation({
    mutationFn: (repId: string | null) =>
      bulkAssignLeads(Array.from(selected), repId ?? null),
    onSuccess: (res) => {
      const assigned = res?.assigned ?? 0;
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
      toast.success(t('leads.bulkAssign.success', { count: assigned }));
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
      toast.success(t('leads.bulkDelete.success', { defaultValue: '{{count}} lead(s) deleted', count: res?.deleted ?? 0 }));
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
      exportLeadsCsv({ search, status, source, businessType, assignmentStatus }),
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

  return (
    <div className="space-y-4">
      {/* Page header */}
      <PageHeader
        title={t('leads.title')}
        description={t('leads.subtitle')}
        actions={
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
        }
      />

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

        {/* Source */}
        <Select
          value={source || '__all__'}
          onValueChange={(v) => { setSource(v === '__all__' ? '' : v); setPage(1); }}
        >
          <SelectTrigger className="w-44">
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
          <SelectTrigger className="w-44">
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

        {/* Assignment status */}
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
      </FilterBar>

      {/* Bulk action toolbar — sticky once selection exists (manager only) */}
      {isManager && (
        <BulkActionToolbar
          selectedCount={selected.size}
          reps={reps}
          onBulkAssign={(repId) => bulkAssign.mutate(repId)}
          onClear={() => setSelected(new Set())}
          pending={bulkAssign.isPending || bulkDelete.isPending || bulkEnroll.isPending}
          onBulkDelete={() => {
            if (window.confirm(t('leads.bulkDelete.confirm', { defaultValue: 'Delete the selected leads?' }))) {
              bulkDelete.mutate();
            }
          }}
          workflows={workflows}
          onEnroll={(workflowId) => bulkEnroll.mutate(workflowId)}
        />
      )}

      {/* Error state */}
      {isError && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-danger">
              {t('leads.loadFailed', 'Could not load leads.')}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* DataTable */}
      {!isError && (
        <DataTable<Lead>
          columns={tableColumns as import('@tanstack/react-table').ColumnDef<Lead, unknown>[]}
          data={leads}
          isLoading={isLoading}
          loadingRowCount={8}
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
    </div>
  );
}
