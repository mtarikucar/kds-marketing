import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { TARGET_METRICS, TARGET_METRIC_LABELS } from '../../features/marketing/types';
import type { SalesTarget, MarketingUserInfo } from '../../features/marketing/types';

interface RepRow extends MarketingUserInfo {
  role: string;
}

const currentPeriod = () => new Date().toISOString().slice(0, 7);
const metricLabel = (m: string) =>
  TARGET_METRIC_LABELS[m as keyof typeof TARGET_METRIC_LABELS] || m;

export default function TargetsPage() {
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState(currentPeriod());
  const [repFilter, setRepFilter] = useState('');
  const [form, setForm] = useState({
    marketingUserId: '',
    period: currentPeriod(),
    metric: 'WON_LEADS',
    targetValue: '',
    notes: '',
  });

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    staleTime: 60_000,
  });
  const repOptions = reps.filter((r) => r.role === 'REP');
  const repName = (id: string) => {
    const r = reps.find((x) => x.id === id);
    return r ? `${r.firstName} ${r.lastName}` : id;
  };

  const { data: targets = [], isLoading } = useQuery<SalesTarget[]>({
    queryKey: ['marketing', 'targets', { period, repFilter }],
    queryFn: () =>
      marketingApi
        .get('/targets', { params: { period: period || undefined, marketingUserId: repFilter || undefined } })
        .then((r) => r.data),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'targets'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'performance'] });
  };

  const setTarget = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/targets', payload),
    onSuccess: () => {
      toast.success('Target saved');
      invalidate();
      setForm((f) => ({ ...f, targetValue: '', notes: '' }));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'Failed to save target'),
  });

  const delTarget = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/targets/${id}`),
    onSuccess: () => { toast.success('Target removed'); invalidate(); },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'Failed to remove target'),
  });

  function submit() {
    if (!form.marketingUserId) { toast.error('Select a rep'); return; }
    if (!/^\d{4}-\d{2}$/.test(form.period)) { toast.error('Pick a period'); return; }
    if (form.targetValue === '' || Number(form.targetValue) < 0) { toast.error('Enter a target value'); return; }
    setTarget.mutate({
      marketingUserId: form.marketingUserId,
      period: form.period,
      metric: form.metric,
      targetValue: Number(form.targetValue),
      notes: form.notes || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Sales Targets</h1>

      {/* Set target */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Set a target</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <select value={form.marketingUserId} onChange={(e) => setForm({ ...form, marketingUserId: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="">Rep…</option>
            {repOptions.map((r) => <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>)}
          </select>
          <input type="month" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            {TARGET_METRICS.map((m) => <option key={m} value={m}>{metricLabel(m)}</option>)}
          </select>
          <input type="number" min={0} step="0.01" placeholder="Target value" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <button onClick={submit} disabled={setTarget.isPending} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">{setTarget.isPending ? 'Saving…' : 'Set target'}</button>
        </div>
        <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3 flex-wrap">
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All reps</option>
          {repOptions.map((r) => <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>)}
        </select>
        {(period || repFilter) && <button onClick={() => { setPeriod(''); setRepFilter(''); }} className="text-xs text-primary hover:underline">Clear</button>}
      </div>

      {/* Targets table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-4 py-3 font-medium">Rep</th>
              <th className="px-4 py-3 font-medium">Period</th>
              <th className="px-4 py-3 font-medium">Metric</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium hidden md:table-cell">Notes</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Loading…</td></tr>
            ) : targets.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No targets set</td></tr>
            ) : (
              targets.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{t.marketingUser ? `${t.marketingUser.firstName} ${t.marketingUser.lastName}` : repName(t.marketingUserId)}</td>
                  <td className="px-4 py-3 text-gray-600">{t.period}</td>
                  <td className="px-4 py-3 text-gray-600">{metricLabel(t.metric)}</td>
                  <td className="px-4 py-3 font-medium">{t.metric === 'COMMISSION_AMOUNT' ? `$${Number(t.targetValue).toFixed(2)}` : Number(t.targetValue)}</td>
                  <td className="px-4 py-3 hidden md:table-cell text-gray-500 text-xs">{t.notes || '—'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => { if (window.confirm('Remove this target?')) delTarget.mutate(t.id); }} className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100">Delete</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
