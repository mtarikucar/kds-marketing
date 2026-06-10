import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';

/**
 * Manual bank-transfer queue: orders sit in AWAITING_TRANSFER until the
 * operator matches the incoming wire by its MKT-… reference and approves —
 * approval rides the same idempotent settlement path the PSP webhooks use.
 */
export default function ManualPaymentsPage() {
  const { isAuthenticated } = usePlatformAuthStore();
  const queryClient = useQueryClient();

  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  const { data: orders, isLoading } = useQuery({
    queryKey: ['platform', 'payments', 'awaiting'],
    queryFn: () => platformApi.get('/payments').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const approve = useMutation({
    mutationFn: (orderId: string) => platformApi.post(`/payments/${orderId}/approve`),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'payments'] });
      if (data.settled) toast.success('Payment approved — package activated');
      else toast.warning(`Not settled: ${data.reason}`);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Approve failed'),
  });

  const reject = useMutation({
    mutationFn: (orderId: string) =>
      platformApi.post(`/payments/${orderId}/reject`, { reason: 'no matching transfer' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'payments'] });
      toast.success('Order rejected');
    },
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link to="/platform/workspaces" className="text-slate-300 hover:text-white text-sm">← Workspaces</Link>
          <h1 className="font-semibold">Manual payments</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Workspace</th>
                <th className="px-4 py-3 font-medium">Item</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Requested</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!isLoading && (orders?.length ?? 0) === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No transfers waiting</td></tr>
              )}
              {orders?.map((o: any) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs">{o.providerRef}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{o.workspace?.name ?? o.workspaceId}</div>
                    <div className="text-xs text-slate-400">{o.workspace?.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {o.package ? `${o.package.name} (${o.billingCycle})` : o.addOnCode}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {Number(o.amount).toLocaleString()} {o.currency}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {new Date(o.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => approve.mutate(o.id)}
                      disabled={approve.isPending}
                      className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => reject.mutate(o.id)}
                      disabled={reject.isPending}
                      className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
