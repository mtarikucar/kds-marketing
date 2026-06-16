import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Badge,
  EmptyState,
  Skeleton,
} from '@/components/ui';
import type { Experiment, ExperimentResult } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  experiment: Experiment | null;
}

export function ExperimentResultsDialog({ open, onOpenChange, experiment }: Props) {
  const { t } = useTranslation('marketing');

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'experiments', experiment?.id, 'results'],
    enabled: open && !!experiment?.id,
    queryFn: () =>
      marketingApi.get(`/experiments/${experiment!.id}/results`).then((r) => r.data as ExperimentResult[]),
  });

  const results: ExperimentResult[] = Array.isArray(data) ? data : [];
  // Show a row per configured variant even when it has no events yet.
  const labelFor = (key: string) =>
    experiment?.variants?.find((v) => v.key === key)?.label || key;

  const merged: ExperimentResult[] = (experiment?.variants ?? []).map((v) => {
    const found = results.find((r) => r.variantKey === v.key);
    return found ?? { variantKey: v.key, impressions: 0, conversions: 0, conversionRate: 0 };
  });
  // Include any variantKeys present in results but no longer configured.
  for (const r of results) {
    if (!merged.some((m) => m.variantKey === r.variantKey)) merged.push(r);
  }

  const best = merged.reduce<ExperimentResult | null>((acc, r) => {
    if (r.impressions === 0) return acc;
    if (!acc || r.conversionRate > acc.conversionRate) return r;
    return acc;
  }, null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('experiments.resultsTitle', { defaultValue: 'Experiment results' })}
            {experiment ? ` — ${experiment.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {t('experiments.resultsDesc', {
              defaultValue: 'Impressions, conversions and conversion rate per variant.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : merged.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="h-10 w-10" />}
            title={t('experiments.resultsEmpty', { defaultValue: 'No data yet' })}
            description={t('experiments.resultsEmptyHint', {
              defaultValue: 'Results appear once the experiment is running and receiving traffic.',
            })}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t('experiments.variantLabel', { defaultValue: 'Variant' })}</TH>
                <TH numeric>{t('experiments.impressions', { defaultValue: 'Impressions' })}</TH>
                <TH numeric>{t('experiments.conversions', { defaultValue: 'Conversions' })}</TH>
                <TH numeric>{t('experiments.rate', { defaultValue: 'Rate' })}</TH>
              </TR>
            </THead>
            <TBody>
              {merged.map((r) => (
                <TR key={r.variantKey}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{labelFor(r.variantKey)}</span>
                      <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {r.variantKey}
                      </code>
                      {best && best.variantKey === r.variantKey && (
                        <Badge tone="success" size="sm">
                          {t('experiments.leading', { defaultValue: 'Leading' })}
                        </Badge>
                      )}
                    </div>
                  </TD>
                  <TD numeric>{r.impressions.toLocaleString()}</TD>
                  <TD numeric>{r.conversions.toLocaleString()}</TD>
                  <TD numeric className="font-medium">
                    {r.conversionRate}%
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', { defaultValue: 'Close' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
