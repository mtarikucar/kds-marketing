import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { ClickToDialButton } from '../../features/marketing/components';
import { CallStatus, CALL_STATUS_LABELS } from '../../features/marketing/types';
import type { SalesCall, PaginatedResponse, MarketingUserInfo } from '../../features/marketing/types';
import { CALL_STATUS_BADGE } from '../../features/marketing/constants';
import { fmtDateTime, fmtDuration } from '../../features/marketing/utils/format';

interface RepRow extends MarketingUserInfo {
  role: string;
}

const CALL_STATUSES = Object.values(CallStatus);

export default function CallsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'SALES_MANAGER';

  const [status, setStatus] = useState('');
  const [repId, setRepId] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<PaginatedResponse<SalesCall>>({
    queryKey: ['marketing', 'calls', { status, repId, page }],
    queryFn: () =>
      marketingApi
        .get('/calls', {
          params: {
            status: status || undefined,
            marketingUserId: repId || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
  });

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });
  const repName = (id: string) => {
    const r = reps.find((x) => x.id === id);
    return r ? `${r.firstName} ${r.lastName}` : '—';
  };

  const meta = data?.meta;
  const cols = isManager ? 6 : 5;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">Sales Calls</h1>
        <ClickToDialButton />
      </div>
      <p className="text-xs text-gray-400">
        Single company line — one active call at a time. Your softphone opens via the tel: link; log the
        outcome when the call ends.
      </p>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3 flex-wrap">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All statuses</option>
          {CALL_STATUSES.map((s) => <option key={s} value={s}>{CALL_STATUS_LABELS[s]}</option>)}
        </select>
        {isManager && (
          <select
            value={repId}
            onChange={(e) => { setRepId(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="">All reps</option>
            {reps.filter((r) => r.role === 'SALES_REP').map((r) => (
              <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
            ))}
          </select>
        )}
        {(status || repId) && (
          <button onClick={() => { setStatus(''); setRepId(''); setPage(1); }} className="text-xs text-primary hover:underline">Clear</button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">To</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Duration</th>
                {isManager && <th className="px-4 py-3 font-medium hidden md:table-cell">Rep</th>}
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Started</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr><td colSpan={cols} className="px-4 py-8 text-center text-gray-500">Loading…</td></tr>
              ) : (data?.data || []).length === 0 ? (
                <tr><td colSpan={cols} className="px-4 py-8 text-center text-gray-500">No calls yet</td></tr>
              ) : (
                data!.data.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{c.toPhone}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${CALL_STATUS_BADGE[c.status] || 'bg-gray-100'}`}>
                        {CALL_STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-600">{fmtDuration(c.durationSec)}</td>
                    {isManager && <td className="px-4 py-3 hidden md:table-cell text-gray-600">{repName(c.marketingUserId)}</td>}
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-400 text-xs">{fmtDateTime(c.startedAt)}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-500 text-xs max-w-xs truncate">{c.notes || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">{(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} / {meta.total}</p>
            <div className="flex gap-2">
              <button onClick={() => setPage(page - 1)} disabled={page === 1} className="px-3 py-1 border rounded text-sm disabled:opacity-50">Previous</button>
              <button onClick={() => setPage(page + 1)} disabled={page >= meta.totalPages} className="px-3 py-1 border rounded text-sm disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
