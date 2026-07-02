import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  TrendingUp,
  Users,
  Layers,
  GitBranch,
  DollarSign,
  Target,
} from 'lucide-react';
import { format, subDays } from 'date-fns';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useWorkspaceProfile } from '../../../features/marketing/hooks/useWorkspaceProfile';
import { formatMoney, asWorkspaceCurrency } from '../../../lib/money';
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
  StatCard,
  SegmentedControl,
  DatePicker,
} from '../../../components/ui';

// ─── Types (matching backend response shapes) ─────────────────────────────────

interface FunnelStep {
  status: string;
  count: number;
}

interface FunnelData {
  total: number;
  won: number;
  lost: number;
  open: number;
  conversionRate: number;
  waterfall: FunnelStep[];
  byStatus: Record<string, number>;
}

interface BreakdownRow {
  key: string;
  count: number;
}

interface RepRow {
  repId: string;
  total: number;
  won: number;
  lost: number;
  conversionRate: number;
}

type AttributionModel = 'first' | 'last' | 'linear';

interface ChannelAttribution {
  channel: string;
  revenue: number;
  conversions: number;
  leads: number;
  conversionRate: number;
}

interface AttributionData {
  model: AttributionModel;
  totalRevenue: number;
  conversions: number;
  channels: ChannelAttribution[];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number) {
  return `${v}%`;
}


function conversionTone(rate: number): 'success' | 'warning' | 'danger' {
  if (rate >= 40) return 'success';
  if (rate >= 20) return 'warning';
  return 'danger';
}

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

