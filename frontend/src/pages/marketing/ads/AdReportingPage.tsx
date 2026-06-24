import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Link2,
  Unlink,
  RefreshCw,
  AlertTriangle,
  MousePointerClick,
  Eye,
  DollarSign,
  Target,
} from 'lucide-react';
import {
  getAdStatus,
  listAdAccounts,
  getAdMetrics,
  connectAdAccount,
  removeAdAccount,
  pullAdAccount,
  startTiktokAdsOAuth,
  type AdAccount,
  type AdProvider,
} from '../../../features/marketing/api/ads.service';
import type { ConnectAdAccountFormValues } from './adsSchemas';
import { AD_PROVIDER_LABEL } from './adsSchemas';
import { ConnectAdAccountDialog } from './ConnectAdAccountDialog';
import { TiktokAdsSelectDialog } from './TiktokAdsSelectDialog';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import { formatMoney, asWorkspaceCurrency } from '../../../lib/money';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Skeleton } from '@/components/ui/Skeleton';

type View = 'overview' | 'accounts';
type RangeKey = '7' | '30' | '90';
type ProviderFilter = 'ALL' | AdProvider;

const STATUS_TONE: Record<AdAccount['status'], 'success' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  TOKEN_EXPIRED: 'warning',
  DISCONNECTED: 'danger',
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function fmtInt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}
function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}

