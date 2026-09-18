import { useTranslation } from 'react-i18next';
import type { AiUsageRow } from '@/features/marketing/api/aiUsageDashboard.service';
import { Badge } from '@/components/ui/Badge';
import { usageNumbers } from './usagePresentation';

export function AiUsageDetails({ row, unmeasured, unavailable }: { row?: AiUsageRow; unmeasured: boolean; unavailable: boolean }) {
  const { t, i18n } = useTranslation('marketing');
  const { number, money } = usageNumbers(i18n.language);
  if (unavailable) return <p className="text-sm text-muted-foreground">{t('aiModels.usage.unavailable', 'Usage is unavailable. Refresh to retry; settings are still available.')}</p>;
  return <div className="space-y-5">
    <p className="text-sm text-muted-foreground">{row?.kind === 'ENTRY'
      ? t('aiModels.usage.entryHint', 'This is a base-charge action. Model turn usage appears on its related action unless direct API usage was recorded here.')
      : t('aiModels.usage.missingHint', '— means unmeasured or unknown, never free. MCP, local hosting and external services may have separate costs. Recorded API history remains visible after provider changes.')}</p>
    <dl className="grid grid-cols-2 gap-3 text-sm">
      {[
        [t('aiModels.usage.calls', 'Calls / jobs'), number(unmeasured ? null : row?.calls)],
        [t('aiModels.usage.estimatedCost', 'Estimated USD'), money(unmeasured ? null : row?.costUsd)],
        [t('aiModels.usage.input', 'Input tokens'), number(unmeasured ? null : row?.inputTokens)],
        [t('aiModels.usage.output', 'Output tokens'), number(unmeasured ? null : row?.outputTokens)],
        [t('aiModels.usage.cacheWrite', 'Cache write'), number(unmeasured ? null : row?.cacheWriteTokens)],
        [t('aiModels.usage.cacheRead', 'Cache read'), number(unmeasured ? null : row?.cacheReadTokens)],
        [t('aiModels.usage.averageTokens', 'Tokens / request'), number(unmeasured ? null : row?.averageTokens)],
        [row && row.unpricedCalls > 0 ? t('aiModels.usage.averageCostPriced', 'USD / priced request') : t('aiModels.usage.averageCost', 'USD / request'), money(unmeasured ? null : row?.averageCostUsd)],
        [t('aiModels.usage.webSearches', 'Native web searches'), number(unmeasured ? null : row?.webSearches)],
        [t('aiModels.usage.unpricedCalls', 'Unpriced calls'), number(row?.unpricedCalls)],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-surface-muted p-3"><dt className="text-caption text-muted-foreground">{label}</dt><dd className="mt-1 font-medium tabular-nums">{value}</dd></div>)}
    </dl>
    {row && <div className="space-y-1 text-sm">
      <h3 className="font-medium">{t('aiModels.usage.tariff', 'Credit tariff')}</h3>
      <p className="tabular-nums">{row.creditRate == null ? '—' : `${number(row.creditRate)} ${t(`aiModels.usage.creditUnits.${row.creditUnit}`, row.creditUnit)}`}</p>
      <p className="text-caption text-muted-foreground">{t('aiModels.usage.creditHint', 'Billing credits are separate from actual vendor USD costs. This tariff is a unit rate, not measured spending.')}</p>
    </div>}
    {!!row?.models.length && <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('aiModels.usage.recordedModels', 'Recorded models')}</h3>
      {row.models.map((model) => <div key={model.model} className="space-y-1 rounded-lg border border-border p-3 text-caption">
        <p className="break-all font-medium">{model.model}</p>
        <p className="tabular-nums">{t('aiModels.usage.modelUsage', '{{calls}} calls · {{tokens}} tokens · {{cost}} USD', { calls: number(model.calls), tokens: number(model.tokens), cost: money(model.costUsd) })}</p>
        {!model.priceKnown && <Badge size="sm" tone="warning">{t('aiModels.usage.unpriced', 'Price unknown')}</Badge>}
      </div>)}
    </div>}
  </div>;
}
