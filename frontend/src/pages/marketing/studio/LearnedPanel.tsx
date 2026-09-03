import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Compass } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { getAnglePerformance, type AngleStat } from '../../../features/marketing/api/contentLine.service';

/**
 * WHAT THE LINE HAS LEARNED: which angles this brand's published content
 * actually earned engagement on, and which ones have not been measured enough
 * to say.
 *
 * Three states that must never be confused, because collapsing them is the bug
 * this repo keeps re-paying for (`.catch(() => 0)` in the morning briefing; the
 * Takvim view rendering nothing behind 126 green tests):
 *
 *   COLD    nothing has ever been published — there is no signal, and batches
 *           are being planned unbiased. Said out loud, not shown as zeroes.
 *   THIN    an angle exists but carries too few posts to rank. Shown, labelled,
 *           and never weighted.
 *   BROKEN  the query failed. Says so, with a retry — an empty panel here would
 *           read as "measured, and nothing worked".
 *
 * Ranking is by engagement RATE, not reach: reach is mostly a function of the
 * hour and the network, and an angle that reaches ten times as many people while
 * converting a tenth as well has not out-performed anything.
 */
export function LearnedPanel() {
  const { t } = useTranslation('marketing');
  const q = useQuery({
    queryKey: ['marketing', 'content-line', 'angles'],
    queryFn: getAnglePerformance,
    meta: { skipErrorToast: true },
  });

  return (
    <section aria-labelledby="learned-heading" className="space-y-2">
      <div className="flex items-center gap-2">
        <Compass className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 id="learned-heading" className="text-sm font-semibold">
          {t('contentLine.learned.title', 'Ne işe yaradı')}
        </h3>
      </div>

      <QueryStateBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        onRetry={() => void q.refetch()}
        errorMessage={t(
          'contentLine.learned.error',
          'Açı performansı okunamadı. Partiler aşağıda; yalnızca bu bölüm eksik.',
        )}
      >
        {q.data?.cold ? (
          <Callout tone="info">
            {t(
              'contentLine.learned.cold',
              'Henüz yayınlanmış içerik yok, ölçecek bir şey de yok. Partiler şimdilik tarafsız üretiliyor — hesaplar bağlanıp ilk gönderiler çıktığında burası kendiliğinden dolar.',
            )}
          </Callout>
        ) : (
          <ul className="space-y-1.5">
            {(q.data?.angles ?? []).map((a) => (
              <AngleRow key={a.angle} stat={a} />
            ))}
          </ul>
        )}
      </QueryStateBoundary>
    </section>
  );
}

function AngleRow({ stat }: { stat: AngleStat }) {
  const { t } = useTranslation('marketing');

  // `rate === null` means nothing was ever shown — unmeasurable, not zero. A bar
  // of width 0 would claim a measurement that was never taken.
  const pct = stat.rate === null ? null : Math.round(stat.rate * 100);

  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 truncate font-medium">{stat.angle}</span>

      {stat.insufficient || pct === null ? (
        <Badge tone="neutral">
          {t('contentLine.learned.thin', 'yeterli veri yok')}
        </Badge>
      ) : (
        <>
          <span
            className="h-1.5 rounded bg-primary"
            style={{ width: `${Math.max(4, Math.min(100, pct))}%` }}
            aria-hidden="true"
          />
          <span className="tabular-nums text-muted-foreground">%{pct}</span>
        </>
      )}

      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {t('contentLine.learned.posts', '{{count}} gönderi', { count: stat.posts })}
      </span>
    </li>
  );
}
