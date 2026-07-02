/**
 * BillingPage — Console migration (Phase 4, Task 4).
 *
 * Preserved verbatim:
 *   - useQuery(['marketing','billing','summary'])
 *   - useQuery(['marketing','billing','packages'])
 *   - useQuery(['marketing','research','usage'])
 *   - useQuery(['marketing','ai','usage'], { refetchInterval: 60_000 })
 *   - useQuery(['marketing','billing','orders'], { enabled: isOwner })
 *   - checkout mutation → POST /billing/checkout with { packageCode/addOnCode, provider, billingCycle }
 *   - checkout onSuccess handle: redirect / iframe / bank_transfer + invalidateQueries billing
 *   - pickProvider() TRY→paytr / USD→stripe / manual fallback logic
 *   - buy() / price() helpers unchanged
 *   - PayTR iframe sandbox allowlist (exact attributes)
 *   - isOwner = user?.role === 'OWNER'
 *   - currency derived from summary.currency
 *   - i18n keys
 *
 * Presentation upgrade:
 *   - PageHeader
 *   - BillingSummaryCards (StatCard-style plan / quota / AI / limits)
 *   - PackageMatrix (cycle toggle + package cards + buy buttons)
 *   - Callout for error + bank transfer instructions
 *   - Card for PayTR iframe
 *   - Card for add-on boosts (owner-only)
 *   - Card + Table for order history (owner-only)
 *   - Tokens everywhere; dark-mode-safe; lucide icons
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CreditCard, Banknote } from 'lucide-react';
import marketingApi from '@/features/marketing/api/marketingApi';
import { navigateExternal } from '@/lib/navigateExternal';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { QueryStateBoundary } from '@/components/ui';
import { BillingSummaryCards } from './BillingSummaryCards';
import { PackageMatrix } from './PackageMatrix';
import type { PackageRow } from './PackageMatrix';

interface BankInstructions {
  iban: string;
  accountName: string;
  amountFormatted: string;
  reference: string;
}

function orderStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'AWAITING_TRANSFER') return 'warning';
  if (status === 'FAILED') return 'danger';
  return 'neutral';
}

export default function BillingPage() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const queryClient = useQueryClient();
  const isOwner = user?.role === 'OWNER';

  const [cycle, setCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [bank, setBank] = useState<BankInstructions | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: ['marketing', 'billing', 'summary'],
    queryFn: () => marketingApi.get('/billing/summary').then((r) => r.data),
  });
  const { data: packages } = useQuery<PackageRow[]>({
    queryKey: ['marketing', 'billing', 'packages'],
    queryFn: () => marketingApi.get('/billing/packages').then((r) => r.data),
  });
  const { data: usage } = useQuery({
    queryKey: ['marketing', 'research', 'usage'],
    queryFn: () => marketingApi.get('/research/usage').then((r) => r.data),
  });
  const { data: aiUsage } = useQuery({
    queryKey: ['marketing', 'ai', 'usage'],
    queryFn: () => marketingApi.get('/ai/usage').then((r) => r.data),
    refetchInterval: 60_000,
  });
  const { data: orders } = useQuery({
    queryKey: ['marketing', 'billing', 'orders'],
    queryFn: () => marketingApi.get('/billing/orders').then((r) => r.data),
    enabled: isOwner,
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const currency: 'TRY' | 'USD' = summary?.currency === 'TRY' ? 'TRY' : 'USD';
  const providers: string[] = summary?.providers ?? [];
  const sub = summary?.subscription;
  const ent = summary?.entitlements;

  // ── Mutations ──────────────────────────────────────────────────────────────
  const checkout = useMutation({
    mutationFn: (input: {
      packageCode?: string;
      addOnCode?: string;
      provider: string;
    }) =>
      marketingApi.post('/billing/checkout', { ...input, billingCycle: cycle }),
    onSuccess: ({ data }) => {
      const handle = data.handle;
      if (handle.kind === 'redirect') {
        navigateExternal(handle.url);
      } else if (handle.kind === 'iframe') {
        setIframeUrl(handle.iframeUrl);
      } else if (handle.kind === 'bank_transfer') {
        setBank(handle.instructions);
      }
      queryClient.invalidateQueries({ queryKey: ['marketing', 'billing'] });
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('billing.checkoutFailed', 'Checkout failed')),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const pickProvider = (): string | null => {
    // TRY → paytr first, USD → stripe first; manual is the universal fallback.
    const preferred = currency === 'TRY' ? 'paytr' : 'stripe';
    if (providers.includes(preferred)) return preferred;
    if (providers.includes('manual')) return 'manual';
    return providers[0] ?? null;
  };

  const buy = (packageCode: string, provider?: string) => {
    const chosen = provider ?? pickProvider();
    if (!chosen) {
      toast.error(t('billing.noProviders', 'No payment method is configured — contact support'));
      return;
    }
    checkout.mutate({ packageCode, provider: chosen });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('billing.title', 'Billing & Packages')}
        description={t(
          'billing.subtitle',
          'Your plan decides how many leads the research agent delivers every day.',
        )}
      />

      {/* Summary fetch error */}
      <QueryStateBoundary
        isError={summaryError && !summaryLoading}
        onRetry={() => refetchSummary()}
        errorMessage={t('billing.summaryFailed', 'Could not load your billing summary.')}
        retryLabel={t('common.retry', 'Retry')}
      />

      {/* Current plan + usage stats */}
      <BillingSummaryCards
        sub={sub}
        ent={ent}
        usage={usage}
        aiUsage={aiUsage}
        summaryLoading={summaryLoading}
      />

      {/* PayTR iframe */}
      {iframeUrl && (
        <Card>
          <CardContent className="pt-5">
            {/* PayTR's 3DS step navigates the iframe to the bank's ACS page and
                needs scripts, same-origin, form posts and the ability to break
                out to the top window on completion — hence this exact sandbox
                allowlist. referrerPolicy keeps our URL (which may carry the order
                ref) out of the bank's Referer. Verify any change here against a
                real PayTR sandbox transaction before shipping. */}
            <iframe
              src={iframeUrl}
              className="w-full min-h-[600px] rounded-lg"
              title="PayTR checkout"
              sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation"
              referrerPolicy="no-referrer"
            />
          </CardContent>
        </Card>
      )}

      {/* Bank transfer instructions */}
      {bank && (
        <Callout
          tone="warning"
          icon={<Banknote className="h-5 w-5" aria-hidden />}
          title={t('billing.bankTitle', 'Bank transfer instructions')}
        >
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">IBAN</dt>
              <dd className="font-mono">{bank.iban}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {t('billing.accountName', 'Account name')}
              </dt>
              <dd>{bank.accountName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('billing.amount', 'Amount')}</dt>
              <dd className="font-semibold">{bank.amountFormatted}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {t('billing.reference', 'Reference (required!)')}
              </dt>
              <dd className="font-mono font-semibold">{bank.reference}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'billing.bankHint',
              'Include the reference in the transfer description — your package activates as soon as our team matches the payment.',
            )}
          </p>
        </Callout>
      )}

      {/* Package matrix */}
      <PackageMatrix
        packages={packages}
        currentPackageCode={sub?.packageCode}
        currency={currency}
        providers={providers}
        cycle={cycle}
        onCycleChange={setCycle}
        isOwner={isOwner}
        isPending={checkout.isPending}
        pendingCode={checkout.variables?.packageCode}
        onBuy={buy}
      />

      {/* Add-on boosts (owner-only, after subscribing) */}
      {isOwner && sub?.packageCode && (
        <Card>
          <CardHeader>
            <CardTitle>{t('billing.addons', 'Boosts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                {
                  code: 'quota_boost_10',
                  label: `+10 ${t('billing.leadsPerDay', 'leads/day')}`,
                  priceTRY: '₺2.690',
                  priceUSD: '$79',
                },
                {
                  code: 'extra_profile',
                  label: `+1 ${t('billing.profilesWord', 'research profile')}`,
                  priceTRY: '₺1.690',
                  priceUSD: '$49',
                },
                {
                  code: 'ai_credit_boost_500',
                  label: `+500 ${t('billing.aiCreditsWord', 'AI credits')}`,
                  priceTRY: '₺290',
                  priceUSD: '$9',
                },
                {
                  code: 'messages_boost_1000',
                  label: `+1000 ${t('billing.messagesWord', 'messages')}`,
                  priceTRY: '₺190',
                  priceUSD: '$6',
                },
              ].map((addon) => (
                <div
                  key={addon.code}
                  className="flex items-center justify-between rounded-lg border border-border p-4"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{addon.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {currency === 'TRY' ? addon.priceTRY : addon.priceUSD}/
                      {t('billing.mo', 'mo')}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={checkout.isPending}
                    onClick={() =>
                      checkout.mutate({
                        addOnCode: addon.code,
                        provider: pickProvider() ?? 'manual',
                      })
                    }
                  >
                    {t('billing.buy', 'Buy')}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Order history (owner-only) */}
      {isOwner && (orders?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" aria-hidden />
              {t('billing.orders', 'Payment history')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>{t('billing.orderType', 'Type')}</TH>
                    <TH className="hidden sm:table-cell">
                      {t('billing.orderRef', 'Reference')}
                    </TH>
                    <TH numeric>{t('billing.amount', 'Amount')}</TH>
                    <TH>{t('billing.orderStatus', 'Status')}</TH>
                    <TH className="hidden md:table-cell">{t('billing.orderDate', 'Date')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {orders.map((o: any) => (
                    <TR key={o.id}>
                      <TD className="font-medium text-foreground">{o.type}</TD>
                      <TD className="hidden sm:table-cell font-mono text-xs text-muted-foreground">
                        {o.providerRef ?? '—'}
                      </TD>
                      <TD numeric className="text-foreground">
                        {Number(o.amount).toLocaleString()} {o.currency}
                      </TD>
                      <TD>
                        <Badge tone={orderStatusTone(o.status)} size="sm">
                          {o.status}
                        </Badge>
                      </TD>
                      <TD className="hidden md:table-cell text-xs text-muted-foreground">
                        {new Date(o.createdAt).toLocaleDateString()}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
