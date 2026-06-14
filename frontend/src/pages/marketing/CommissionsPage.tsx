import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import type { Commission } from '../../features/marketing/types';
import { fmtDate } from '../../features/marketing/utils/format';
import { formatMoney, asWorkspaceCurrency } from '../../lib/money';

const statusColors: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  PAID: 'bg-green-100 text-green-800',
};

export default function CommissionsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');

  const {
    data: commissions,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['marketing', 'commissions', { period, status }],
    queryFn: () =>
      marketingApi
        .get('/commissions', {
          params: {
            period: period || undefined,
            status: status || undefined,
          },
        })
        .then((r) => r.data),
  });

  const { data: summary } = useQuery({
    queryKey: ['marketing', 'commissions', 'summary', { period, status }],
    queryFn: () =>
      marketingApi
        .get('/commissions/summary', {
          params: {
            period: period || undefined,
            status: status || undefined,
          },
        })
        .then((r) => r.data),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/commissions/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
      toast.success('Commission approved');
    },
    onError: () => {
      toast.error('Failed to approve commission');
    },
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/commissions/${id}/pay`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
      toast.success('Commission marked as paid');
    },
    onError: () => {
      toast.error('Failed to mark commission as paid');
    },
  });

  const items: Commission[] = commissions?.data || [];
  // Workspace currency drives the money formatting; defaults to TRY when the
  // summary hasn't loaded or returns an unexpected value.
  const currency = asWorkspaceCurrency(summary?.currency);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Commissions</h1>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Period</label>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
            >
              <option value="">All</option>
              <option value="PENDING">PENDING</option>
              <option value="APPROVED">APPROVED</option>
              <option value="PAID">PAID</option>
            </select>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Pending</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">
              {formatMoney(summary.pending.total, currency)}
            </p>
            <p className="text-xs text-gray-400 mt-1">{summary.pending.count} entries</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Approved</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">
              {formatMoney(summary.approved.total, currency)}
            </p>
            <p className="text-xs text-gray-400 mt-1">{summary.approved.count} entries</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Paid</p>
            <p className="text-2xl font-bold text-green-600 mt-1">
              {formatMoney(summary.paid.total, currency)}
            </p>
            <p className="text-xs text-gray-400 mt-1">{summary.paid.count} entries</p>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Rep</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Date</th>
                {isManager && <th className="px-4 py-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={isManager ? 7 : 6} className="px-4 py-8 text-center text-gray-500">Loading...</td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={isManager ? 7 : 6} className="px-4 py-8 text-center">
                    <p className="text-sm text-red-600">Could not load commissions.</p>
                    <button
                      onClick={() => refetch()}
                      className="mt-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                    >
                      Retry
                    </button>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={isManager ? 7 : 6} className="px-4 py-8 text-center text-gray-500">No commissions found</td>
                </tr>
              ) : (
                items.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{c.period}</td>
                    <td className="px-4 py-3 text-gray-600">{c.type}</td>
                    <td className="px-4 py-3 font-medium">{formatMoney(c.amount, currency)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[c.status] || 'bg-gray-100'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-600">
                      {c.marketingUser ? `${c.marketingUser.firstName} ${c.marketingUser.lastName}` : '-'}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-400 text-xs">
                      {fmtDate(c.createdAt)}
                    </td>
                    {isManager && (
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {c.status === 'PENDING' && (
                            <button
                              onClick={() => approveMutation.mutate(c.id)}
                              disabled={approveMutation.isPending}
                              className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100"
                            >
                              Approve
                            </button>
                          )}
                          {c.status === 'APPROVED' && (
                            <button
                              onClick={() => payMutation.mutate(c.id)}
                              disabled={payMutation.isPending}
                              className="px-2 py-1 bg-green-50 text-green-600 rounded text-xs hover:bg-green-100"
                            >
                              Mark Paid
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
