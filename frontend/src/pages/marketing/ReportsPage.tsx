import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

export default function ReportsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const [tab, setTab] = useState<'sources' | 'regional' | 'conversion' | 'performance'>('sources');

  const { data: sources } = useQuery({
    queryKey: ['marketing', 'reports', 'sources'],
    queryFn: () => marketingApi.get('/reports/lead-sources').then((r) => r.data),
    enabled: tab === 'sources',
  });

  const { data: regional } = useQuery({
    queryKey: ['marketing', 'reports', 'regional'],
    queryFn: () => marketingApi.get('/reports/regional').then((r) => r.data),
    enabled: tab === 'regional',
  });

  const { data: conversion } = useQuery({
    queryKey: ['marketing', 'reports', 'conversion'],
    queryFn: () => marketingApi.get('/reports/conversion').then((r) => r.data),
    enabled: tab === 'conversion',
  });

  const { data: performance } = useQuery({
    queryKey: ['marketing', 'reports', 'performance'],
    queryFn: () => marketingApi.get('/reports/performance').then((r) => r.data),
    enabled: tab === 'performance' && isManager,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Reports</h1>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {(['sources', 'regional', 'conversion', ...(isManager ? ['performance'] : [])] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as any)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize ${
              tab === t ? 'bg-primary/15 text-primary' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t === 'sources' ? 'Lead Sources' : t}
          </button>
        ))}
      </div>

      {/* Lead Sources */}
      {tab === 'sources' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Won</th>
                <th className="px-4 py-3 font-medium">Lost</th>
                <th className="px-4 py-3 font-medium">Conversion Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sources?.map((s: any) => (
                <tr key={s.source} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{s.source}</td>
                  <td className="px-4 py-3">{s.total}</td>
                  <td className="px-4 py-3 text-green-600">{s.won}</td>
                  <td className="px-4 py-3 text-red-600">{s.lost}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-gray-200 rounded-full">
                        <div className="h-2 bg-primary/100 rounded-full" style={{ width: `${Math.min(s.conversionRate, 100)}%` }} />
                      </div>
                      <span className="text-xs">{s.conversionRate}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Regional */}
      {tab === 'regional' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">City</th>
                <th className="px-4 py-3 font-medium">Total Leads</th>
                <th className="px-4 py-3 font-medium">Won</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {regional?.map((r: any) => (
                <tr key={r.city} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{r.city}</td>
                  <td className="px-4 py-3">{r.total}</td>
                  <td className="px-4 py-3 text-green-600">{r.won}</td>
                </tr>
              ))}
              {regional?.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-500">No data</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Conversion Funnel */}
      {tab === 'conversion' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Conversion Funnel</h3>
          <div className="space-y-3">
            {conversion?.map((item: any, idx: number) => {
              const maxCount = conversion[0]?.count || 1;
              const widthPercent = (item.count / maxCount) * 100;
              return (
                <div key={item.status} className="flex items-center gap-4">
                  <span className="w-32 text-sm text-gray-600 text-right">{item.status.replace(/_/g, ' ')}</span>
                  <div className="flex-1">
                    <div className="h-8 bg-gray-100 rounded-lg overflow-hidden">
                      <div
                        className="h-full bg-primary/100 rounded-lg flex items-center px-3"
                        style={{ width: `${Math.max(widthPercent, 2)}%` }}
                      >
                        <span className="text-xs text-white font-medium">{item.count}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Performance (Manager only) */}
      {tab === 'performance' && isManager && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Rep</th>
                <th className="px-4 py-3 font-medium">Leads</th>
                <th className="px-4 py-3 font-medium">Won</th>
                <th className="px-4 py-3 font-medium">Lost</th>
                <th className="px-4 py-3 font-medium">Activities</th>
                <th className="px-4 py-3 font-medium">Demos</th>
                <th className="px-4 py-3 font-medium">Meetings</th>
                <th className="px-4 py-3 font-medium">Conversion</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {performance?.map((p: any) => (
                <tr key={p.rep.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{p.rep.name}</td>
                  <td className="px-4 py-3">{p.totalLeads}</td>
                  <td className="px-4 py-3 text-green-600">{p.wonLeads}</td>
                  <td className="px-4 py-3 text-red-600">{p.lostLeads}</td>
                  <td className="px-4 py-3">{p.activities}</td>
                  <td className="px-4 py-3">{p.demos}</td>
                  <td className="px-4 py-3">{p.meetings}</td>
                  <td className="px-4 py-3">{p.conversionRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
