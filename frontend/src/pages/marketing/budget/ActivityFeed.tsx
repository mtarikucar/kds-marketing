import { useTranslation } from 'react-i18next';
import { Activity, ArrowRightLeft, Coins, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import type { ActivityItem } from '../../../features/marketing/api/growthBudget.service';
import { money, num, type RunObjective } from './autopilotMath';

const CHANNEL_LABEL: Record<string, string> = {
  META: 'Meta', TIKTOK: 'TikTok', GOOGLE: 'Google', LINKEDIN: 'LinkedIn',
  CONTENT: 'Content', SMS: 'SMS', VOICE: 'Voice', WHATSAPP: 'WhatsApp',
};

interface RunData {
  kind?: string;
  autonomy?: string;
  ok?: boolean;
  objective?: RunObjective | null;
  before?: Array<{ channel: string; campaignRef?: string; budget: number }> | null;
  after?: Array<{ channel: string; campaignRef?: string; budget: number; deltaPct?: number; reason?: string }> | null;
}

interface SpendData {
  channel?: string;
  reason?: string;
  delta?: string | number;
  balanceAfter?: string | number;
}

interface WalletData {
  kind?: string;
  delta?: string | number;
  balanceAfter?: string | number;
  note?: string | null;
}

/**
 * Activity Log feed (spec D14) — the trust surface that replaces the approval
 * queue for autonomous budgets. Renders the merged {ts,type,data} feed in
 * plain language: RUN = what the autopilot moved and WHY (before→after per
 * channel + reason), SPEND = what the engine spent where, WALLET = every
 * credit movement. The user reads what happened; they are never asked.
 */
export function ActivityFeed({ items, currency }: { items: ActivityItem[]; currency: string }) {
  const { t } = useTranslation('marketing');

  if (!items.length) {
    return (
      <EmptyState
        icon={<Activity className="h-5 w-5" />}
        title={t('autopilot.activity.emptyTitle', 'No activity yet')}
        description={t('autopilot.activity.emptyDesc', 'Every decision, spend and credit movement the engine makes will be logged here in plain language.')}
      />
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <Card key={`${item.type}-${(item.data as { id?: string }).id ?? i}`}>
          <CardContent className="space-y-2 py-3">
            {item.type === 'RUN' && <RunRow data={item.data as RunData} currency={currency} />}
            {item.type === 'SPEND' && <SpendRow data={item.data as SpendData} currency={currency} />}
            {item.type === 'WALLET' && <WalletRow data={item.data as WalletData} currency={currency} />}
            <p className="text-xs text-muted-foreground">{fmtDateTime(item.ts)}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RunRow({ data, currency }: { data: RunData; currency: string }) {
  const { t } = useTranslation('marketing');
  const beforeBy = new Map(
    (data.before ?? []).map((b) => [`${b.channel}|${b.campaignRef ?? ''}`, b.budget]),
  );
  const changes = (data.after ?? []).filter((a) => {
    const before = beforeBy.get(`${a.channel}|${a.campaignRef ?? ''}`);
    return before != null && Math.abs(a.budget - before) >= 0.01;
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">
          {changes.length > 0
            ? t('autopilot.activity.run', 'Autopilot rebalanced the budget')
            : t('autopilot.activity.runNoop', 'Autopilot reviewed the budget — no change needed')}
        </span>
        {data.ok === false && <Badge tone="danger">{t('autopilot.activity.failed', 'Failed')}</Badge>}
      </div>
      {changes.map((c) => {
        const before = beforeBy.get(`${c.channel}|${c.campaignRef ?? ''}`) ?? 0;
        return (
          <div key={`${c.channel}-${c.campaignRef ?? ''}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-sm">
            <span className="font-medium">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
            <span className="flex items-center gap-2 tabular-nums">
              <span className="text-muted-foreground">{money(before, currency)}</span>
              <span aria-hidden>→</span>
              <span className="font-medium">{money(c.budget, currency)}</span>
              {c.reason && <span className="text-xs text-muted-foreground">{c.reason}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SpendRow({ data, currency }: { data: SpendData; currency: string }) {
  const { t } = useTranslation('marketing');
  const delta = num(data.delta);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">
          {delta < 0
            ? t('autopilot.activity.spend', 'Engine spend')
            : t('autopilot.activity.spendCredit', 'Spend credited back')}
        </span>
        {data.channel && <Badge tone="neutral">{CHANNEL_LABEL[data.channel] ?? data.channel}</Badge>}
      </div>
      <span className="text-sm tabular-nums">{money(Math.abs(delta), currency)}</span>
    </div>
  );
}

const WALLET_LABEL: Record<string, { key: string; fallback: string }> = {
  TOPUP: { key: 'autopilot.activity.walletTopup', fallback: 'Credit loaded' },
  ENGINE_SPEND: { key: 'autopilot.activity.walletSpend', fallback: 'Credit used by the engine' },
  AD_GOVERNOR: { key: 'autopilot.activity.walletGovernor', fallback: 'Ad spend committed (billed by your ad account)' },
  REFUND: { key: 'autopilot.activity.walletRefund', fallback: 'Credit refunded' },
  ADJUST: { key: 'autopilot.activity.walletAdjust', fallback: 'Credit adjusted' },
};

function WalletRow({ data, currency }: { data: WalletData; currency: string }) {
  const { t } = useTranslation('marketing');
  const label = WALLET_LABEL[data.kind ?? ''] ?? { key: 'autopilot.activity.walletMove', fallback: 'Credit movement' };
  const delta = num(data.delta);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">{t(label.key, label.fallback)}</span>
      </div>
      <span className={`text-sm tabular-nums ${delta >= 0 ? 'text-success' : ''}`}>
        {delta >= 0 ? '+' : '−'}{money(Math.abs(delta), currency)}
      </span>
    </div>
  );
}
