import { BadRequestException } from '@nestjs/common';
import { BookingService } from './booking.service';

/**
 * Booking slot math + the double-book guard. Slots come from the weekday
 * availability window sliced into slotMinutes, minus existing bookings; a
 * reserve that overlaps a confirmed booking is refused.
 */
describe('BookingService', () => {
  const WS = 'ws-1';
  // A fixed future day; availability is keyed to whatever weekday it falls on.
  const dayISO = '2027-06-14T00:00:00.000Z';
  const dow = new Date(dayISO).getUTCDay();
  let prisma: any;
  let svc: BookingService;

  function calendar(extra: any = {}) {
    return { id: 'c1', workspaceId: WS, active: true, slotMinutes: 30, bufferMinutes: 0, availability: { [String(dow)]: [{ start: '09:00', end: '10:00' }] }, ...extra };
  }

  beforeEach(() => {
    prisma = {
      bookingCalendar: { findFirst: jest.fn().mockResolvedValue(calendar()) },
      booking: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn() },
      lead: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const outbox = { append: jest.fn().mockResolvedValue('e') };
    const email = { sendPlainEmail: jest.fn().mockResolvedValue(true) };
    const autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    const scheduledJobs = { schedule: jest.fn().mockResolvedValue('j') };
    const runner = { registerHandler: jest.fn() };
    // Google Calendar sync is inert in this suite (push/cancel are best-effort
    // no-ops here); the dedicated google-calendar specs exercise it for real.
    const googleSync = {
      pushBooking: jest.fn().mockResolvedValue(null),
      cancelBooking: jest.fn().mockResolvedValue(false),
    };
    svc = new BookingService(prisma as any, outbox as any, email as any, autoAssigner as any, scheduledJobs as any, runner as any, googleSync as any);
  });

  it('slices the availability window into slots', async () => {
    const slots = await svc.availability(WS, 'c1', dayISO, '2027-06-14T23:59:59.000Z');
    expect(slots).toHaveLength(2); // 09:00, 09:30
    expect(slots[0]).toBe('2027-06-14T09:00:00.000Z');
  });

  it('subtracts an existing booking from the available slots', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
    ]);
    const slots = await svc.availability(WS, 'c1', dayISO, '2027-06-14T23:59:59.000Z');
    expect(slots).toEqual(['2027-06-14T09:30:00.000Z']);
  });

  it('refuses a slot that overlaps a confirmed booking', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'taken' });
    await expect(
      svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('books a free slot (creates the booking + links a lead)', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.create.mockResolvedValue({ id: 'b1', startAt: new Date('2027-06-14T09:00:00.000Z'), token: 'bk_x', email: null });
    const res = await svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' });
    expect(res.id).toBe('b1');
    expect(prisma.booking.create).toHaveBeenCalled();
  });

  it('refuses a past slot', async () => {
    await expect(svc.book(WS, 'c1', { start: '2000-01-01T09:00:00.000Z', name: 'Ada' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
