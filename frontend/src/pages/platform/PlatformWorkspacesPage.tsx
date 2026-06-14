import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  SUSPENDED: 'bg-amber-50 text-amber-700 border-amber-200',
  CLOSED: 'bg-slate-100 text-slate-500 border-slate-200',
};

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  productName: string;
  defaultCurrency: string;
  createdAt: string;
  counts: { users: number; leads: number };
}

export default function PlatformWorkspacesPage() {
  const { isAuthenticated, operator, logout } = usePlatformAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const { data: workspaces, isLoading } = useQuery<WorkspaceRow[]>({
    queryKey: ['platform', 'workspaces', { search, status }],
    queryFn: () =>
      platformApi
        .get('/workspaces', { params: { search: search || undefined, status: status || undefined } })
        .then((r) => r.data),
    // Don't fetch until authenticated — preserves the original
    // no-request-before-redirect behavior now that the guard sits below.
    enabled: isAuthenticated,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      platformApi.patch(`/workspaces/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'workspaces'] });
      toast.success('Workspace status updated');
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Update failed'),
  });

  // Guard AFTER all hooks (Rules of Hooks).
  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center font-bold">P</div>
            <h1 className="font-semibold">Platform Console</h1>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <button
              onClick={() => navigate('/platform/payments')}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Payments
            </button>
            <button
              onClick={() => navigate('/platform/routines')}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Routines
            </button>
            <span className="text-slate-300">{operator?.email}</span>
            <button
              onClick={() => logout()}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-xl font-bold text-slate-900">Workspaces</h2>
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name / slug / product…"
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-64 outline-none focus:ring-2 focus:ring-slate-900"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none"
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Workspace</th>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Users</th>
                <th className="px-4 py-3 font-medium">Leads</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!isLoading && (workspaces?.length ?? 0) === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No workspaces</td></tr>
              )}
              {workspaces?.map((w) => (
                <tr
                  key={w.id}
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => navigate(`/platform/workspaces/${w.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{w.name}</div>
                    <div className="text-xs text-slate-400">{w.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{w.productName}</td>
                  <td className="px-4 py-3 text-slate-600">{w.counts.users}</td>
                  <td className="px-4 py-3 text-slate-600">{w.counts.leads}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-medium ${STATUS_BADGE[w.status] ?? ''}`}>
                      {w.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {w.status === 'ACTIVE' ? (
                      <button
                        onClick={() => {
                          if (!window.confirm(`Suspend workspace "${w.name}"? Users will lose access until it is reactivated.`)) return;
                          statusMutation.mutate({ id: w.id, status: 'SUSPENDED' });
                        }}
                        disabled={statusMutation.isPending}
                        className="px-2.5 py-1 text-xs rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    ) : w.status === 'SUSPENDED' ? (
                      <button
                        onClick={() => {
                          if (!window.confirm(`Activate workspace "${w.name}"? Users will regain access immediately.`)) return;
                          statusMutation.mutate({ id: w.id, status: 'ACTIVE' });
                        }}
                        disabled={statusMutation.isPending}
                        className="px-2.5 py-1 text-xs rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                      >
                        Activate
                      </button>
                    ) : null}
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
