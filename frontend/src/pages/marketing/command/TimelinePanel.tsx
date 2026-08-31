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
  // `null` means the backend could not read the queue — and it already said so
  // by name in `unread`. Rendering our own line here would either repeat that
  // or, worse, dress a failed read up as a count.
  const research = q.data?.research ?? null;
  const waitingDays =
    research?.oldestPendingAgeHours != null
      ? Math.floor(research.oldestPendingAgeHours / 24)
      : null;
  // A lease is thirty minutes by default, so minutes is the unit that carries
  // information — until it does not. Past an hour the count is no longer a
  // working client but a row the sweep has not reached, and "1560 dakika" makes
  // the reader do the division to find that out.
  const heldMinutes = research?.oldestClaimedAgeMinutes ?? null;
  const heldHours = heldMinutes != null && heldMinutes >= 60 ? Math.floor(heldMinutes / 60) : null;
  // Read through optional chaining even though the type says it is always
  // there. During a rolling deploy this page can be served the PREVIOUS
  // backend's payload, which has no `takenOver` at all — and a home screen that
  // white-screens on a field it merely wanted to mention is a worse outage than
  // the silence this field exists to break.
  const takenOver = research?.takenOver ?? null;
  // A takeover we could not price prints no NUMBER — `0,00 $` would read as "it
  // was free", which is the one thing we know it was not, and the whole reason
  // the backend records `null` rather than a zero. Two decimals because these
  // are cents: a week of takeovers is well under a dollar.
  //
  // But it does not print SILENCE either. A bare "3 gece" is indistinguishable
  // from a takeover that genuinely cost nothing, and this panel refuses that
  // trade everywhere else — `unread` names the sources it could not read
  // instead of shortening the list, `truncated` says there is more. The
  // unpriced case says so in words for the same reason.
  const takenOverCost = takenOver?.costUsd != null ? takenOver.costUsd.toFixed(2) : null;

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

        {research && research.pending > 0 && (
          <p data-testid="tl-research-waiting" role="status" className="pb-1.5 text-xs text-warning">
            {research.pending}{' '}
            {research.mode === 'MCP'
              ? t('timeline.researchWaitingMcp', "araştırma işi senin Claude'unu bekliyor")
              : t('timeline.researchWaitingServer', 'araştırma işi kuyrukta bekliyor')}
            {research.oldestPendingAgeHours != null && (
              <>
                {' — '}
                {waitingDays != null && waitingDays >= 1 ? (
                  <>
                    {t('timeline.researchOldest', 'en eskisi')} {waitingDays}{' '}
                    {t('timeline.researchDays', 'gündür')}
                  </>
                ) : (
                  <>
                    {t('timeline.researchOldest', 'en eskisi')} {research.oldestPendingAgeHours}{' '}
                    {t('timeline.researchHours', 'saattir')}
                  </>
                )}
              </>
            )}
          </p>
        )}
        {/*
          HELD is its own line, never folded into the waiting count.
          `claimed` was computed by the backend and rendered nowhere, so a
          workspace whose only research job was held by a drainer that never
          came back showed a completely blank panel — indistinguishable from
          "research found nothing", and needing the opposite fix. The two
          numbers also have different owners: waiting means nobody is draining,
          held means somebody took it and has not come back.
        */}
        {research && research.claimed > 0 && (
          <p data-testid="tl-research-claimed" role="status" className="pb-1.5 text-xs text-warning">
            {research.claimed}{' '}
            {research.mode === 'MCP'
              ? t('timeline.researchHeldMcp', "araştırma işini şu an senin Claude'un tutuyor")
              : t(
                  'timeline.researchHeldServer',
                  "araştırma işi hâlâ Claude'unda kilitli — kirası dolunca kuyruğa geri döner",
                )}
            {heldMinutes != null && (
              <>
                {' — '}
                {heldHours != null ? (
                  <>
                    {t('timeline.researchHeldFor', 'kiralanalı')} {heldHours}{' '}
                    {t('timeline.researchHoursAgo', 'saat oldu')}
                  </>
                ) : (
                  <>
                    {t('timeline.researchHeldFor', 'kiralanalı')} {heldMinutes}{' '}
                    {t('timeline.researchMinutesAgo', 'dakika oldu')}
                  </>
                )}
              </>
            )}
          </p>
        )}
        {/*
          THE FALLBACK, SAID OUT LOUD.

          The platform takes back a research job the owner's Claude did not
          claim inside the grace window. That is what guarantees research never
          silently stops — and it is exactly why this line has to exist: a
          customer whose scheduled task died sees a completely healthy panel
          (no backlog, candidates arriving) while Jeeta quietly pays their model
          bill night after night. Without this the safety net IS the trap,
          approached from the other side.

          Three things, in order: that we ran it, what it cost us, and the one
          thing the reader can actually go and fix.
        */}
        {takenOver && takenOver.count > 0 && (
          <p data-testid="tl-research-takenover" role="status" className="pb-1.5 text-xs text-warning">
            {t('timeline.researchTakenOverLead', "Claude'un işi almadı, biz koşturduk")}
            {': '}
            {takenOver.count} {t('timeline.researchTakenOverNights', 'gece')}
            {takenOverCost != null ? (
              <>
                {' ('}
                {takenOver.costUnknown > 0 && (
                  <>{t('timeline.researchTakenOverAtLeast', 'en az')} </>
                )}
                {takenOverCost} $)
              </>
            ) : (
              <>
                {' ('}
                {t('timeline.researchTakenOverCostUnknown', 'maliyeti okunamadı')}
                {')'}
              </>
            )}
            {' — '}
            {t('timeline.researchTakenOverAsk', 'zamanlanmış görevin çalışıyor mu?')}
          </p>
        )}
        {research && research.pendingApprovals > 0 && (
          <p
            data-testid="tl-research-approvals"
            role="status"
            className="pb-1.5 text-xs text-muted-foreground"
          >
            {research.pendingApprovals}{' '}
            {t(
              'timeline.researchAwaitingApproval',
              'araştırma sonucu onayını bekliyor — onaylanana kadar hiçbir aday kaydedilmez',
            )}
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
