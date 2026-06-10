import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { TARGET_METRICS, TARGET_METRIC_LABELS } from '../../features/marketing/types';
import type {
  MetricPerformance,
  TeamPerformanceRow,
  MarketingUserInfo,
} from '../../features/marketing/types';

interface RepRow extends MarketingUserInfo {
  role: string;
}

const currentPeriod = () => new Date().toISOString().slice(0, 7);
const metricLabel = (m: string) =>
  TARGET_METRIC_LABELS[m as keyof typeof TARGET_METRIC_LABELS] || m;

function fmtValue(metric: string, v: number | null | undefined): string {
  if (v == null) return '—';
  if (metric === 'COMMISSION_AMOUNT') return `$${Number(v).toFixed(2)}`;
  return String(v);
}

function attainColor(pct: number | null): string {
  if (pct == null) return 'bg-slate-300';
  if (pct >= 100) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-red-500';
}

function MetricCard({ m }: { m: MetricPerformance }) {
  const pct = m.attainmentPct;
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-2">
      <p className="text-sm text-gray-500">{metricLabel(m.metric)}</p>
      <p className="text-2xl font-bold text-gray-900">
        {fmtValue(m.metric, m.actual)}
        <span className="text-sm font-normal text-gray-400"> / {fmtValue(m.metric, m.target)}</span>
      </p>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${attainColor(pct)}`} style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
      </div>
      <p className="text-xs text-gray-400">{pct != null ? `${pct}% of target` : 'No target set'}</p>
    </div>
  );
}

export default function PerformancePage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'SALES_MANAGER';

  const [period, setPeriod] = useState(currentPeriod());
  const [repId, setRepId] = useState('');

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });

  const { data, isLoading } = useQuery<MetricPerformance[] | TeamPerformanceRow[]>({
    queryKey: ['marketing', 'performance', { period, repId }],
    queryFn: () =>
      marketingApi
        .get('/performance', { params: { period, marketingUserId: repId || undefined } })
        .then((r) => r.data),
  });

  // Manager with no rep selected → the backend returns a team array.
  const isTeam = isManager && !repId;
  const team = (isTeam ? (data as TeamPerformanceRow[]) : []) || [];
  const metrics = (!isTeam ? (data as MetricPerformance[]) : []) || [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Performance</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Period</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        {isManager && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Rep</label>
            <select
              value={repId}
              onChange={(e) => setRepId(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">Whole team</option>
              {reps.filter((r) => r.role === 'SALES_REP').map((r) => (
                <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">Loading…</div>
      ) : isTeam ? (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Rep</th>
                  {TARGET_METRICS.map((m) => <th key={m} className="px-4 py-3 font-medium">{metricLabel(m)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {team.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">No reps</td></tr>
                ) : (
                  team.map((row) => (
                    <tr key={row.marketingUser.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{row.marketingUser.firstName} {row.marketingUser.lastName}</td>
                      {TARGET_METRICS.map((mk) => {
                        const m = row.metrics.find((x) => x.metric === mk);
                        const pct = m?.attainmentPct ?? null;
                        return (
                          <td key={mk} className="px-4 py-3">
                            <span className="text-gray-700">
                              {fmtValue(mk, m?.actual ?? 0)}
                              {m?.target != null && <span className="text-gray-400"> / {fmtValue(mk, m.target)}</span>}
                            </span>
                            {pct != null && (
                              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mt-1 w-24">
                                <div className={`h-full ${attainColor(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {metrics.length === 0 ? (
            <div className="sm:col-span-3 bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">No performance data</div>
          ) : (
            metrics.map((m) => <MetricCard key={m.metric} m={m} />)
          )}
        </div>
      )}
    </div>
  );
}
