import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckIcon, CreditCardIcon, BanknotesIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

interface PackageRow {
  code: string;
  name: string;
  description?: string;
  dailyLeadQuota: number;
  maxUsers: number;
  maxResearchProfiles: number;
  features: Record<string, boolean>;
  priceMonthlyTRY: string;
  priceMonthlyUSD: string;
  priceYearlyTRY?: string | null;
  priceYearlyUSD?: string | null;
}

interface BankInstructions {
  iban: string;
  accountName: string;
  amountFormatted: string;
  reference: string;
}

const FEATURE_LABELS: Record<string, string> = {
  autoAssign: 'Auto lead assignment',
  telephony: 'Click-to-call',
  installations: 'Field installations',
  commissions: 'Commission tracking',
  advancedReports: 'Advanced reports',
  apiAccess: 'API access (ingest tokens)',
  conversationAi: 'Conversation AI (auto-reply)',
  workflows: 'Workflow automation',
  campaigns: 'Email & SMS campaigns',
  funnels: 'Funnels, forms & booking',
  reviews: 'Reviews & reputation',
  askAi: 'Ask-AI assistant',
  agentStudio: 'AI Agent Studio',
  voiceAi: 'Voice AI receptionist',
  invoicing: 'Customer invoicing',
};

/**
 * Billing: current plan + usage, the package matrix, provider choice
 * (PayTR iframe / Stripe redirect / bank transfer instructions) and order
 * history. Reading is open to the team; buying is OWNER-only.
 */
