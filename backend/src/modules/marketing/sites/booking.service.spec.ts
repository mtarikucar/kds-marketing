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
      // Calendar-type members (ROUND_ROBIN / COLLECTIVE). Default: none.
      bookingCalendarMember: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      lead: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      // The per-slot advisory lock acquired at the top of the booking tx.
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const outbox = { append: jest.fn().mockResolvedValue('e') };
    const email = { sendPlainEmail: jest.fn().mockResolvedValue(true) };
    const autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    const scheduledJobs = { schedule: jest.fn().mockResolvedValue('j') };
    const runner = { registerHandler: jest.fn() };
    // Google / Outlook calendar sync are inert in this suite (push/cancel are
    // best-effort no-ops here); the dedicated calendar specs exercise them for real.
    const googleSync = {
      pushBooking: jest.fn().mockResolvedValue(null),
      cancelBooking: jest.fn().mockResolvedValue(false),
    };
    const outlookSync = {
      pushBooking: jest.fn().mockResolvedValue(null),
      cancelBooking: jest.fn().mockResolvedValue(false),
    };
    svc = new BookingService(prisma as any, outbox as any, email as any, autoAssigner as any, scheduledJobs as any, runner as any, googleSync as any, outlookSync as any);
  });

  it('slices the availability window into slots', async () => {
    const slots = await svc.availability(WS, 'c1', dayISO, '2027-06-14T23:59:59.000Z');
    expect(slots).toHaveLength(2); // 09:00, 09:30
    expect(slots[0]).toBe('2027-06-14T09:00:00.000Z');
  });

  it('interprets availability windows in the calendar timezone (Istanbul = UTC+3)', async () => {
    prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ timezone: 'Europe/Istanbul' }));
    const slots = await svc.availability(WS, 'c1', dayISO, '2027-06-14T23:59:59.000Z');
    // the 09:00 Istanbul window now resolves to 06:00 UTC (was wrongly 09:00 UTC before C4)
    expect(slots[0]).toBe('2027-06-14T06:00:00.000Z');
    expect(slots).toHaveLength(2);
  });

  it('subtracts an existing booking from the available slots', async () => {
    prisma.booking.findMany.mockResolvedValue([
      { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
    ]);
    const slots = await svc.availability(WS, 'c1', dayISO, '2027-06-14T23:59:59.000Z');
    expect(slots).toEqual(['2027-06-14T09:30:00.000Z']);
  });

  it('refuses a slot outside the availability window (off-grid / out-of-hours)', async () => {
    // The calendar offers 09:00–10:00; a direct API call for 11:00 is not a real
    // slot and must be rejected before any booking is created.
    await expect(
      svc.book(WS, 'c1', { start: '2027-06-14T11:00:00.000Z', name: 'Ada' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.booking.create).not.toHaveBeenCalled();
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

  it('takes a per-calendar advisory lock inside the tx (serializes concurrent reserves)', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.booking.create.mockResolvedValue({ id: 'b1', startAt: new Date('2027-06-14T09:00:00.000Z'), token: 'bk_x', email: null });
    await svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' });
    // The lock is acquired (pg_advisory_xact_lock) before the conflict check so
    // two concurrent reserves for the same slot can't both pass it (double-book).
    expect(prisma.$executeRaw).toHaveBeenCalled();
    const sqlParts = (prisma.$executeRaw as jest.Mock).mock.calls[0][0];
    expect(String(sqlParts.join?.('') ?? sqlParts)).toContain('pg_advisory_xact_lock');
  });

  it('refuses a past slot', async () => {
    await expect(svc.book(WS, 'c1', { start: '2000-01-01T09:00:00.000Z', name: 'Ada' })).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Calendar types (GHL parity) ──────────────────────────────────────────────
  describe('calendar types', () => {
    const RANGE_END = '2027-06-14T23:59:59.000Z';

    it('CLASS still offers a slot below capacity', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'CLASS', capacity: 3 }));
      prisma.booking.findMany
        .mockResolvedValueOnce([
          { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
          { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
        ]) // ours (2/3 at 09:00)
        .mockResolvedValueOnce([]); // external
      const slots = await svc.availability(WS, 'c1', dayISO, RANGE_END);
      expect(slots).toEqual(['2027-06-14T09:00:00.000Z', '2027-06-14T09:30:00.000Z']);
    });

    it('CLASS hides a slot once capacity is reached', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'CLASS', capacity: 2 }));
      prisma.booking.findMany
        .mockResolvedValueOnce([
          { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
          { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
        ]) // 2/2 at 09:00 → full
        .mockResolvedValueOnce([]);
      const slots = await svc.availability(WS, 'c1', dayISO, RANGE_END);
      expect(slots).toEqual(['2027-06-14T09:30:00.000Z']);
    });

    it('ROUND_ROBIN capacity equals the member count', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'ROUND_ROBIN' }));
      prisma.bookingCalendarMember.count.mockResolvedValue(2);
      prisma.booking.findMany
        .mockResolvedValueOnce([
          { startAt: new Date('2027-06-14T09:00:00.000Z'), endAt: new Date('2027-06-14T09:30:00.000Z') },
        ]) // 1 of 2 members busy at 09:00 → still open
        .mockResolvedValueOnce([]);
      const slots = await svc.availability(WS, 'c1', dayISO, RANGE_END);
      expect(slots).toEqual(['2027-06-14T09:00:00.000Z', '2027-06-14T09:30:00.000Z']);
    });

    it('ROUND_ROBIN assigns a booking to a member who is free in that slot', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'ROUND_ROBIN', ownerUserId: null }));
      prisma.booking.findFirst.mockResolvedValue(null); // no external block
      prisma.booking.findMany.mockResolvedValue([{ assigneeUserId: 'u1' }]); // u1 already booked
      prisma.bookingCalendarMember.findMany.mockResolvedValue([
        { marketingUserId: 'u1' },
        { marketingUserId: 'u2' },
      ]);
      prisma.booking.create.mockResolvedValue({ id: 'b1', startAt: new Date('2027-06-14T09:00:00.000Z'), token: 'bk', email: null });
      await svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' });
      expect(prisma.booking.create.mock.calls[0][0].data.assigneeUserId).toBe('u2');
    });

    it('ROUND_ROBIN excludes a member already booked on ANOTHER calendar (no human double-book)', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'ROUND_ROBIN', ownerUserId: null }));
      prisma.booking.findFirst.mockResolvedValue(null); // no external block
      prisma.booking.findMany
        .mockResolvedValueOnce([]) // overlapping on THIS calendar: none → under capacity
        .mockResolvedValueOnce([{ assigneeUserId: 'u1' }]); // workspace-wide: u1 busy elsewhere
      prisma.bookingCalendarMember.findMany.mockResolvedValue([
        { marketingUserId: 'u1' },
        { marketingUserId: 'u2' },
      ]);
      prisma.booking.create.mockResolvedValue({ id: 'b1', startAt: new Date('2027-06-14T09:00:00.000Z'), token: 'bk', email: null });
      await svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' });
      expect(prisma.booking.create.mock.calls[0][0].data.assigneeUserId).toBe('u2');
    });

    it('CLASS rejects a reserve once the slot is at capacity', async () => {
      prisma.bookingCalendar.findFirst.mockResolvedValue(calendar({ type: 'CLASS', capacity: 1 }));
      prisma.booking.findFirst.mockResolvedValue(null);
      prisma.booking.findMany.mockResolvedValue([{ assigneeUserId: null }]); // 1/1
      await expect(
        svc.book(WS, 'c1', { start: '2027-06-14T09:00:00.000Z', name: 'Ada' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });
  });
});
