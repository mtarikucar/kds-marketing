import { useQuery } from '@tanstack/react-query';
import { useParams, Navigate, Link } from 'react-router-dom';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';

export default function PlatformWorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = usePlatformAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/platform/login" replace />;
  }

  const { data: ws, isLoading } = useQuery({
    queryKey: ['platform', 'workspace', id],
    queryFn: () => platformApi.get(`/workspaces/${id}`).then((r) => r.data),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400">Loading…</div>;
  }
  if (!ws) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400">Not found</div>;
  }

  const stat = (label: string, value: React.ReactNode) => (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="text-xs text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold text-slate-900 mt-1">{value}</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link to="/platform/workspaces" className="text-slate-300 hover:text-white text-sm">← Workspaces</Link>
          <h1 className="font-semibold">{ws.name}</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10">{ws.status}</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stat('Users', ws.counts.users)}
          {stat('Leads', ws.counts.leads)}
          {stat('Open leads', ws.counts.openLeads)}
          {stat('Won leads', ws.counts.wonLeads)}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <h2 className="font-semibold text-slate-900">Workspace</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-slate-500">Slug</dt><dd className="text-slate-900 font-mono">{ws.slug}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Product</dt><dd className="text-slate-900">{ws.productName}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">URL</dt><dd className="text-slate-900">{ws.productUrl ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Language / Currency</dt><dd className="text-slate-900">{ws.defaultLanguage} / {ws.defaultCurrency}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Core integration</dt><dd className="text-slate-900">{ws.coreIntegration ? 'Yes' : 'No'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Created</dt><dd className="text-slate-900">{new Date(ws.createdAt).toLocaleDateString()}</dd></div>
            </dl>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <h2 className="font-semibold text-slate-900">Owner</h2>
            {ws.owner ? (
              <dl className="text-sm space-y-2">
                <div className="flex justify-between"><dt className="text-slate-500">Name</dt><dd className="text-slate-900">{ws.owner.firstName} {ws.owner.lastName}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Email</dt><dd className="text-slate-900">{ws.owner.email}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Last login</dt><dd className="text-slate-900">{ws.owner.lastLogin ? new Date(ws.owner.lastLogin).toLocaleString() : '—'}</dd></div>
              </dl>
            ) : (
              <p className="text-sm text-slate-400">No owner account</p>
            )}
          </div>
        </div>

        {ws.productDescription && (
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="font-semibold text-slate-900 mb-2">Product description</h2>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{ws.productDescription}</p>
          </div>
        )}
      </main>
    </div>
  );
}