export default function BillingPage() {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const queryClient = useQueryClient();
  const isOwner = user?.role === 'OWNER';

  const [cycle, setCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [bank, setBank] = useState<BankInstructions | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);

  const { data: summary } = useQuery({
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

  const currency: 'TRY' | 'USD' = summary?.currency === 'TRY' ? 'TRY' : 'USD';
  const providers: string[] = summary?.providers ?? [];

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
        window.location.href = handle.url;
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

  const price = (p: PackageRow) => {
    const v =
      cycle === 'YEARLY'
        ? currency === 'TRY'
          ? p.priceYearlyTRY
          : p.priceYearlyUSD
        : currency === 'TRY'
          ? p.priceMonthlyTRY
          : p.priceMonthlyUSD;
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return currency === 'TRY' ? `₺${n.toLocaleString('tr-TR')}` : `$${n.toLocaleString('en-US')}`;
  };

  const sub = summary?.subscription;
  const ent = summary?.entitlements;
  const quotaPct =
    usage && usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const aiPct =
    aiUsage && aiUsage.limit > 0
      ? Math.min(100, Math.round((aiUsage.used / aiUsage.limit) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('billing.title', 'Billing & Packages')}</h1>
        <p className="text-sm text-slate-500">
          {t('billing.subtitle', 'Your plan decides how many leads the research agent delivers every day.')}
        </p>
      </div>

      {/* Current plan + usage */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('billing.currentPlan', 'Current plan')}</div>
          <div className="text-xl font-bold text-slate-900 mt-1">
            {sub?.packageName ?? t('billing.noPlan', 'No plan')}
          </div>
          <div className="text-sm mt-1">
            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
              sub?.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700'
              : sub?.status === 'TRIALING' ? 'bg-blue-50 text-blue-700'
              : sub?.status === 'PAST_DUE' ? 'bg-amber-50 text-amber-700'
              : 'bg-slate-100 text-slate-500'
            }`}>
              {sub?.status ?? '—'}
            </span>
            {sub?.status === 'TRIALING' && sub.trialEndsAt && (
              <span className="ml-2 text-xs text-slate-400">
                {t('billing.trialEnds', 'trial ends')} {new Date(sub.trialEndsAt).toLocaleDateString()}
              </span>
            )}
            {sub?.status === 'ACTIVE' && sub.currentPeriodEnd && (
              <span className="ml-2 text-xs text-slate-400">
                {t('billing.renews', 'renews')} {new Date(sub.currentPeriodEnd).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('research.quotaToday', "Today's lead quota")}</div>
          <div className="text-xl font-bold text-slate-900 mt-1">
            {usage ? (usage.limit === -1 ? `${usage.used} / ∞` : `${usage.used} / ${usage.limit}`) : '…'}
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
            <div className={`h-full ${quotaPct >= 100 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: usage?.limit === -1 ? '8%' : `${quotaPct}%` }} />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('billing.aiCredits', 'AI credits this month')}</div>
          <div className="text-xl font-bold text-slate-900 mt-1">
            {aiUsage ? (aiUsage.limit === -1 ? `${aiUsage.used} / ∞` : `${aiUsage.used} / ${aiUsage.limit}`) : '…'}
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-2">
            <div className={`h-full ${aiPct >= 100 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: aiUsage?.limit === -1 ? '8%' : `${aiPct}%` }} />
          </div>
          <p className="text-xs text-slate-400 mt-2">{t('billing.aiCreditsHint', 'Resets monthly. Add a boost below to raise the cap.')}</p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('billing.limits', 'Limits')}</div>
          <div className="text-sm text-slate-700 mt-2 space-y-1">
            <div>{t('billing.seats', 'Seats')}: <strong>{ent?.maxUsers === -1 ? '∞' : ent?.maxUsers ?? '—'}</strong></div>
            <div>{t('billing.profiles', 'Research profiles')}: <strong>{ent?.maxResearchProfiles === -1 ? '∞' : ent?.maxResearchProfiles ?? '—'}</strong></div>
            <div>{t('billing.agents', 'AI agents')}: <strong>{ent?.limits?.maxAgents === -1 ? '∞' : ent?.limits?.maxAgents ?? '—'}</strong></div>
            <div>{t('billing.knowledgeDocs', 'Knowledge docs')}: <strong>{ent?.limits?.maxKnowledgeDocs === -1 ? '∞' : ent?.limits?.maxKnowledgeDocs ?? '—'}</strong></div>
          </div>
        </div>
      </div>

      {/* PayTR iframe */}
      {iframeUrl && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <iframe src={iframeUrl} className="w-full min-h-[600px] rounded-lg" title="PayTR checkout" />
        </div>
      )}

      {/* Bank transfer instructions */}
      {bank && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-2">
          <h3 className="font-semibold text-amber-900 flex items-center gap-2">
            <BanknotesIcon className="w-5 h-5" />
            {t('billing.bankTitle', 'Bank transfer instructions')}
          </h3>
          <dl className="text-sm text-amber-900 space-y-1">
            <div className="flex justify-between"><dt>IBAN</dt><dd className="font-mono">{bank.iban}</dd></div>
            <div className="flex justify-between"><dt>{t('billing.accountName', 'Account name')}</dt><dd>{bank.accountName}</dd></div>
            <div className="flex justify-between"><dt>{t('billing.amount', 'Amount')}</dt><dd className="font-semibold">{bank.amountFormatted}</dd></div>
            <div className="flex justify-between"><dt>{t('billing.reference', 'Reference (required!)')}</dt><dd className="font-mono font-semibold">{bank.reference}</dd></div>
          </dl>
          <p className="text-xs text-amber-700">
            {t('billing.bankHint', 'Include the reference in the transfer description — your package activates as soon as our team matches the payment.')}
          </p>
        </div>
      )}

      {/* Package matrix */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{t('billing.packages', 'Packages')}</h2>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          <button onClick={() => setCycle('MONTHLY')} className={`px-3 py-1.5 ${cycle === 'MONTHLY' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>
            {t('billing.monthly', 'Monthly')}
          </button>
          <button onClick={() => setCycle('YEARLY')} className={`px-3 py-1.5 ${cycle === 'YEARLY' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>
            {t('billing.yearly', 'Yearly (2 months free)')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(packages ?? []).map((p) => {
          const isCurrent = sub?.packageCode === p.code;
          const popular = p.code === 'GROWTH';
          return (
            <div key={p.code} className={`bg-white rounded-xl border p-5 flex flex-col ${popular ? 'border-primary ring-1 ring-primary' : 'border-slate-200'}`}>
              {popular && (
                <span className="self-start text-xs px-2 py-0.5 rounded-full bg-primary text-primary-foreground mb-2">
                  {t('billing.popular', 'Most popular')}
                </span>
              )}
              <h3 className="font-bold text-slate-900">{p.name}</h3>
              <p className="text-xs text-slate-500 mt-1 min-h-8">{p.description}</p>
              <div className="my-3">
                <span className="text-2xl font-bold text-slate-900">{price(p) ?? '—'}</span>
                <span className="text-sm text-slate-400">/{cycle === 'YEARLY' ? t('billing.yr', 'yr') : t('billing.mo', 'mo')}</span>
              </div>
              <ul className="text-sm text-slate-600 space-y-1.5 flex-1">
                <li className="flex gap-2"><CheckIcon className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" /><strong>{p.dailyLeadQuota === -1 ? '∞' : p.dailyLeadQuota}</strong>&nbsp;{t('billing.leadsPerDay', 'AI-researched leads/day')}</li>
                <li className="flex gap-2"><CheckIcon className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />{p.maxUsers === -1 ? '∞' : p.maxUsers} {t('billing.seatsWord', 'seats')} · {p.maxResearchProfiles === -1 ? '∞' : p.maxResearchProfiles} {t('billing.profilesWord', 'profiles')}</li>
                {Object.entries(p.features).filter(([, v]) => v).map(([k]) => (
                  <li key={k} className="flex gap-2"><CheckIcon className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />{FEATURE_LABELS[k] ?? k}</li>
                ))}
              </ul>
              <button
                disabled={!isOwner || isCurrent || checkout.isPending}
                onClick={() => buy(p.code)}
                className={`mt-4 w-full py-2 rounded-lg text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'bg-slate-100 text-slate-400 cursor-default'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
                }`}
              >
                {isCurrent
                  ? t('billing.current', 'Current plan')
                  : isOwner
                    ? t('billing.choose', 'Choose')
                    : t('billing.ownerOnly', 'Owner only')}
              </button>
              {isOwner && !isCurrent && providers.includes('manual') && (
                <button
                  onClick={() => buy(p.code, 'manual')}
                  disabled={checkout.isPending}
                  className="mt-2 w-full py-1.5 rounded-lg text-xs text-slate-500 border border-slate-200 hover:bg-slate-50"
                >
                  <BanknotesIcon className="w-3.5 h-3.5 inline mr-1" />
                  {t('billing.payByTransfer', 'Pay by bank transfer')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add-on boosts */}
      {isOwner && sub?.packageCode && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-3">{t('billing.addons', 'Boosts')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-800 text-sm">+10 {t('billing.leadsPerDay', 'leads/day')}</div>
                <div className="text-xs text-slate-400">{currency === 'TRY' ? '₺2.690' : '$79'}/{t('billing.mo', 'mo')}</div>
              </div>
              <button onClick={() => checkout.mutate({ addOnCode: 'quota_boost_10', provider: pickProvider() ?? 'manual' })}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                {t('billing.buy', 'Buy')}
              </button>
            </div>
            <div className="border border-slate-200 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-800 text-sm">+1 {t('billing.profilesWord', 'research profile')}</div>
                <div className="text-xs text-slate-400">{currency === 'TRY' ? '₺1.690' : '$49'}/{t('billing.mo', 'mo')}</div>
              </div>
              <button onClick={() => checkout.mutate({ addOnCode: 'extra_profile', provider: pickProvider() ?? 'manual' })}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                {t('billing.buy', 'Buy')}
              </button>
            </div>
            <div className="border border-slate-200 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-800 text-sm">+500 {t('billing.aiCreditsWord', 'AI credits')}</div>
                <div className="text-xs text-slate-400">{currency === 'TRY' ? '₺290' : '$9'}/{t('billing.mo', 'mo')}</div>
              </div>
              <button onClick={() => checkout.mutate({ addOnCode: 'ai_credit_boost_500', provider: pickProvider() ?? 'manual' })}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                {t('billing.buy', 'Buy')}
              </button>
            </div>
            <div className="border border-slate-200 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-800 text-sm">+1000 {t('billing.messagesWord', 'messages')}</div>
                <div className="text-xs text-slate-400">{currency === 'TRY' ? '₺190' : '$6'}/{t('billing.mo', 'mo')}</div>
              </div>
              <button onClick={() => checkout.mutate({ addOnCode: 'messages_boost_1000', provider: pickProvider() ?? 'manual' })}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                {t('billing.buy', 'Buy')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Orders */}
      {isOwner && (orders?.length ?? 0) > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <CreditCardIcon className="w-5 h-5 text-slate-400" />
            {t('billing.orders', 'Payment history')}
          </h2>
          <div className="divide-y divide-slate-100 text-sm">
            {orders.map((o: any) => (
              <div key={o.id} className="py-2 flex items-center justify-between gap-3">
                <div>
                  <span className="text-slate-700">{o.type}</span>
                  {o.providerRef && <span className="ml-2 text-xs font-mono text-slate-400">{o.providerRef}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-slate-600">{Number(o.amount).toLocaleString()} {o.currency}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    o.status === 'SUCCEEDED' ? 'bg-emerald-50 text-emerald-700'
                    : o.status === 'AWAITING_TRANSFER' ? 'bg-amber-50 text-amber-700'
                    : o.status === 'FAILED' ? 'bg-red-50 text-red-600'
                    : 'bg-slate-100 text-slate-500'
                  }`}>{o.status}</span>
                  <span className="text-xs text-slate-400">{new Date(o.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
