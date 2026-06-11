import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  FunnelIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import {
  LeadStatusBadge,
  AssignCell,
  BulkActionToolbar,
  PageHeader,
} from '../../features/marketing/components';
import {
  LeadStatus,
  BusinessType,
  LeadSource,
  LEAD_STATUS_LABELS,
  BUSINESS_TYPE_LABELS,
  LEAD_SOURCE_LABELS,
} from '../../features/marketing/types';
import type {
  Lead,
  MarketingUserInfo,
  PaginatedResponse,
} from '../../features/marketing/types';
import { fmtDate } from '../../features/marketing/utils/format';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

type AssignmentStatus = '' | 'unassigned' | 'assigned' | 'mine';

interface RepRow extends MarketingUserInfo {
  status?: string;
  role?: string;
}

export default function LeadsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
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
  const [showFilters, setShowFilters] = useState(false);
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

  const { data, isLoading } = useQuery({
    queryKey: [
      'marketing',
      'leads',
      { search, status, source, businessType, assignmentStatus, page },
    ],
    queryFn: () =>
      marketingApi
        .get<PaginatedResponse<Lead>>('/leads', {
          params: {
            search: search || undefined,
            status: status || undefined,
            source: source || undefined,
            businessType: businessType || undefined,
            assignmentStatus: assignmentStatus || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
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

  const visibleIds = useMemo(
    () => (data?.data ?? []).map((l) => l.id),
    [data?.data],
  );
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

  const bulkAssign = useMutation({
    mutationFn: (repId: string | null) =>
      marketingApi.post('/leads/bulk-assign', {
        leadIds: Array.from(selected),
        assignedToId: repId ?? null,
      }),
    onSuccess: (res) => {
      const assigned = res.data?.assigned ?? 0;
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
      toast.success(t('leads.bulkAssign.success', { count: assigned }));
      setSelected(new Set());
    },
    onError: () => toast.error(t('leads.bulkAssign.error')),
  });

  // Tri-state header checkbox: indeterminate when partial selection on
  // current page. Browsers don't expose `indeterminate` as a JSX prop,
  // so we set it via ref.
  const headerRef = (node: HTMLInputElement | null) => {
    if (node) node.indeterminate = someChecked;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('leads.title')}
        subtitle={t('leads.subtitle')}
        action={
          <Link
            to="/leads/new"
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            {t('leads.createButton')}
          </Link>
        }
      />

      {/* Search & Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <MagnifyingGlassIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder={t('leads.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm ${
              showFilters
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-gray-300 text-gray-600'
            }`}
          >
            <FunnelIcon className="w-4 h-4" />
            {t('common.filters')}
          </button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3 pt-3 border-t">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">{t('leads.filterStatus')}</option>
              {Object.values(LeadStatus).map((s) => (
                <option key={s} value={s}>
                  {t(`leadStatus.${s}`, { defaultValue: LEAD_STATUS_LABELS[s] })}
                </option>
              ))}
            </select>
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">{t('leads.filterSource')}</option>
              {Object.values(LeadSource).map((s) => (
                <option key={s} value={s}>
                  {t(`source.${s}`, { defaultValue: LEAD_SOURCE_LABELS[s] })}
                </option>
              ))}
            </select>
            <select
              value={businessType}
              onChange={(e) => {
                setBusinessType(e.target.value);
                setPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">{t('leads.filterBusinessType')}</option>
              {Object.values(BusinessType).map((b) => (
                <option key={b} value={b}>
                  {t(`businessType.${b}`, { defaultValue: BUSINESS_TYPE_LABELS[b] })}
                </option>
              ))}
            </select>
            <select
              value={assignmentStatus}
              onChange={(e) => {
                setAssignmentStatus(e.target.value as AssignmentStatus);
                setPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">{t('leads.assignmentStatus.all')}</option>
              <option value="unassigned">{t('leads.assignmentStatus.unassigned')}</option>
              <option value="assigned">{t('leads.assignmentStatus.assigned')}</option>
              <option value="mine">{t('leads.assignmentStatus.mine')}</option>
            </select>
          </div>
        )}
      </div>

      {/* Bulk action toolbar — sticky once selection exists */}
      {isManager && (
        <BulkActionToolbar
          selectedCount={selected.size}
          reps={reps}
          onBulkAssign={(repId) => bulkAssign.mutate(repId)}
          onClear={() => setSelected(new Set())}
          pending={bulkAssign.isPending}
        />
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                {isManager && (
                  <th className="px-3 py-3 w-8">
                    <input
                      ref={headerRef}
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => toggleAll(e.target.checked)}
                      className="rounded border-gray-300 text-primary focus:ring-primary"
                    />
                  </th>
                )}
                <th className="px-4 py-3 font-medium">{t('leads.table.business')}</th>
                <th className="px-4 py-3 font-medium">{t('leads.table.contact')}</th>
                <th className="px-4 py-3 font-medium">{t('leads.table.status')}</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">
                  {t('leads.table.source')}
                </th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">
                  {t('leads.table.city')}
                </th>
                {/* Owner column visible from sm: up. Lead assignment is
                    the primary manager workflow — keep it reachable on
                    phones, not just tablets. */}
                <th className="px-4 py-3 font-medium hidden sm:table-cell">
                  {t('leads.table.assignedTo')}
                </th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">
                  {t('leads.table.createdAt')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td
                    colSpan={isManager ? 8 : 7}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    {t('common.loading')}
                  </td>
                </tr>
              ) : data?.data.length === 0 ? (
                <tr>
                  <td
                    colSpan={isManager ? 8 : 7}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    {assignmentStatus === 'unassigned'
                      ? t('leads.emptyUnassigned', 'Atanmamış lead yok — hepsi takipte.')
                      : isManager
                      ? t(
                          'leads.emptyManager',
                          'Henüz lead yok. Sağ üstteki "Yeni Lead" ile ekleyin veya AI Research routine tarafından oluşturulmasını bekleyin.',
                        )
                      : t('leads.empty')}
                  </td>
                </tr>
              ) : (
                data?.data.map((lead) => (
                  <tr key={lead.id} className="hover:bg-gray-50">
                    {isManager && (
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(lead.id)}
                          onChange={(e) => toggleOne(lead.id, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border-gray-300 text-primary focus:ring-primary"
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Link
                        to={`/leads/${lead.id}`}
                        className="font-medium text-primary hover:text-primary/80"
                      >
                        {lead.businessName}
                      </Link>
                      <p className="text-xs text-gray-400">
                        {t(`businessType.${lead.businessType}`, {
                          defaultValue:
                            BUSINESS_TYPE_LABELS[lead.businessType as BusinessType] ||
                            lead.businessType,
                        })}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-900">{lead.contactPerson}</p>
                      <p className="text-xs text-gray-400">{lead.phone}</p>
                    </td>
                    <td className="px-4 py-3">
                      <LeadStatusBadge status={lead.status} />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600">
                      {t(`source.${lead.source}`, {
                        defaultValue:
                          LEAD_SOURCE_LABELS[lead.source as LeadSource] || lead.source,
                      })}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600">
                      {lead.city || '-'}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <AssignCell
                        leadId={lead.id}
                        currentAssignee={lead.assignedTo ?? null}
                        readOnly={!isManager}
                      />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-400 text-xs">
                      {fmtDate(lead.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">
              {(data.meta.page - 1) * data.meta.limit + 1}–
              {Math.min(data.meta.page * data.meta.limit, data.meta.total)} /{' '}
              {data.meta.total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                {t('common.previous')}
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= data.meta.totalPages}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                {t('common.next')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
