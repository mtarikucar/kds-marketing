import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import type { LearningView, TypeView } from '../../../../features/marketing/api/contentProgramme.service';
import { WeightHistory } from './WeightHistory';

export const PHASE_TONE: Record<string, BadgeProps['tone']> = {
  SEED: 'neutral',
  LEARN: 'info',
  EXPLOIT: 'primary',
};

/** Phase labels, once, for the strip and this tab. */
export function usePhaseLabels() {
  const { t } = useTranslation('marketing');
  return {
    label: (phase: string) =>
      ({
        SEED: t('studio.programme.phase.SEED', 'Tohum'),
        LEARN: t('studio.programme.phase.LEARN', 'Öğreniyor'),
        EXPLOIT: t('studio.programme.phase.EXPLOIT', 'Kazananlara'),
      })[phase] ?? phase,
    explain: (phase: string) =>
      ({
        SEED: t(
          'studio.programme.phaseHint.SEED',
          'Tohum: her tür sırayla denenir, ağırlık yok. Yeterli ölçüm birikince öğrenmeye geçer.',
        ),
        LEARN: t(
          'studio.programme.phaseHint.LEARN',
          'Öğreniyor: türler ödüle göre örneklenir (Thompson); keşif payı korunur.',
        ),
        EXPLOIT: t(
          'studio.programme.phaseHint.EXPLOIT',
          'Kazananlara: en iyi tür açık ara önde; ağırlık ona kayar, keşif hiç sıfırlanmaz.',
        ),
      })[phase] ?? phase,
  };
}

export interface LearningPanelProps {
  learning: LearningView;
  types: TypeView[];
}

/**
 * What the engine believes, per type and per network, and how that belief
 * moved over the last twelve reweights.
 *
 * 'ALL' is the row the selector actually samples from (networks are pooled,
 * weighted by account count); the per-network rows are there so an owner can
 * see that a type which is winning overall is losing on one network — the
 * kind of thing the pooled number hides by construction.
 */
export function LearningPanel({ learning, types }: LearningPanelProps) {
  const { t, i18n } = useTranslation('marketing');
  const { label, explain } = usePhaseLabels();
  const names = Object.fromEntries(types.map((ty) => [ty.key, ty.name]));
  const typeName = (k: string) => names[k] ?? k;
  const rows = [...learning.rows].sort((a, b) => {
    if (a.network !== b.network) return a.network === 'ALL' ? -1 : b.network === 'ALL' ? 1 : a.network.localeCompare(b.network);
    return b.weight - a.weight;
  });

  return (
    <div className="flex flex-col gap-4" data-testid="programme-learning">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={PHASE_TONE[learning.phase] ?? 'neutral'}>{label(learning.phase)}</Badge>
        <span className="text-xs text-muted-foreground">{explain(learning.phase)}</span>
        <span className="ms-auto text-xs text-muted-foreground" data-testid="programme-last-reweighted">
          {learning.lastReweightedAt
            ? t('studio.programme.learning.lastReweighted', 'Son yeniden ağırlıklandırma: {{when}}', {
                when: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
                  new Date(learning.lastReweightedAt),
                ),
              })
            : t('studio.programme.learning.neverReweighted', 'Henüz yeniden ağırlıklandırılmadı.')}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <div className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('studio.programme.learning.noRows', 'Ölçülmüş slot yok; ilk yayınlar olgunlaşınca tablo dolar.')}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t('studio.programme.learning.type', 'Tür')}</TH>
                  <TH>{t('studio.programme.learning.network', 'Ağ')}</TH>
                  <TH numeric>{t('studio.programme.learning.samples', 'Örnek')}</TH>
                  <TH numeric>{t('studio.programme.learning.meanReward', 'Ort. ödül')}</TH>
                  <TH numeric>{t('studio.programme.learning.weight', 'Ağırlık')}</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={`${r.typeKey}:${r.network}`} data-testid="programme-learning-row">
                    <TD>{typeName(r.typeKey)}</TD>
                    <TD>
                      {r.network === 'ALL' ? (
                        <Badge tone="primary" size="sm">
                          {t('studio.programme.learning.allNetworks', 'Tümü')}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{r.network}</span>
                      )}
                    </TD>
                    <TD numeric>{r.samples}</TD>
                    <TD numeric>{r.meanReward.toFixed(2)}</TD>
                    <TD numeric>
                      <span className="inline-flex items-center gap-2">
                        <span className="h-1.5 w-16 rounded-full bg-border" aria-hidden="true">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.round(Math.min(1, Math.max(0, r.weight)) * 100)}%` }}
                          />
                        </span>
                        {r.weight.toFixed(2)}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <WeightHistory history={learning.history} names={names} />
      </div>
    </div>
  );
}

export default LearningPanel;
