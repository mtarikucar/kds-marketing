import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TrendingUp, Users } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { formatMoney } from '../../lib/money';
import { TARGET_METRICS, TARGET_METRIC_LABELS } from '../../features/marketing/types';
import type {
  MetricPerformance,
  TeamPerformanceRow,
  MarketingUserInfo,
} from '../../features/marketing/types';
import {
  PageHeader,
  Card,
  CardContent,
  FilterBar,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  StatCard,
  Progress,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Skeleton,
  EmptyState,
  Label,
} from '../../components/ui';

// ─── helpers ─────────────────────────────────────────────────────────────────

interface RepRow extends MarketingUserInfo {
  role: string;
}

const currentPeriod = () => new Date().toISOString().slice(0, 7);

const metricLabel = (m: string) =>
  TARGET_METRIC_LABELS[m as keyof typeof TARGET_METRIC_LABELS] || m;

// Exported for unit testing. COMMISSION_AMOUNT is a money target denominated in
// the workspace's currency (TRY by default for this Turkish business — the
// commission ledger is in TL), so it must use the locale-aware money formatter,
// not a hard-coded `$` that mislabels TL as dollars.
export function fmtValue(metric: string, v: number | null | undefined): string {
  if (v == null) return '—';
  if (metric === 'COMMISSION_AMOUNT') return formatMoney(Number(v));
  return String(v);
}

function attainmentTone(pct: number | null): 'success' | 'warning' | 'danger' | 'primary' {
  if (pct == null) return 'primary';
  if (pct >= 100) return 'success';
  if (pct >= 70) return 'warning';
  return 'danger';
}

// ─── Metric Card (individual rep view) ───────────────────────────────────────

function MetricCard({ m }: { m: MetricPerformance }) {
  const { t } = useTranslation('marketing');
  const pct = m.attainmentPct;
  const tone = attainmentTone(pct);
  return (
    <StatCard
      label={metricLabel(m.metric)}
      value={fmtValue(m.metric, m.actual)}
      icon={<TrendingUp className="h-5 w-5" />}
      delta={
        m.target != null
          ? {
              value: t('performance.ofTarget', {
                pct: pct != null ? pct : 0,
                target: fmtValue(m.metric, m.target),
              }),
              direction: pct == null ? 'flat' : pct >= 100 ? 'up' : pct >= 70 ? 'flat' : 'down',
            }
          : undefined
      }
      tone={tone === 'primary' ? 'neutral' : tone}
    />
  );
}

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function TableSkeleton({ cols, rows = 4 }: { cols: number; rows?: number }) {
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

export default function PerformancePage() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

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

  const repOptions = reps.filter((r) => r.role === 'REP');

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('performance.title')}
        description={isManager ? t('performance.subtitleManager') : t('performance.subtitleRep')}
      />

      {/* ── Filters ── */}
      <Card>
        <CardContent className="py-3">
          <FilterBar>
            <div className="flex flex-col gap-1">
              <Label htmlFor="perf-period" className="text-xs text-muted-foreground">
                {t('performance.period')}
              </Label>
              <input
                id="perf-period"
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {isManager && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="perf-rep" className="text-xs text-muted-foreground">
                  {t('performance.rep')}
                </Label>
                <Select
                  value={repId || '__all__'}
                  onValueChange={(v) => setRepId(v === '__all__' ? '' : v)}
                >
                  <SelectTrigger id="perf-rep" className="w-48">
                    <SelectValue placeholder={t('performance.wholeTeam')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">{t('performance.wholeTeam')}</SelectItem>
                    {repOptions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.firstName} {r.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </FilterBar>
        </CardContent>
      </Card>

      {/* ── Content ── */}
      {isLoading ? (
        isTeam ? (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableSkeleton cols={1 + TARGET_METRICS.length} />
              </Table>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        )
      ) : isTeam ? (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>{t('performance.rep')}</TH>
                  {TARGET_METRICS.map((m) => (
                    <TH key={m} numeric>
                      {metricLabel(m)}
                    </TH>
                  ))}
                </TR>
              </THead>
              {team.length === 0 ? null : (
                <TBody>
                  {team.map((row) => (
                    <TR key={row.marketingUser.id}>
                      <TD className="font-medium text-foreground">
                        {row.marketingUser.firstName} {row.marketingUser.lastName}
                      </TD>
                      {TARGET_METRICS.map((mk) => {
                        const m = row.metrics.find((x) => x.metric === mk);
                        const pct = m?.attainmentPct ?? null;
                        const tone = attainmentTone(pct);
                        return (
                          <TD key={mk} numeric>
                            <span className="text-foreground tabular-nums">
                              {fmtValue(mk, m?.actual ?? 0)}
                              {m?.target != null && (
                                <span className="text-muted-foreground">
                                  {' '}/ {fmtValue(mk, m.target)}
                                </span>
                              )}
                            </span>
                            {pct != null && (
                              <Progress
                                value={Math.min(pct, 100)}
                                tone={tone === 'primary' ? 'primary' : tone}
                                className="mt-1 w-24"
                              />
                            )}
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                </TBody>
              )}
            </Table>
            {team.length === 0 && (
              <EmptyState
                icon={<Users className="h-10 w-10" />}
                title={t('performance.emptyRepsTitle')}
                description={t('performance.emptyRepsDesc')}
                className="m-4"
              />
            )}
          </CardContent>
        </Card>
      ) : metrics.length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="h-10 w-10" />}
          title={t('performance.emptyTitle')}
          description={t('performance.emptyDesc')}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {metrics.map((m) => (
            <MetricCard key={m.metric} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
