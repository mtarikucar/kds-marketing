import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AppointmentsPage from './AppointmentsPage';
import * as bookingService from '../../../features/marketing/api/booking.service';

vi.mock('../../../features/marketing/api/booking.service', () => ({
  listCalendars: vi.fn(),
  listBookings: vi.fn(),
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  setBookingStatus: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PENDING = {
  id: 'b1', calendarId: 'c1', name: 'Ada Lovelace', email: 'ada@x.com', phone: null, notes: null,
  startAt: '2027-06-14T09:00:00.000Z', endAt: '2027-06-14T09:30:00.000Z', status: 'PENDING',
  assigneeUserId: null, meetingUrl: 'https://meet.google.com/abc', conferenceProvider: 'GOOGLE_MEET',
  attendeeTimezone: null, token: 'bk',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AppointmentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (bookingService.listCalendars as any).mockResolvedValue([{ id: 'c1', name: 'Sales' }]);
    (bookingService.listBookings as any).mockResolvedValue([PENDING]);
    (bookingService.setBookingStatus as any).mockResolvedValue({ id: 'b1', status: 'CONFIRMED' });
  });

  it('renders booked appointments with the meeting link', async () => {
    render(<AppointmentsPage />, { wrapper });
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Meet')).toBeInTheDocument();
  });

  it('approves a pending appointment', async () => {
    render(<AppointmentsPage />, { wrapper });
    await screen.findByText('Ada Lovelace');
    await userEvent.click(screen.getByLabelText('Approve'));
    await waitFor(() =>
      expect(bookingService.setBookingStatus).toHaveBeenCalledWith('b1', 'CONFIRMED'),
    );
  });
});
