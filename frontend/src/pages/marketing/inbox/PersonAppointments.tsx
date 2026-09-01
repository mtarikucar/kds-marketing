import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import { listBookings } from '../../../features/marketing/api/booking.service';
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

  const bookings = query.data ?? [];

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
