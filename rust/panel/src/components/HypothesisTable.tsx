import { useTranslation } from 'react-i18next';
import { ANY_CHANNEL, type Hypothesis, type Segment } from '@/api/types';
import { HypothesisStateBadge } from '@/components/StatusBadges';
import { EmptyState, Progress, TBody, TD, TH, THead, TR, Table, cn } from '@/components/ui';
import { kindLabel } from '@/lib/capabilities';

/** A hypothesis's channel as shown: `any` in words, a kind by its name. */
export function useChannelLabel(): (channel: string) => string {
  const { t } = useTranslation();
  return (channel: string) => (channel === ANY_CHANNEL ? t('strategy.anyChannel') : kindLabel(t, channel));
}

/** The hypotheses of a version, read-only: retired ones stay listed, dimmed. */
export function HypothesisTable({
  hypotheses,
  segments,
}: {
  hypotheses: readonly Hypothesis[];
  segments: readonly Segment[];
}) {
  const { t } = useTranslation();
  const channelLabel = useChannelLabel();
  if (hypotheses.length === 0) {
    return <EmptyState title={t('strategy.hypotheses.empty')} />;
  }
  const segmentName = (key: string) => segments.find((s) => s.key === key)?.name || key;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <Table>
        <THead>
          <TR>
            <TH>{t('strategy.hypotheses.columns.title')}</TH>
            <TH>{t('strategy.hypotheses.columns.segment')}</TH>
            <TH>{t('strategy.hypotheses.columns.angle')}</TH>
            <TH>{t('strategy.hypotheses.columns.channel')}</TH>
            <TH>{t('strategy.hypotheses.columns.metric')}</TH>
            <TH>{t('strategy.hypotheses.columns.confidence')}</TH>
            <TH>{t('strategy.hypotheses.columns.state')}</TH>
          </TR>
        </THead>
        <TBody>
          {hypotheses.map((h) => {
            const pct = Math.round((h.derived_confidence ?? h.prior_confidence) * 100);
            return (
              <TR key={h.id} className={cn(h.state === 'retired' && 'opacity-60')}>
                <TD className="font-medium text-foreground">{h.title}</TD>
                <TD>{segmentName(h.segment_key)}</TD>
                <TD>{h.angle}</TD>
                <TD>{channelLabel(h.channel)}</TD>
                <TD>{h.metric}</TD>
                <TD>
                  <div className="flex min-w-24 items-center gap-2">
                    <Progress value={pct} className="w-16" />
                    <span className="text-caption tabular-nums text-muted-foreground">{pct}%</span>
                  </div>
                </TD>
                <TD>
                  <HypothesisStateBadge state={h.state} />
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