function FunnelBarViz({ waterfall }: { waterfall: FunnelStep[] }) {
  const maxCount = Math.max(...waterfall.map((s) => s.count), 1);
  return (
    <div className="space-y-2.5">
      {waterfall.map((step) => {
        const widthPct = (step.count / maxCount) * 100;
        return (
          <div key={step.status} className="flex items-center gap-4">
            <span className="w-36 text-sm text-muted-foreground text-end shrink-0 font-medium">
              {step.status.replace(/_/g, ' ')}
            </span>
            <div className="flex-1">
              <div className="h-8 rounded-lg overflow-hidden bg-surface-muted">
                <div
                  className="h-full bg-primary rounded-lg flex items-center px-3 transition-all duration-300"
                  style={{ width: `${Math.max(widthPct, 2)}%` }}
                >
                  <span className="text-xs text-primary-foreground font-semibold tabular-nums">
                    {step.count}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BreakdownTable({
  rows,
  isLoading,
  emptyIcon,
  emptyTitle,
  emptyDesc,
}: {
  rows: BreakdownRow[] | undefined;
  isLoading: boolean;
  emptyIcon: React.ReactNode;
  emptyTitle: string;
  emptyDesc: string;
}) {
  const maxCount = Math.max(...(rows ?? []).map((r) => r.count), 1);
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <Table className="min-w-[460px]">
          <THead>
            <TR>
              <TH>Key</TH>
              <TH numeric>Leads</TH>
              <TH>Distribution</TH>
            </TR>
          </THead>
          {isLoading ? (
            <TableSkeleton cols={3} />
          ) : (rows?.length ?? 0) > 0 ? (
            <TBody>
              {rows!.map((r) => (
                <TR key={r.key}>
                  <TD className="font-medium text-foreground">{r.key || '—'}</TD>
                  <TD numeric>
                    <Badge tone="neutral">{r.count}</Badge>
                  </TD>
                  <TD>
                    <Progress
                      value={(r.count / maxCount) * 100}
                      tone="primary"
                      className="w-32 h-2"
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          ) : null}
        </Table>
        {!isLoading && (rows?.length ?? 0) === 0 && (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDesc}
            className="m-4"
          />
        )}
      </CardContent>
    </Card>
  );
}

// ─── Date range toolbar ───────────────────────────────────────────────────────

interface DateRange {
  from: Date;
  to: Date;
}

function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-muted-foreground">From</span>
      <DatePicker
        value={value.from}
        onChange={(d) => onChange({ ...value, from: d })}
        aria-label="From date"
        className="w-36"
      />
      <span className="text-sm text-muted-foreground">to</span>
      <DatePicker
        value={value.to}
        onChange={(d) => onChange({ ...value, to: d })}
        aria-label="To date"
        className="w-36"
      />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type AnalyticsTab = 'funnel' | 'by-source' | 'by-business-type' | 'rep-performance' | 'attribution';

const ATTRIBUTION_OPTIONS: { value: AttributionModel; label: string }[] = [
  { value: 'first', label: 'First-touch' },
  { value: 'last', label: 'Last-touch' },
  { value: 'linear', label: 'Linear' },
];

export default function AnalyticsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [tab, setTab] = useState<AnalyticsTab>('funnel');
  // Attribution revenue is derived from offer prices in the WORKSPACE's currency —
  // format it as such, not a hardcoded ₺ (a non-TRY workspace saw the wrong symbol).
  const { workspace } = useWorkspaceProfile();
  const currency = asWorkspaceCurrency(workspace?.defaultCurrency);

  const defaultRange: DateRange = {
    from: subDays(new Date(), 30),
    to: new Date(),
  };
  const [dateRange, setDateRange] = useState<DateRange>(defaultRange);
  const [attrModel, setAttrModel] = useState<AttributionModel>('last');

  const rangeParams = {
    from: format(dateRange.from, 'yyyy-MM-dd'),
    to: format(dateRange.to, 'yyyy-MM-dd'),
  };

  // ── Funnel ────────────────────────────────────────────────────────────────
  const { data: funnel, isLoading: loadingFunnel } = useQuery<FunnelData>({
    queryKey: ['marketing', 'analytics', 'funnel', rangeParams],
    queryFn: () =>
      marketingApi
        .get('/analytics/funnel', { params: rangeParams })
        .then((r) => r.data),
    enabled: tab === 'funnel',
  });

  // ── By source ─────────────────────────────────────────────────────────────
  const { data: bySource, isLoading: loadingSource } = useQuery<BreakdownRow[]>({
    queryKey: ['marketing', 'analytics', 'by-source', rangeParams],
    queryFn: () =>
      marketingApi
        .get('/analytics/by-source', { params: rangeParams })
        .then((r) => r.data),
    enabled: tab === 'by-source',
  });

  // ── By business type ──────────────────────────────────────────────────────
  const { data: byBizType, isLoading: loadingBizType } = useQuery<BreakdownRow[]>({
    queryKey: ['marketing', 'analytics', 'by-business-type', rangeParams],
    queryFn: () =>
      marketingApi
        .get('/analytics/by-business-type', { params: rangeParams })
        .then((r) => r.data),
    enabled: tab === 'by-business-type',
  });

  // ── Rep performance ───────────────────────────────────────────────────────
  const { data: reps, isLoading: loadingReps } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'analytics', 'rep-performance', rangeParams],
    queryFn: () =>
      marketingApi
        .get('/analytics/rep-performance', { params: rangeParams })
        .then((r) => r.data),
    enabled: tab === 'rep-performance' && isManager,
  });

  // ── Attribution ───────────────────────────────────────────────────────────
  const { data: attribution, isLoading: loadingAttr } = useQuery<AttributionData>({
    queryKey: ['marketing', 'analytics', 'attribution', attrModel, rangeParams],
    queryFn: () =>
      marketingApi
        .get('/analytics/attribution', { params: { model: attrModel, ...rangeParams } })
        .then((r) => r.data),
    enabled: tab === 'attribution' && isManager,
  });

  const tabs = [
    { id: 'funnel' as const, label: 'Funnel', icon: TrendingUp },
    { id: 'by-source' as const, label: 'By Source', icon: BarChart3 },
    { id: 'by-business-type' as const, label: 'By Business Type', icon: Layers },
    ...(isManager
      ? ([
          { id: 'rep-performance' as const, label: 'Rep Performance', icon: Users },
          { id: 'attribution' as const, label: 'Attribution', icon: GitBranch },
        ] as const)
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Funnel, source breakdown, rep performance and multi-touch attribution."
      />

      {/* Date range — shared across all tabs */}
      <DateRangePicker value={dateRange} onChange={setDateRange} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as AnalyticsTab)}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="flex items-center gap-1.5">
              <t.icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── Funnel ── */}
        <TabsContent value="funnel">
          {loadingFunnel ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-64 w-full rounded-xl" />
            </div>
          ) : !funnel ? (
            <EmptyState
              icon={<TrendingUp className="h-10 w-10" />}
              title="No funnel data"
              description="Funnel data will appear once leads are in your workspace."
            />
          ) : (
            <div className="space-y-6">
              {/* Headline stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard
                  label="Total Leads"
                  value={String(funnel.total)}
                  icon={<Users className="h-5 w-5" />}
                  tone="neutral"
                />
                <StatCard
                  label="Won"
                  value={String(funnel.won)}
                  icon={<TrendingUp className="h-5 w-5" />}
                  tone="success"
                />
                <StatCard
                  label="Lost"
                  value={String(funnel.lost)}
                  icon={<Target className="h-5 w-5" />}
                  tone="danger"
                />
                <StatCard
                  label="Conversion Rate"
                  value={fmtPct(funnel.conversionRate)}
                  icon={<BarChart3 className="h-5 w-5" />}
                  tone={funnel.conversionRate >= 30 ? 'success' : funnel.conversionRate >= 15 ? 'warning' : 'neutral'}
                />
              </div>

              {/* Waterfall bar viz */}
              <Card>
                <CardContent className="space-y-4 pt-4">
                  <h3 className="font-display text-h3 text-foreground">Lead Funnel</h3>
                  {funnel.waterfall.length === 0 ? (
                    <EmptyState
                      icon={<TrendingUp className="h-8 w-8" />}
                      title="No stages yet"
                      description="Leads have not moved through any stages."
                    />
                  ) : (
                    <FunnelBarViz waterfall={funnel.waterfall} />
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ── By Source ── */}
        <TabsContent value="by-source">
          <BreakdownTable
            rows={bySource}
            isLoading={loadingSource}
            emptyIcon={<BarChart3 className="h-10 w-10" />}
            emptyTitle="No source data"
            emptyDesc="Lead source breakdown will appear once leads have a source set."
          />
        </TabsContent>

        {/* ── By Business Type ── */}
        <TabsContent value="by-business-type">
          <BreakdownTable
            rows={byBizType}
            isLoading={loadingBizType}
            emptyIcon={<Layers className="h-10 w-10" />}
            emptyTitle="No business type data"
            emptyDesc="Business type breakdown will appear once leads have a business type set."
          />
        </TabsContent>

        {/* ── Rep Performance (manager only) ── */}
        {isManager && (
          <TabsContent value="rep-performance">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table className="min-w-[640px]">
                  <THead>
                    <TR>
                      <TH>Rep</TH>
                      <TH numeric>Total</TH>
                      <TH numeric>Won</TH>
                      <TH numeric>Lost</TH>
                      <TH>Conversion</TH>
                    </TR>
                  </THead>
                  {loadingReps ? (
                    <TableSkeleton cols={5} />
                  ) : (reps?.length ?? 0) > 0 ? (
                    <TBody>
                      {reps!.map((rep) => (
                        <TR key={rep.repId}>
                          <TD className="font-medium text-foreground font-mono text-xs text-muted-foreground truncate max-w-[180px]">
                            {rep.repId === 'unassigned' ? (
                              <span className="italic">Unassigned</span>
                            ) : (
                              rep.repId
                            )}
                          </TD>
                          <TD numeric>{rep.total}</TD>
                          <TD numeric>
                            <Badge tone="success">{rep.won}</Badge>
                          </TD>
                          <TD numeric>
                            <Badge tone="danger">{rep.lost}</Badge>
                          </TD>
                          <TD>
                            <div className="flex items-center gap-2">
                              <Progress
                                value={Math.min(rep.conversionRate, 100)}
                                tone={conversionTone(rep.conversionRate)}
                                className="w-16 h-2"
                              />
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {fmtPct(rep.conversionRate)}
                              </span>
                            </div>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  ) : null}
                </Table>
                {!loadingReps && (reps?.length ?? 0) === 0 && (
                  <EmptyState
                    icon={<Users className="h-10 w-10" />}
                    title="No rep data"
                    description="Rep performance will appear once leads are assigned to reps."
                    className="m-4"
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ── Attribution (manager only) ── */}
        {isManager && (
          <TabsContent value="attribution">
            <div className="space-y-4">
              {/* Model toggle */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium text-foreground">Attribution model:</span>
                <SegmentedControl
                  options={ATTRIBUTION_OPTIONS}
                  value={attrModel}
                  onChange={(v) => setAttrModel(v as AttributionModel)}
                  aria-label="Attribution model"
                />
              </div>

              {loadingAttr ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <Skeleton key={i} className="h-24 w-full rounded-xl" />
                    ))}
                  </div>
                  <Skeleton className="h-64 w-full rounded-xl" />
                </div>
              ) : !attribution ? (
                <EmptyState
                  icon={<GitBranch className="h-10 w-10" />}
                  title="No attribution data"
                  description="Attribution data will appear once leads with accepted offers exist."
                />
              ) : (
                <div className="space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 gap-4">
                    <StatCard
                      label="Total Revenue"
                      value={formatMoney(attribution.totalRevenue, currency)}
                      icon={<DollarSign className="h-5 w-5" />}
                      tone="success"
                    />
                    <StatCard
                      label="Converted Leads"
                      value={String(attribution.conversions)}
                      icon={<TrendingUp className="h-5 w-5" />}
                      tone="primary"
                    />
                  </div>

                  {/* Per-channel breakdown */}
                  <Card>
                    <CardContent className="p-0 overflow-x-auto">
                      <Table className="min-w-[640px]">
                        <THead>
                          <TR>
                            <TH>Channel</TH>
                            <TH numeric>Leads</TH>
                            <TH numeric>Conversions</TH>
                            <TH numeric>Revenue ({currency})</TH>
                            <TH>Conv. Rate</TH>
                          </TR>
                        </THead>
                        {(attribution.channels?.length ?? 0) > 0 ? (
                          <TBody>
                            {attribution.channels.map((ch) => (
                              <TR key={ch.channel}>
                                <TD className="font-medium text-foreground">{ch.channel}</TD>
                                <TD numeric>{ch.leads}</TD>
                                <TD numeric>
                                  <Badge tone="success">{ch.conversions}</Badge>
                                </TD>
                                <TD numeric className="tabular-nums">
                                  {formatMoney(ch.revenue, currency)}
                                </TD>
                                <TD>
                                  <div className="flex items-center gap-2">
                                    <Progress
                                      value={Math.min(ch.conversionRate, 100)}
                                      tone={conversionTone(ch.conversionRate)}
                                      className="w-16 h-2"
                                    />
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                      {fmtPct(ch.conversionRate)}
                                    </span>
                                  </div>
                                </TD>
                              </TR>
                            ))}
                          </TBody>
                        ) : null}
                      </Table>
                      {(attribution.channels?.length ?? 0) === 0 && (
                        <EmptyState
                          icon={<GitBranch className="h-8 w-8" />}
                          title="No channel data"
                          description="No channel touches recorded for converted leads in this range."
                          className="m-4"
                        />
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
