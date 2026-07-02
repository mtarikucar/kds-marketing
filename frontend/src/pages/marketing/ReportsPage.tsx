import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarChart3, MapPin, TrendingUp, Users } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import {
  PageHeader,
  Card,
  CardContent,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Badge,
  Progress,
  Skeleton,
  EmptyState,
} from '../../components/ui';

// ─── helpers ─────────────────────────────────────────────────────────────────

function attainmentTone(pct: number): 'success' | 'warning' | 'danger' {
  if (pct >= 100) return 'success';
  if (pct >= 70) return 'warning';
  return 'danger';
}

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <TBody>
      {Array.from({ length: rows }).map((_, i) => (
        <TR key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TD key={j}>
              <Skeleton className="h-4 w-full" />
            </TD>
          ))}
        </TR>
      ))}
    </TBody>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const [tab, setTab] = useState<'sources' | 'regional' | 'conversion' | 'performance'>('sources');

  const { data: sources, isLoading: loadingSources } = useQuery({
    queryKey: ['marketing', 'reports', 'sources'],
    queryFn: () => marketingApi.get('/reports/lead-sources').then((r) => r.data),
    enabled: tab === 'sources',
  });

  const { data: regional, isLoading: loadingRegional } = useQuery({
    queryKey: ['marketing', 'reports', 'regional'],
    queryFn: () => marketingApi.get('/reports/regional').then((r) => r.data),
    enabled: tab === 'regional',
  });

  const { data: conversion, isLoading: loadingConversion } = useQuery({
    queryKey: ['marketing', 'reports', 'conversion'],
    queryFn: () => marketingApi.get('/reports/conversion').then((r) => r.data),
    enabled: tab === 'conversion',
  });

  const { data: performance, isLoading: loadingPerformance } = useQuery({
    queryKey: ['marketing', 'reports', 'performance'],
    queryFn: () => marketingApi.get('/reports/performance').then((r) => r.data),
    enabled: tab === 'performance' && isManager,
  });

  const tabs = [
    { id: 'sources', labelKey: 'reports.tabs.sources', icon: BarChart3 },
    { id: 'regional', labelKey: 'reports.tabs.regional', icon: MapPin },
    { id: 'conversion', labelKey: 'reports.tabs.conversion', icon: TrendingUp },
    ...(isManager ? [{ id: 'performance', labelKey: 'reports.tabs.performance', icon: Users }] : []),
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader title={t('reports.title')} description={t('reports.subtitle')} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          {tabs.map((tt) => (
            <TabsTrigger key={tt.id} value={tt.id} className="flex items-center gap-1.5">
              <tt.icon className="h-4 w-4" aria-hidden="true" />
              {t(tt.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── Lead Sources ── */}
        <TabsContent value="sources">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table className="min-w-[560px]">
                <THead>
                  <TR>
                    <TH>{t('reports.col.source')}</TH>
                    <TH numeric>{t('reports.col.total')}</TH>
                    <TH numeric>{t('reports.col.won')}</TH>
                    <TH numeric>{t('reports.col.lost')}</TH>
                    <TH>{t('reports.col.conversionRate')}</TH>
                  </TR>
                </THead>
                {loadingSources ? (
                  <TableSkeleton cols={5} />
                ) : (sources?.length ?? 0) === 0 ? null : (
                  <TBody>
                    {sources.map((s: any) => (
                      <TR key={s.source}>
                        <TD className="font-medium text-foreground">{s.source}</TD>
                        <TD numeric>{s.total}</TD>
                        <TD numeric>
                          <Badge tone="success">{s.won}</Badge>
                        </TD>
                        <TD numeric>
                          <Badge tone="danger">{s.lost}</Badge>
                        </TD>
                        <TD>
                          <div className="flex items-center gap-2">
                            <Progress
                              value={Math.min(s.conversionRate, 100)}
                              tone={attainmentTone(s.conversionRate)}
                              className="w-16 h-2"
                            />
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {s.conversionRate}%
                            </span>
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                )}
              </Table>
              {!loadingSources && (sources?.length ?? 0) === 0 && (
                <EmptyState
                  icon={<BarChart3 className="h-10 w-10" />}
                  title={t('reports.empty.sourcesTitle')}
                  description={t('reports.empty.sourcesDesc')}
                  className="m-4"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Regional ── */}
        <TabsContent value="regional">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table className="min-w-[400px]">
                <THead>
                  <TR>
                    <TH>{t('reports.col.city')}</TH>
                    <TH numeric>{t('reports.col.totalLeads')}</TH>
                    <TH numeric>{t('reports.col.won')}</TH>
                  </TR>
                </THead>
                {loadingRegional ? (
                  <TableSkeleton cols={3} />
                ) : (regional?.length ?? 0) === 0 ? null : (
                  <TBody>
                    {regional.map((r: any) => (
                      <TR key={r.city}>
                        <TD className="font-medium text-foreground">{r.city}</TD>
                        <TD numeric>{r.total}</TD>
                        <TD numeric>
                          <Badge tone="success">{r.won}</Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                )}
              </Table>
              {!loadingRegional && (regional?.length ?? 0) === 0 && (
                <EmptyState
                  icon={<MapPin className="h-10 w-10" />}
                  title={t('reports.empty.regionalTitle')}
                  description={t('reports.empty.regionalDesc')}
                  className="m-4"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Conversion Funnel ── */}
        <TabsContent value="conversion">
          <Card>
            <CardContent className="space-y-4">
              <h3 className="font-display text-h3 text-foreground">{t('reports.funnelTitle')}</h3>
              {loadingConversion ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (conversion?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<TrendingUp className="h-10 w-10" />}
                  title={t('reports.empty.funnelTitle')}
                  description={t('reports.empty.funnelDesc')}
                />
              ) : (
                <div className="space-y-3">
                  {conversion.map((item: any) => {
                    const maxCount = conversion[0]?.count || 1;
                    const widthPercent = (item.count / maxCount) * 100;
                    return (
                      <div key={item.status} className="flex items-center gap-4">
                        <span className="w-36 text-sm text-muted-foreground text-end shrink-0">
                          {item.status.replace(/_/g, ' ')}
                        </span>
                        <div className="flex-1">
                          <div className="h-8 rounded-lg overflow-hidden bg-surface-muted">
                            <div
                              className="h-full bg-primary rounded-lg flex items-center px-3 transition-all"
                              style={{ width: `${Math.max(widthPercent, 2)}%` }}
                            >
                              <span className="text-xs text-primary-foreground font-medium tabular-nums">
                                {item.count}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Performance (Manager only) ── */}
        {isManager && (
          <TabsContent value="performance">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table className="min-w-[760px]">
                  <THead>
                    <TR>
                      <TH>{t('reports.col.rep')}</TH>
                      <TH numeric>{t('reports.col.leads')}</TH>
                      <TH numeric>{t('reports.col.won')}</TH>
                      <TH numeric>{t('reports.col.lost')}</TH>
                      <TH numeric>{t('reports.col.activities')}</TH>
                      <TH numeric>{t('reports.col.demos')}</TH>
                      <TH numeric>{t('reports.col.meetings')}</TH>
                      <TH numeric>{t('reports.col.conversion')}</TH>
                    </TR>
                  </THead>
                  {loadingPerformance ? (
                    <TableSkeleton cols={8} />
                  ) : (performance?.length ?? 0) === 0 ? null : (
                    <TBody>
                      {performance.map((p: any) => (
                        <TR key={p.rep.id}>
                          <TD className="font-medium text-foreground">{p.rep.name}</TD>
                          <TD numeric>{p.totalLeads}</TD>
                          <TD numeric>
                            <Badge tone="success">{p.wonLeads}</Badge>
                          </TD>
                          <TD numeric>
                            <Badge tone="danger">{p.lostLeads}</Badge>
                          </TD>
                          <TD numeric>{p.activities}</TD>
                          <TD numeric>{p.demos}</TD>
                          <TD numeric>{p.meetings}</TD>
                          <TD numeric>
                            <span className="tabular-nums">{p.conversionRate}%</span>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  )}
                </Table>
                {!loadingPerformance && (performance?.length ?? 0) === 0 && (
                  <EmptyState
                    icon={<Users className="h-10 w-10" />}
                    title={t('reports.empty.perfTitle')}
                    description={t('reports.empty.perfDesc')}
                    className="m-4"
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
