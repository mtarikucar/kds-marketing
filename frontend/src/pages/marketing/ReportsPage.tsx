import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarChart3, MapPin, TrendingUp, Users } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { RouteFallback } from '../../components/RouteFallback';
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

// Lazy so a tab's code only loads when opened (each was its own route before).
const AdReportingPage = lazy(() => import('./ads/AdReportingPage'));
const PerformancePage = lazy(() => import('./PerformancePage'));
const AnalyticsPage = lazy(() => import('./analytics/AnalyticsPage'));

const TABS = ['overview', 'ads', 'performance', 'analytics'] as const;
type ReportsTab = (typeof TABS)[number];

const OVERVIEW_SUBS = ['sources', 'regional', 'conversion', 'performance'] as const;
type OverviewSub = (typeof OVERVIEW_SUBS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

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

// ─── Page (host) ──────────────────────────────────────────────────────────────

/**
 * Reports — the single unified reporting surface. The classic lead reports
 * (overview), ad reporting, target performance and analytics all live here as
 * deep-linkable tabs (`?tab=`, with `?sub=` for the overview's nested reports),
 * so every view survives refresh/back and can be shared.
 */
export default function ReportsPage() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // Analytics is manager-only (mirrors the nav's managerOnly flag): hide the
  // trigger and let a non-manager deep link fall back to the overview.
  const isValidTab = (v: string | null): v is ReportsTab =>
    (TABS as readonly string[]).includes(v ?? '') && (v !== 'analytics' || isManager);
  const tab: ReportsTab = isValidTab(raw) ? raw : 'overview';

  const setTab = (v: string) =>
    setParams((p) => {
      p.set('tab', v);
      p.delete('sub'); // a page-level switch resets the nested selection
      return p;
    }, { replace: true });

  return (
    <div className="space-y-6">
      <PageHeader title={t('reports.title')} description={t('reports.subtitle')} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('reports.tab.overview', 'Overview')}</TabsTrigger>
          <TabsTrigger value="ads">{t('reports.tab.ads', 'Ads')}</TabsTrigger>
          <TabsTrigger value="performance">{t('reports.tab.performance', 'Performance')}</TabsTrigger>
          {isManager && (
            <TabsTrigger value="analytics">{t('reports.tab.analytics', 'Analytics')}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="pt-2">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="ads" className="pt-2">
          <Lazy>
            <AdReportingPage embedded />
          </Lazy>
        </TabsContent>
        <TabsContent value="performance" className="pt-2">
          <Lazy>
            <PerformancePage embedded />
          </Lazy>
        </TabsContent>
        {isManager && (
          <TabsContent value="analytics" className="pt-2">
            <Lazy>
              <AnalyticsPage embedded />
            </Lazy>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ─── Overview tab (the classic lead reports) ──────────────────────────────────

function OverviewTab() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // URL-synced nested tab state (`?sub=`) — deep-linkable, back-button-safe.
  // The rep-performance report is manager-only; others fall back to sources.
  const [params, setParams] = useSearchParams();
  const rawSub = params.get('sub');
  const isValidSub = (v: string | null): v is OverviewSub =>
    (OVERVIEW_SUBS as readonly string[]).includes(v ?? '') && (v !== 'performance' || isManager);
  const sub: OverviewSub = isValidSub(rawSub) ? rawSub : 'sources';
  const setSub = (v: string) =>
    setParams((p) => {
      p.set('sub', v);
      return p;
    }, { replace: true });

  const { data: sources, isLoading: loadingSources } = useQuery({
    queryKey: ['marketing', 'reports', 'sources'],
    queryFn: () => marketingApi.get('/reports/lead-sources').then((r) => r.data),
    enabled: sub === 'sources',
  });

  const { data: regional, isLoading: loadingRegional } = useQuery({
    queryKey: ['marketing', 'reports', 'regional'],
    queryFn: () => marketingApi.get('/reports/regional').then((r) => r.data),
    enabled: sub === 'regional',
  });

  const { data: conversion, isLoading: loadingConversion } = useQuery({
    queryKey: ['marketing', 'reports', 'conversion'],
    queryFn: () => marketingApi.get('/reports/conversion').then((r) => r.data),
    enabled: sub === 'conversion',
  });

  const { data: performance, isLoading: loadingPerformance } = useQuery({
    queryKey: ['marketing', 'reports', 'performance'],
    queryFn: () => marketingApi.get('/reports/performance').then((r) => r.data),
    enabled: sub === 'performance' && isManager,
  });

  const tabs = [
    { id: 'sources', labelKey: 'reports.tabs.sources', icon: BarChart3 },
    { id: 'regional', labelKey: 'reports.tabs.regional', icon: MapPin },
    { id: 'conversion', labelKey: 'reports.tabs.conversion', icon: TrendingUp },
    ...(isManager ? [{ id: 'performance', labelKey: 'reports.tabs.performance', icon: Users }] : []),
  ] as const;

  return (
    <Tabs value={sub} onValueChange={setSub}>
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
  );
}
