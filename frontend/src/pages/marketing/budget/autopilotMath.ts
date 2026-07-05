import i18n from 'i18next';
import type { ActivityItem } from '../../../features/marketing/api/growthBudget.service';

/** Loose Decimal-string/number → number (backend serializes Prisma.Decimal as string). */
export const num = (s: string | number | null | undefined): number =>
  s == null ? 0 : typeof s === 'number' ? s : parseFloat(s) || 0;

/**
 * Money in the BUDGET'S currency, formatted for the ACTIVE i18n language —
 * replaces the old hard-coded `tr-TR` locale (a US workspace saw "₺30.000"
 * style formatting on USD budgets). Same singleton pattern as utils/format.ts.
 */
export function money(v: string | number | null | undefined, currency = 'TRY'): string {
  const locale = i18n.language || 'en';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(num(v));
  } catch {
    return `${num(v).toFixed(0)} ${currency}`;
  }
}

/** Per-channel signal snapshot recorded on every AutopilotRun (objective JSON). */
export interface RunObjective {
  totalBudget?: number;
  pool?: number;
  reserve?: number;
  channels?: Array<{ channel: string; avgRoas?: number; marginalRoas?: number }>;
}

export interface GrowthMultipleResult {
  /** Engine spend settled into the period's allocations (major units). */
  spend: number;
  /** Attributed revenue derived from the latest run's avgRoas per channel; null = no signal yet. */
  revenue: number | null;
  /** revenue ÷ spend; null until both sides are measurable. */
  multiple: number | null;
}

/**
 * Hero "Growth Multiple" (spec D15) = attributed revenue ÷ engine spend.
 * The budget detail endpoint carries no revenue column, so we DERIVE it:
 * every AutopilotRun snapshots each channel's avgRoas (CRM-reconciled
 * AdMetric revenue ÷ spend over the allocator window). Multiplying each
 * channel's settled spend by its latest avgRoas reconstructs attributed
 * revenue from what the API already exposes. Honest fallback: no run signal
 * or no spend → null (render "—", never a fabricated 0.00×).
 */
export function deriveGrowthMultiple(
  allocations: Array<{ channel: string; spentAmount: string | number | null }>,
  objective: RunObjective | null | undefined,
): GrowthMultipleResult {
  const spend = allocations.reduce((s, a) => s + num(a.spentAmount), 0);
  const channels = objective?.channels;
  if (!channels?.length) return { spend, revenue: null, multiple: null };

  const roasByChannel = new Map(channels.map((c) => [c.channel, c.avgRoas ?? 0]));
  const revenue = allocations.reduce(
    (s, a) => s + num(a.spentAmount) * (roasByChannel.get(a.channel) ?? 0),
    0,
  );
  return { spend, revenue, multiple: spend > 0 ? revenue / spend : null };
}

/** Newest RUN activity item that carries per-channel signal (feed is time-desc). */
export function pickLatestObjective(items: ActivityItem[] | undefined): RunObjective | null {
  for (const item of items ?? []) {
    if (item.type !== 'RUN') continue;
    const objective = (item.data as { objective?: RunObjective | null }).objective;
    if (objective?.channels?.length) return objective;
  }
  return null;
}

/**
 * Provider for a wallet top-up, by wallet currency (mirrors the billing page's
 * preference order: TRY→PayTR, otherwise Stripe).
 */
export function pickTopupProvider(currency: string): 'paytr' | 'stripe' {
  return currency === 'TRY' ? 'paytr' : 'stripe';
}
