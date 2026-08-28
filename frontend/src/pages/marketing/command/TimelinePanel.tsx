import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  getHomeTimeline,
  type TimelineItem,
} from '../../../features/marketing/api/homeTimeline.service';
import { fmtSlot } from '../../../features/marketing/utils/format';

/**
 * How loudly a row is drawn. `system` rows are the agent's own scheduled jobs:
 * machine work has to be visible (that is half the point of a home screen you
 * can trust without asking), but four sources at equal weight buries the two
 * rows a human actually has to act on.
 */
type RowWeight = 'recessive' | 'normal';

const rowWeight = (i: TimelineItem): RowWeight => (i.kind === 'system' ? 'recessive' : 'normal');

/**
 * The weight, rendered. Keyed by RowWeight rather than re-deciding `kind` at
 * the class site, because the row publishes its weight as `data-weight` and
 * that attribute is what tests hold this rule to. Two independent ternaries on
 * `kind` — which is what this was — let the styling be collapsed to one class
 * list with the attribute left intact: a row that REPORTS it is recessive and
 * is drawn at full weight, passing every test. One expression feeds both, so
 * they cannot disagree.
 */
const ROW_CLASS: Record<RowWeight, string> = {
  recessive: 'flex items-baseline gap-2 py-1 text-xs text-muted-foreground opacity-60',
  normal: 'flex items-baseline gap-2 py-1.5 text-sm text-foreground',
};

const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  system: 'sistem',
  task: 'görev',
  appointment: 'randevu',
  campaign: 'kampanya',
};

/**
 * What is coming, on one axis: the agent's scheduled jobs alongside the
 * operator's own tasks, bookings and campaigns.
 *
 * Two deliberate choices:
 *
 * 1. `system` rows are recessive — dimmer and smaller. See `rowWeight` /
 *    `ROW_CLASS` above for why that decision is made in one place.
 *
 * 2. `unread` and `truncated` are rendered as two separate lines. The backend
 *    keeps them apart on purpose — "could not read this source" means rows are
 *    missing and we cannot say how many, "read it, there was more" means the
 *    list is capped at the earliest of them. Folding both into one "list may be
 *    incomplete" would hide a broken query behind a busy week, which is exactly
 *    the silence the per-source reads exist to break.
 */
export function TimelinePanel() {
  const { t } = useTranslation('marketing');
  const q = useQuery({
    queryKey: ['marketing', 'home', 'timeline'],
    queryFn: getHomeTimeline,
    // The window starts at `now`, so a tab left open all morning would
    // otherwise keep showing a calendar that starts before breakfast.
    refetchInterval: 60_000,
  });

  const items = q.data?.items ?? [];
  const unread = q.data?.unread ?? [];
  const truncated = q.data?.truncated ?? [];

  return (
    <QueryStateBoundary
      isLoading={q.isLoading}
      isError={q.isError}
      onRetry={() => q.refetch()}
      errorMessage={t('timeline.failed', 'Takvim yüklenemedi.')}
    >
      <div className="flex flex-col">
        {unread.length > 0 && (
          <p data-testid="tl-unread" role="status" className="pb-1.5 text-xs text-warning">
            {t('timeline.unread', 'Okunamayan kaynaklar')}: {unread.join(', ')} —{' '}
            {t('timeline.unreadHint', 'bu listede eksik satırlar var, kaç tane olduğunu bilmiyoruz')}
          </p>
        )}
        {truncated.length > 0 && (
          <p data-testid="tl-truncated" role="status" className="pb-1.5 text-xs text-muted-foreground">
            {t('timeline.truncated', 'Sığmayan kaynaklar')}: {truncated.join(', ')} —{' '}
            {t('timeline.truncatedHint', 'bu pencerenin yalnızca en erken kayıtları gösteriliyor, devamı var')}
          </p>
        )}

        {items.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" />}
            title={t('timeline.none.title', 'Planlanmış bir şey yok')}
            description={t(
              'timeline.none.desc',
              'Bir görev, randevu ya da kampanya zamanlandığında burada görürsün.',
            )}
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => {
              const weight = rowWeight(i);
              return (
                <li
                  key={`${i.kind}-${i.id}`}
                  data-testid={`tl-${i.kind}-${i.id}`}
                  data-kind={i.kind}
                  // Both of the next two lines read the SAME `weight`. The class
                  // string stays Tailwind's to retune; what cannot happen is the
                  // attribute saying recessive while the row is drawn normal.
                  data-weight={weight}
                  className={ROW_CLASS[weight]}
                >
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtSlot(i.at)}</span>
                  <span className="truncate">{i.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {KIND_LABEL[i.kind]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </QueryStateBoundary>
  );
}
