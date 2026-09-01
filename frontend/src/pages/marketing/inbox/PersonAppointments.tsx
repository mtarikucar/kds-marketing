import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import { listBookings, type Booking } from '../../../features/marketing/api/booking.service';
import { fmtDateTime } from '../../../features/marketing/utils/format';

const statusTone: Record<string, BadgeProps['tone']> = {
  CONFIRMED: 'success',
  PENDING: 'warning',
  CANCELLED: 'danger',
  NO_SHOW: 'danger',
  COMPLETED: 'neutral',
  RESCHEDULED: 'neutral',
};

export interface PersonAppointmentsProps {
  /** Whose appointments. */
  leadId: string;
}

/**
 * UPCOMING FIRST, then the past most-recent first.
 *
 * The wire order is the appointments SCREEN's order — `booking.findMany` is
 * `startAt: 'asc'`, and it has to be: that screen is a schedule, read top to
 * bottom, and its 500-row cap is only safe because a rolling 24h `from`
 * keeps the window on what is current. The record card is the one caller
 * EXEMPT from that window (a card is a history), which is exactly what makes
 * the shared ascending order wrong here: a person seen four times last year
 * pushed the meeting on Thursday to the bottom of a section most readers
 * never scroll.
 *
 * So the reordering is the CARD's, done here rather than on the wire — the
 * screen's order is correct for the screen, and this is a handful of rows for
 * one person, nowhere near the cap.
 *
 * Not newest-first, which is the other obvious answer. That puts the most
 * DISTANT commitment on top and buries the next one under it, and the
 * question this section answers first is the component's own sentence: "when
 * are we meeting". Upcoming ascending puts the next meeting at line one; the
 * past follows it descending, so "did they turn up" is answered by the line
 * underneath rather than at the end of the list. A booking whose `startAt` is
 * unreadable sorts with the past, where a stale row belongs, instead of
 * claiming the top of the section.
 *
 * Pure, and returns a NEW array: `bookings` is React Query's cached object and
 * sorting it in place would reorder the cache under every other reader.
 */
export function orderForCard<T extends Pick<Booking, 'startAt'>>(
  bookings: readonly T[],
  now: number = Date.now(),
): T[] {
  const at = (b: T) => new Date(b.startAt).getTime();
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const b of bookings) {
    const t = at(b);
    (Number.isFinite(t) && t >= now ? upcoming : past).push(b);
  }
  upcoming.sort((a, b) => at(a) - at(b));
  past.sort((a, b) => at(b) - at(a));
  return [...upcoming, ...past];
}

/**
 * `RANDEVULAR` — the person's appointments, as a section of their record card.
 *
 * Mounted only while its disclosure is open (see `RecordDisclosure`), so a rep
 * clicking through a queue never pays for this read.
 *
 * ## This component assumes it is allowed to read
 *
 * `MarketingBookingController` is `@MarketingRoles('MANAGER')` +
 * `@RequiresFeature('funnels')`, and this component carries NO check of its
 * own — `LeadContextPane` decides whether the section exists at all, because
 * the gate belongs next to the affordance. A REP must never see a Randevular
 * heading to click; clicking one and getting a 403 is a permission answer
 * dressed up as "Randevular yüklenemedi." with a Retry that cannot succeed.
 * Anyone mounting this from a second place owes the same two gates.
 *
 * The read is deliberately NOT the appointments screen's: `GET
 * /calendars/bookings?leadId=` is exempt from that screen's rolling 24h window,
 * because a record card is a HISTORY. Showing only what is still ahead would
 * make "no appointments" the answer for someone who was seen last week — the
 * worst possible thing to tell a rep about to call them.
 *
 * Rescheduling, cancelling and marking a no-show stay on `/appointments`, which
 * is untouched: those actions need the calendar's own availability grid to
 * validate a new slot, and a second slot picker in a 26%-wide column would be a
 * second implementation of that validation. The card answers "when are we
 * meeting, and did they turn up".
 */
export function PersonAppointments({ leadId }: PersonAppointmentsProps) {
  const { t } = useTranslation('marketing');

  const query = useQuery({
    queryKey: ['marketing', 'appointments', 'lead', leadId],
    queryFn: () => listBookings({ leadId }),
  });

  // `query.data` is a stable reference between renders, so the ordering is paid
  // for once per fetch rather than on every keystroke elsewhere in the card.
  const bookings = useMemo(() => orderForCard(query.data ?? []), [query.data]);

  return (
    <QueryStateBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      onRetry={() => query.refetch()}
      errorMessage={t('surface.appointments.failed', 'Randevular yüklenemedi.')}
      retryLabel={t('common.retry', 'Tekrar dene')}
      loading={<Skeleton className="h-12 rounded-md" />}
      className="py-4"
    >
      {bookings.length > 0 ? (
        <ul className="space-y-2">
          {bookings.map((b) => (
            <li
              key={b.id}
              data-testid={`appointment-${b.id}`}
              className="space-y-1 rounded-md border border-border p-2"
            >
              <p className="truncate text-xs font-medium text-foreground">{b.name}</p>
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{fmtDateTime(b.startAt)}</span>
                <Badge tone={statusTone[b.status] ?? 'neutral'} size="sm">
                  {b.status}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        // A settled, successful, EMPTY answer — never the same screen as the
        // boundary's failure sentence above.
        <p data-testid="appointments-empty" className="text-[11px] text-muted-foreground">
          {t('surface.appointments.none', 'Bu kişinin randevusu yok.')}
        </p>
      )}
    </QueryStateBoundary>
  );
}
