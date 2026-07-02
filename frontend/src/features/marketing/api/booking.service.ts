/**
 * booking.service.ts — typed Booking / Calendar / Appointment API.
 * Admin paths are relative to /marketing (via marketingApi); the public
 * self-service booking endpoints live under /api/public/book and are called
 * with a plain fetch (no auth) by the public booking page.
 */
import marketingApi from './marketingApi';

// ── Types ───────────────────────────────────────────────────────────────────

export type Conferencing = 'NONE' | 'GOOGLE_MEET' | 'TEAMS';
export type BookingStatus =
  | 'CONFIRMED'
  | 'PENDING'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'COMPLETED'
  | 'RESCHEDULED'
  | 'EXTERNAL_BUSY';

export interface BookingCalendar {
  id: string;
  name: string;
  slug: string;
  type: 'SINGLE' | 'ROUND_ROBIN' | 'COLLECTIVE' | 'CLASS';
  capacity: number;
  slotMinutes: number;
  bufferMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  requiresApproval: boolean;
  conferencing: Conferencing;
  timezone: string;
  active: boolean;
  availability: Record<string, { start: string; end: string }[]>;
}

export interface Booking {
  id: string;
  calendarId: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  assigneeUserId: string | null;
  meetingUrl: string | null;
  conferenceProvider: Conferencing | null;
  attendeeTimezone: string | null;
  token: string;
}

export interface Blackout {
  id: string;
  calendarId: string | null;
  marketingUserId: string | null;
  startAt: string;
  endAt: string;
  reason: string | null;
}

export interface BookingsFilter {
  calendarId?: string;
  status?: string;
  from?: string;
  to?: string;
}

// ── Calendars ───────────────────────────────────────────────────────────────

export const listCalendars = (): Promise<BookingCalendar[]> =>
  marketingApi.get('/calendars').then((r) => r.data);

export const getCalendar = (id: string): Promise<BookingCalendar> =>
  marketingApi.get(`/calendars/${id}`).then((r) => r.data);

// ── Appointments (bookings) ──────────────────────────────────────────────────

export const listBookings = (filter: BookingsFilter = {}): Promise<Booking[]> =>
  marketingApi.get('/calendars/bookings', { params: filter }).then((r) => r.data);

export interface CreateBookingPayload {
  calendarId: string;
  start: string; // ISO
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  attendeeTimezone?: string;
}

/** Staff-created in-app booking. The slot must be valid for the calendar
 *  (future, within notice/advance window, aligned to its availability grid). */
export const createBooking = (payload: CreateBookingPayload): Promise<Booking> =>
  marketingApi.post('/calendars/bookings', payload).then((r) => r.data);

export const cancelBooking = (bookingId: string): Promise<{ id: string; status: string }> =>
  marketingApi.post(`/calendars/bookings/${bookingId}/cancel`).then((r) => r.data);

export const rescheduleBooking = (
  bookingId: string,
  start: string,
): Promise<{ id: string; startAt: string }> =>
  marketingApi.post(`/calendars/bookings/${bookingId}/reschedule`, { start }).then((r) => r.data);

export const setBookingStatus = (
  bookingId: string,
  status: 'CONFIRMED' | 'NO_SHOW' | 'COMPLETED' | 'CANCELLED',
): Promise<{ id: string; status: string }> =>
  marketingApi.patch(`/calendars/bookings/${bookingId}/status`, { status }).then((r) => r.data);

// ── Blackout / time-off ──────────────────────────────────────────────────────

export const listBlackouts = (calendarId?: string): Promise<Blackout[]> =>
  marketingApi
    .get('/calendars/blackouts', { params: calendarId ? { calendarId } : {} })
    .then((r) => r.data);

export const createBlackout = (payload: {
  calendarId?: string;
  marketingUserId?: string;
  startAt: string;
  endAt: string;
  reason?: string;
}): Promise<Blackout> =>
  marketingApi.post('/calendars/blackouts', payload).then((r) => r.data);

export const deleteBlackout = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/calendars/blackouts/${id}`).then((r) => r.data);

// ── Per-member working hours ─────────────────────────────────────────────────

export const listMemberAvailability = (calendarId: string): Promise<
  Array<{ id: string; marketingUserId: string; availability: unknown; timezone: string | null }>
> => marketingApi.get(`/calendars/${calendarId}/member-availability`).then((r) => r.data);

export const setMemberAvailability = (
  calendarId: string,
  payload: { marketingUserId: string; availability: unknown; timezone?: string },
): Promise<unknown> =>
  marketingApi.post(`/calendars/${calendarId}/member-availability`, payload).then((r) => r.data);

// ── Public self-service (no auth; under /api/public/book) ────────────────────

const publicBase = (): string => {
  // API_URL points at the API origin; strip a trailing /marketing if present so
  // the public /api/public path resolves against the same origin.
  const base = (import.meta as any).env?.VITE_API_URL || window.location.origin;
  return String(base).replace(/\/marketing\/?$/, '');
};

async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${publicBase()}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const getPublicSlots = (
  ws: string,
  cal: string,
  from?: string,
  to?: string,
): Promise<{ slots: string[]; slotMinutes?: number; timezone?: string }> => {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  return publicJson(`/api/public/book/${ws}/${cal}/slots?${qs.toString()}`);
};

export const reservePublicSlot = (
  ws: string,
  cal: string,
  body: {
    start: string;
    name: string;
    email?: string;
    phone?: string;
    notes?: string;
    attendeeTimezone?: string;
  },
): Promise<{ id: string; startAt: string; token: string }> =>
  publicJson(`/api/public/book/${ws}/${cal}/reserve`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const rescheduleByToken = (
  token: string,
  start: string,
): Promise<{ id: string; startAt: string }> =>
  publicJson(`/api/public/book/token/${token}/reschedule`, {
    method: 'POST',
    body: JSON.stringify({ start }),
  });

export const cancelByToken = (token: string): Promise<{ id: string; status: string }> =>
  publicJson(`/api/public/book/token/${token}/cancel`, { method: 'POST' });