export default function AdReportingPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<View>('overview');
  const [range, setRange] = useState<RangeKey>('30');
  const [provider, setProvider] = useState<ProviderFilter>('ALL');
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<AdAccount | null>(null);
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);

  // ── OAuth return handling ────────────────────────────────────────────────────
  // The TikTok Business OAuth callback redirects back to /ads?connect=<pendingId>
  // (success) or ?connect_error=1 (failure). Pick up the param once, open the
  // advertiser selector, and strip it from the URL.
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    if (connectId) {
      setPendingConnectId(connectId);
      setView('accounts');
      searchParams.delete('connect');
      setSearchParams(searchParams, { replace: true });
    } else if (connectErr) {
      toast.error(
        t('ads.oauth.callbackError', {
          defaultValue: 'TikTok connection failed or was cancelled. Please try again.',
        }),
      );
      searchParams.delete('connect_error');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: status } = useQuery({
    queryKey: ['marketing', 'ads', 'status'],
    queryFn: getAdStatus,
  });

  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['marketing', 'ads', 'accounts'],
    queryFn: listAdAccounts,
  });

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['marketing', 'ads', 'metrics', range, provider],
    queryFn: () =>
      getAdMetrics({
        from: isoDaysAgo(Number(range)),
        to: todayIso(),
        provider: provider === 'ALL' ? undefined : provider,
      }),
  });

  const accounts: AdAccount[] = Array.isArray(accountsData) ? accountsData : [];

  // Pick a currency to label spend with: the first connected account's currency
  // (ad spend is single-currency per account; mixed-currency workspaces are rare
  // and the raw provider value is preserved server-side regardless).
  const currency = useMemo(
    () => asWorkspaceCurrency(accounts.find((a) => a.currency)?.currency),
    [accounts],
  );

  // ── Mutations ────────────────────────────────────────────────────────────────

  const invalidateAccounts = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
  const invalidateMetrics = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'metrics'] });

  const startTikTokConnect = async () => {
    try {
      const { authorizeUrl } = await startTiktokAdsOAuth();
      window.location.href = authorizeUrl;
    } catch {
      toast.error(
        t('ads.oauth.startFailed', { defaultValue: 'Could not start the TikTok connection' }),
      );
    }
  };

  const handleReconnect = (account: AdAccount) => {
    if (account.provider === 'TIKTOK') {
      void startTikTokConnect();
    }
    // META reconnect not yet implemented — button is hidden for META accounts
  };

  const connectMutation = useMutation({
    mutationFn: (values: ConnectAdAccountFormValues) =>
      connectAdAccount({
        provider: values.provider,
        externalAdId: values.externalAdId,
        displayName: values.displayName,
        accessToken: values.accessToken,
        currency: values.currency,
      }),
    onSuccess: () => {
      invalidateAccounts();
      setConnectOpen(false);
      toast.success(t('ads.toast.connected', { defaultValue: 'Ad account connected' }));
    },
    onError: () => toast.error(t('ads.toast.connectFailed', { defaultValue: 'Failed to connect account' })),
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => removeAdAccount(id),
    onSuccess: () => {
      invalidateAccounts();
      invalidateMetrics();
      setDisconnectTarget(null);
      toast.success(t('ads.toast.disconnected', { defaultValue: 'Ad account disconnected' }));
    },
    onError: () => toast.error(t('ads.toast.disconnectFailed', { defaultValue: 'Failed to disconnect account' })),
  });

  const pullMutation = useMutation({
    mutationFn: (id: string) => pullAdAccount(id),
    onSuccess: (res) => {
      invalidateAccounts();
      invalidateMetrics();
      toast.success(
        t('ads.toast.pulled', { defaultValue: 'Refreshed — {{count}} day(s) updated', count: res.written }),
      );
    },
    onError: () => toast.error(t('ads.toast.pullFailed', { defaultValue: 'Failed to refresh metrics' })),
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  const totals = metrics?.totals ?? { spend: 0, impressions: 0, clicks: 0, leads: 0 };
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const cpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
  const noAccounts = !accountsLoading && accounts.length === 0;

  const canConnect = isManager && (status ? status.secretBoxConfigured : true);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('ads.title', { defaultValue: 'Ad Reporting' })}
        description={t('ads.subtitle', {
          defaultValue: 'Track Meta and TikTok ad spend, clicks and conversions across your accounts.',
        })}
        actions={
          isManager ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void startTikTokConnect()}
                disabled={!status?.TIKTOK}
                title={
                  status?.TIKTOK
                    ? undefined
                    : t('ads.oauth.tiktokNotConfigured', {
                        defaultValue:
                          'An admin must add TikTok Business app credentials first',
                      })
                }
                variant="outline"
              >
                {t('ads.oauth.tiktokConnect', {
                  defaultValue: 'Connect TikTok for Business',
                })}
              </Button>
              <Button onClick={() => setConnectOpen(true)} disabled={!canConnect} variant="outline">
                <Link2 className="h-4 w-4" aria-hidden="true" />
                {t('ads.connectAccount', { defaultValue: 'Connect account' })}
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<View>
          aria-label={t('ads.viewToggle', { defaultValue: 'Ad reporting view' })}
          value={view}
          onChange={setView}
          options={[
            { value: 'overview', label: t('ads.tabs.overview', { defaultValue: 'Overview' }) },
            { value: 'accounts', label: t('ads.tabs.accounts', { defaultValue: 'Accounts' }) },
          ]}
        />

        {view === 'overview' && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={provider} onValueChange={(v) => setProvider(v as ProviderFilter)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t('ads.filter.allProviders', { defaultValue: 'All providers' })}</SelectItem>
                <SelectItem value="META">{AD_PROVIDER_LABEL.META}</SelectItem>
                <SelectItem value="TIKTOK">{AD_PROVIDER_LABEL.TIKTOK}</SelectItem>
              </SelectContent>
            </Select>
            <SegmentedControl<RangeKey>
              aria-label={t('ads.rangeToggle', { defaultValue: 'Date range' })}
              value={range}
              onChange={setRange}
              options={[
                { value: '7', label: t('ads.range.7', { defaultValue: '7d' }) },
                { value: '30', label: t('ads.range.30', { defaultValue: '30d' }) },
                { value: '90', label: t('ads.range.90', { defaultValue: '90d' }) },
              ]}
            />
          </div>
        )}
      </div>

      {view === 'overview' ? (
        <OverviewView
          isLoading={metricsLoading}
          noAccounts={noAccounts}
          totals={totals}
          ctr={ctr}
          cpl={cpl}
          currency={currency}
          byDay={metrics?.byDay ?? []}
          byProvider={metrics?.byProvider ?? {}}
          onGoToAccounts={() => setView('accounts')}
          canConnect={canConnect}
        />
      ) : (
        <AccountsView
          accounts={accounts}
          isLoading={accountsLoading}
          isManager={isManager}
          canConnect={canConnect}
          onConnect={() => setConnectOpen(true)}
          onDisconnect={setDisconnectTarget}
          onPull={(id) => pullMutation.mutate(id)}
          pullingId={pullMutation.isPending ? (pullMutation.variables as string) : null}
          onReconnect={handleReconnect}
        />
      )}

      <TiktokAdsSelectDialog
        pendingId={pendingConnectId}
        onOpenChange={(open) => { if (!open) setPendingConnectId(null); }}
        onSuccess={invalidateAccounts}
      />

      <ConnectAdAccountDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onSubmit={(values) => connectMutation.mutate(values)}
        isPending={connectMutation.isPending}
        status={status}
      />

      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        title={t('ads.confirm.disconnectTitle', { defaultValue: 'Disconnect ad account' })}
        description={t('ads.confirm.disconnectBody', {
          defaultValue: 'This removes the account and all of its pulled metrics. This cannot be undone.',
        })}
        confirmLabel={t('ads.action.disconnect', { defaultValue: 'Disconnect' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => disconnectTarget && disconnectMutation.mutate(disconnectTarget.id)}
        loading={disconnectMutation.isPending}
      />
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────

interface Bucket {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
}

interface OverviewViewProps {
  isLoading: boolean;
  noAccounts: boolean;
  totals: Bucket;
  ctr: number;
  cpl: number;
  currency: ReturnType<typeof asWorkspaceCurrency>;
  byDay: Array<Bucket & { date: string }>;
  byProvider: Partial<Record<AdProvider, Bucket>>;
  onGoToAccounts: () => void;
  canConnect: boolean;
}

function OverviewView({
  isLoading,
  noAccounts,
  totals,
  ctr,
  cpl,
  currency,
  byDay,
  byProvider,
  onGoToAccounts,
  canConnect,
}: OverviewViewProps) {
  const { t } = useTranslation('marketing');

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  if (noAccounts) {
    return (
      <EmptyState
        icon={<MousePointerClick className="h-10 w-10" />}
        title={t('ads.empty.title', { defaultValue: 'No ad accounts connected' })}
        description={t('ads.empty.description', {
          defaultValue: 'Connect a Meta or TikTok ad account to start seeing spend and conversion reporting.',
        })}
        action={
          <Button onClick={onGoToAccounts} variant="outline" disabled={!canConnect}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {t('ads.connectAccount', { defaultValue: 'Connect account' })}
          </Button>
        }
      />
    );
  }

  const providerEntries = Object.entries(byProvider) as Array<[AdProvider, Bucket]>;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t('ads.stat.spend', { defaultValue: 'Spend' })}
          value={formatMoney(totals.spend, currency)}
          icon={<DollarSign className="h-5 w-5" />}
          tone="primary"
        />
        <StatCard
          label={t('ads.stat.impressions', { defaultValue: 'Impressions' })}
          value={fmtInt(totals.impressions)}
          icon={<Eye className="h-5 w-5" />}
        />
        <StatCard
          label={t('ads.stat.clicks', { defaultValue: 'Clicks' })}
          value={fmtInt(totals.clicks)}
          icon={<MousePointerClick className="h-5 w-5" />}
        />
        <StatCard
          label={t('ads.stat.leads', { defaultValue: 'Leads' })}
          value={fmtInt(totals.leads)}
          icon={<Target className="h-5 w-5" />}
          tone="success"
        />
        <StatCard label={t('ads.stat.ctr', { defaultValue: 'CTR' })} value={pct(ctr)} />
        <StatCard
          label={t('ads.stat.cpl', { defaultValue: 'Cost / lead' })}
          value={totals.leads > 0 ? formatMoney(cpl, currency) : '—'}
        />
      </div>

      {providerEntries.length > 0 && (
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium text-foreground">
              {t('ads.byProvider.title', { defaultValue: 'By provider' })}
            </h3>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>{t('ads.col.provider', { defaultValue: 'Provider' })}</TH>
                <TH className="text-right">{t('ads.stat.spend', { defaultValue: 'Spend' })}</TH>
                <TH className="text-right">{t('ads.stat.impressions', { defaultValue: 'Impressions' })}</TH>
                <TH className="text-right">{t('ads.stat.clicks', { defaultValue: 'Clicks' })}</TH>
                <TH className="text-right">{t('ads.stat.leads', { defaultValue: 'Leads' })}</TH>
              </TR>
            </THead>
            <TBody>
              {providerEntries.map(([prov, m]) => (
                <TR key={prov}>
                  <TD>
                    <Badge tone="neutral" size="sm">{AD_PROVIDER_LABEL[prov]}</Badge>
                  </TD>
                  <TD className="text-right tabular-nums">{formatMoney(m.spend, currency)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(m.impressions)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(m.clicks)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(m.leads)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-medium text-foreground">
            {t('ads.byDay.title', { defaultValue: 'Daily breakdown' })}
          </h3>
        </div>
        {byDay.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('ads.byDay.empty', { defaultValue: 'No metrics in this range yet.' })}
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('ads.col.date', { defaultValue: 'Date' })}</TH>
                <TH className="text-right">{t('ads.stat.spend', { defaultValue: 'Spend' })}</TH>
                <TH className="text-right">{t('ads.stat.impressions', { defaultValue: 'Impressions' })}</TH>
                <TH className="text-right">{t('ads.stat.clicks', { defaultValue: 'Clicks' })}</TH>
                <TH className="text-right">{t('ads.stat.leads', { defaultValue: 'Leads' })}</TH>
              </TR>
            </THead>
            <TBody>
              {[...byDay].reverse().map((d) => (
                <TR key={d.date}>
                  <TD className="tabular-nums">{d.date}</TD>
                  <TD className="text-right tabular-nums">{formatMoney(d.spend, currency)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(d.impressions)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(d.clicks)}</TD>
                  <TD className="text-right tabular-nums">{fmtInt(d.leads)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ── Accounts ───────────────────────────────────────────────────────────────────

interface AccountsViewProps {
  accounts: AdAccount[];
  isLoading: boolean;
  isManager: boolean;
  canConnect: boolean;
  onConnect: () => void;
  onDisconnect: (account: AdAccount) => void;
  onPull: (id: string) => void;
  pullingId: string | null;
  onReconnect: (account: AdAccount) => void;
}

function AccountsView({
  accounts,
  isLoading,
  isManager,
  canConnect,
  onConnect,
  onDisconnect,
  onPull,
  pullingId,
  onReconnect,
}: AccountsViewProps) {
  const { t } = useTranslation('marketing');

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<Link2 className="h-10 w-10" />}
        title={t('ads.accounts.empty', { defaultValue: 'No connected ad accounts' })}
        description={t('ads.accounts.emptyHint', {
          defaultValue: 'Connect a Meta or TikTok ad account to pull spend and conversion metrics.',
        })}
        action={
          isManager ? (
            <Button onClick={onConnect} variant="outline" disabled={!canConnect}>
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {t('ads.connectAccount', { defaultValue: 'Connect account' })}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {accounts.map((acc) => {
        const needsReauth = acc.status === 'TOKEN_EXPIRED' || acc.lastError === 'reauth_required';
        return (
        <Card key={acc.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{acc.displayName}</p>
              <p className="truncate font-mono text-micro text-muted-foreground">{acc.externalAdId}</p>
            </div>
            <Badge tone="neutral" size="sm">{AD_PROVIDER_LABEL[acc.provider]}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[acc.status]} size="sm">
              {t(`ads.status.${acc.status}`, { defaultValue: acc.status })}
            </Badge>
            {acc.currency && (
              <Badge tone="neutral" size="sm">{acc.currency}</Badge>
            )}
          </div>

          <p className="text-micro text-muted-foreground">
            {acc.lastPulledAt
              ? t('ads.accounts.lastPulled', {
                  defaultValue: 'Last refreshed {{when}}',
                  when: fmtDateTime(acc.lastPulledAt),
                })
              : t('ads.accounts.neverPulled', { defaultValue: 'Not refreshed yet' })}
          </p>

          {needsReauth ? (
            <p className="flex items-start gap-1 text-micro text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>
                {t('ads.accounts.reauthNeeded', {
                  defaultValue: 'Access expired — reconnect this account to resume reporting.',
                })}
              </span>
            </p>
          ) : acc.lastError ? (
            <p className="flex items-start gap-1 text-micro text-danger">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{acc.lastError}</span>
            </p>
          ) : null}

          {isManager && acc.status === 'TOKEN_EXPIRED' && acc.provider === 'TIKTOK' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReconnect(acc)}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('ads.action.reconnect', { defaultValue: 'Reconnect' })}
            </Button>
          )}

          {isManager && (
            <div className="mt-auto flex items-center justify-end gap-1 pt-1">
              {needsReauth && (
                <Button variant="outline" size="sm" onClick={onConnect}>
                  <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('ads.action.reconnect', { defaultValue: 'Reconnect' })}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPull(acc.id)}
                loading={pullingId === acc.id}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('ads.action.refresh', { defaultValue: 'Refresh' })}
              </Button>
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={t('ads.action.disconnect', { defaultValue: 'Disconnect' })}
                onClick={() => onDisconnect(acc)}
              >
                <Unlink className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
          )}
        </Card>
        );
      })}
    </div>
  );
}
