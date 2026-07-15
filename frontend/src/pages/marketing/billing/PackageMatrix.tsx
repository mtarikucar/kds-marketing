/**
 * PackageMatrix — billing cycle toggle + package cards + "buy" actions.
 * Presentation only; all mutation logic lives in the parent and is passed in.
 */
import { useTranslation } from 'react-i18next';
import { Check, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

export interface PackageRow {
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

// Keep in lockstep with the backend's FEATURE_KEYS (entitlements.service.ts):
// public packages grant mediaGen/socialCampaigns/memberships/research too, so a
// missing label prints the raw camelCase key on the pricing card. The test pins
// full coverage so this can't silently drift.
export const FEATURE_LABELS: Record<string, string> = {
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
  mediaGen: 'AI media generation',
  socialCampaigns: 'Social campaigns',
  memberships: 'Memberships & courses',
  research: 'AI lead research',
};

interface Props {
  packages?: PackageRow[];
  currentPackageCode?: string;
  /** The subscription's ACTUAL billing cycle — so the same package on the OTHER
   *  cycle is not treated as the current plan (blocking a monthly→yearly switch). */
  currentBillingCycle?: 'MONTHLY' | 'YEARLY';
  currency: 'TRY' | 'USD';
  providers: string[];
  cycle: 'MONTHLY' | 'YEARLY';
  onCycleChange: (c: 'MONTHLY' | 'YEARLY') => void;
  isOwner: boolean;
  isPending: boolean;
  /** The package code currently being checked out, so only its button spins. */
  pendingCode?: string;
  onBuy: (packageCode: string, provider?: string) => void;
}

export function PackageMatrix({
  packages,
  currentPackageCode,
  currentBillingCycle,
  currency,
  providers,
  cycle,
  onCycleChange,
  isOwner,
  isPending,
  pendingCode,
  onBuy,
}: Props) {
  const { t } = useTranslation('marketing');

  const price = (p: PackageRow): string | null => {
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

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-h3 text-foreground">
          {t('billing.packages', 'Packages')}
        </h2>
        <SegmentedControl
          value={cycle}
          onChange={(v) => onCycleChange(v as 'MONTHLY' | 'YEARLY')}
          aria-label={t('billing.cycleToggle', 'Billing cycle')}
          options={[
            { value: 'MONTHLY', label: t('billing.monthly', 'Monthly') },
            { value: 'YEARLY', label: t('billing.yearly', 'Yearly (2 months free)') },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(packages ?? []).map((p) => {
          // Only "current" when BOTH the package AND the selected cycle match the
          // active subscription — otherwise the same plan on the other cycle
          // looked like the current plan and its button was disabled, so a monthly
          // subscriber could never switch to the yearly ("2 months free") version.
          const isCurrent =
            currentPackageCode === p.code && (!currentBillingCycle || currentBillingCycle === cycle);
          const popular = p.code === 'GROWTH';
          return (
            <div
              key={p.code}
              className={`flex flex-col rounded-xl border bg-surface p-5 shadow-sm ${
                popular ? 'border-primary ring-1 ring-primary' : 'border-border'
              }`}
            >
              {popular && (
                <Badge tone="primary" size="sm" className="mb-2 self-start">
                  {t('billing.popular', 'Most popular')}
                </Badge>
              )}
              <h3 className="font-display text-h3 text-foreground">{p.name}</h3>
              <p className="mt-1 min-h-8 text-xs text-muted-foreground">{p.description}</p>
              <div className="my-3">
                <span className="font-display text-h1 text-foreground">
                  {price(p) ?? '—'}
                </span>
                <span className="text-sm text-muted-foreground">
                  /{cycle === 'YEARLY' ? t('billing.yr', 'yr') : t('billing.mo', 'mo')}
                </span>
              </div>
              <ul className="flex-1 space-y-1.5 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <span>
                    <strong className="text-foreground">
                      {p.dailyLeadQuota === -1 ? '∞' : p.dailyLeadQuota}
                    </strong>{' '}
                    {t('billing.leadsPerDay', 'AI-researched leads/day')}
                  </span>
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <span>
                    {p.maxUsers === -1 ? '∞' : p.maxUsers} {t('billing.seatsWord', 'seats')} ·{' '}
                    {p.maxResearchProfiles === -1 ? '∞' : p.maxResearchProfiles}{' '}
                    {t('billing.profilesWord', 'profiles')}
                  </span>
                </li>
                {Object.entries(p.features)
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <li key={k} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                      {FEATURE_LABELS[k] ?? k}
                    </li>
                  ))}
              </ul>
              <Button
                className="mt-4 w-full"
                variant={isCurrent ? 'secondary' : 'primary'}
                disabled={!isOwner || isCurrent || isPending}
                loading={isPending && pendingCode === p.code}
                onClick={() => !isCurrent && onBuy(p.code)}
              >
                {isCurrent
                  ? t('billing.current', 'Current plan')
                  : isOwner
                    ? t('billing.choose', 'Choose')
                    : t('billing.ownerOnly', 'Owner only')}
              </Button>
              {isOwner && !isCurrent && providers.includes('manual') && (
                <Button
                  className="mt-2 w-full"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => onBuy(p.code, 'manual')}
                >
                  <Banknote className="h-3.5 w-3.5" aria-hidden />
                  {t('billing.payByTransfer', 'Pay by bank transfer')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
