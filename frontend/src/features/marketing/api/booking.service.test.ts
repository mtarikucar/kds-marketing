import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./marketingApi', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import marketingApi from './marketingApi';
import {
  listBookings,
  cancelBooking,
  rescheduleBooking,
  setBookingStatus,
  createBlackout,
} from './booking.service';

const api = marketingApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('booking.service (admin)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listBookings GETs /calendars/bookings with filters', async () => {
    api.get.mockResolvedValue({ data: [{ id: 'b1' }] });
    const res = await listBookings({ status: 'CONFIRMED', calendarId: 'c1' });
    expect(res).toEqual([{ id: 'b1' }]);
    expect(api.get).toHaveBeenCalledWith('/calendars/bookings', {
      params: { status: 'CONFIRMED', calendarId: 'c1' },
    });
  });

  it('cancelBooking POSTs the cancel path', async () => {
    api.post.mockResolvedValue({ data: { id: 'b1', status: 'CANCELLED' } });
    await cancelBooking('b1');
    expect(api.post).toHaveBeenCalledWith('/calendars/bookings/b1/cancel');
  });

  it('rescheduleBooking POSTs the new start', async () => {
    api.post.mockResolvedValue({ data: { id: 'b1', startAt: '2027-06-14T10:00:00Z' } });
    await rescheduleBooking('b1', '2027-06-14T10:00:00Z');
    expect(api.post).toHaveBeenCalledWith('/calendars/bookings/b1/reschedule', {
      start: '2027-06-14T10:00:00Z',
    });
  });

  it('setBookingStatus PATCHes the status', async () => {
    api.patch.mockResolvedValue({ data: { id: 'b1', status: 'NO_SHOW' } });
    await setBookingStatus('b1', 'NO_SHOW');
    expect(api.patch).toHaveBeenCalledWith('/calendars/bookings/b1/status', { status: 'NO_SHOW' });
  });

  it('createBlackout POSTs the window', async () => {
    api.post.mockResolvedValue({ data: { id: 'bo1' } });
    await createBlackout({ startAt: '2027-06-14T09:00:00Z', endAt: '2027-06-14T12:00:00Z' });
    expect(api.post).toHaveBeenCalledWith('/calendars/blackouts', {
      startAt: '2027-06-14T09:00:00Z',
      endAt: '2027-06-14T12:00:00Z',
    });
  });
});
