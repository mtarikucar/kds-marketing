import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersonAppointments, orderForCard } from './PersonAppointments';
import type { Booking } from '../../../features/marketing/api/booking.service';

const listBookings = vi.fn();
vi.mock('../../../features/marketing/api/booking.service', () => ({
  listBookings: (...a: unknown[]) => listBookings(...a),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const booking = (over: Pick<Booking, 'id' | 'startAt'> & Partial<Booking>): Booking =>
  ({
    calendarId: 'c1',
    leadId: 'p1',
    name: `Randevu ${over.id}`,
    email: null,
    phone: null,
    notes: null,
    endAt: over.startAt,
    status: 'CONFIRMED',
    assigneeUserId: null,
    meetingUrl: null,
    conferenceProvider: null,
    attendeeTimezone: null,
    token: 'tok',
    ...over,
  }) as Booking;

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

/**
 * The order the record card shows a person's appointments in.
 *
 * The wire order belongs to the appointments SCREEN (`startAt: 'asc'`, so a
 * schedule reads top to bottom), and the card's `leadId` read is the one
 * deliberately exempt from that screen's rolling 24h window — it is a history.
 * Those two decisions together are what made the shared ascending order wrong
 * here: every past meeting sat ABOVE the next one, on the section whose first
 * question is "when are we meeting".
 */
describe('orderForCard — the next appointment is the first line', () => {
  const past2024 = booking({ id: 'p-2024', startAt: '2024-05-01T09:00:00.000Z' });
  const lastWeek = booking({ id: 'p-last-week', startAt: '2026-08-25T09:00:00.000Z' });
  const thursday = booking({ id: 'u-thursday', startAt: '2026-09-03T09:00:00.000Z' });
  const nextMonth = booking({ id: 'u-next-month', startAt: '2026-10-20T09:00:00.000Z' });

  it('puts what is ahead first, soonest first, then the past most-recent first', () => {
    // Handed in the wire's own ascending order, which is the order that is wrong.
    const ordered = orderForCard([past2024, lastWeek, thursday, nextMonth], NOW);
    expect(ordered.map((b) => b.id)).toEqual([
      'u-thursday',
      'u-next-month',
      'p-last-week',
      'p-2024',
    ]);
  });

  it('is not newest-first: the far commitment never displaces the near one', () => {
    // The distinguishing case between the two candidate orders. Newest-first
    // would answer 'u-next-month'.
    expect(orderForCard([thursday, nextMonth], NOW)[0].id).toBe('u-thursday');
  });

  it('leaves a person with only history in most-recent-first order', () => {
    expect(orderForCard([past2024, lastWeek], NOW).map((b) => b.id)).toEqual([
      'p-last-week',
      'p-2024',
    ]);
  });

  it('sorts an unreadable startAt with the past, never onto the top line', () => {
    const broken = booking({ id: 'broken', startAt: 'not-a-date' });
    const ordered = orderForCard([broken, thursday, lastWeek], NOW);
    expect(ordered[0].id).toBe('u-thursday');
    expect(ordered.map((b) => b.id)).toContain('broken');
    expect(ordered).toHaveLength(3);
  });

  it('returns a new array and leaves the caller’s (React Query’s) untouched', () => {
    const cached = [past2024, thursday];
    const ordered = orderForCard(cached, NOW);
    expect(ordered).not.toBe(cached);
    // The cache is shared with every other reader of this key; reordering it in
    // place would reorder their list too.
    expect(cached.map((b) => b.id)).toEqual(['p-2024', 'u-thursday']);
  });
});

/** The same rule, through the component, in the DOM order a reader sees. */
describe('PersonAppointments', () => {
  beforeEach(() => {
    listBookings.mockReset();
    // The clock, pinned WITHOUT fake timers: `orderForCard` reads `Date.now()`
    // and nothing else here does, so stubbing the one call keeps the split
    // between past and upcoming deterministic while React Query, `waitFor` and
    // React's own scheduler keep running on real time.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function wrap(node: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
  }

  it('renders the upcoming appointment above the one that already happened', async () => {
    listBookings.mockResolvedValue([
      booking({ id: 'old', name: 'Geçen haftaki görüşme', startAt: '2026-08-25T09:00:00.000Z' }),
      booking({ id: 'next', name: 'Perşembe toplantısı', startAt: '2026-09-03T09:00:00.000Z' }),
    ]);

    render(wrap(<PersonAppointments leadId="p1" />));

    // Positive anchor: both rows really rendered before anything is said about
    // their order.
    await waitFor(() => {
      expect(screen.getByTestId('appointment-next')).toBeInTheDocument();
      expect(screen.getByTestId('appointment-old')).toBeInTheDocument();
    });

    const rendered = Array.from(document.querySelectorAll('[data-testid^="appointment-"]')).map(
      (li) => li.getAttribute('data-testid'),
    );
    expect(rendered).toEqual(['appointment-next', 'appointment-old']);
    expect(listBookings).toHaveBeenCalledWith({ leadId: 'p1' });
  });
});
