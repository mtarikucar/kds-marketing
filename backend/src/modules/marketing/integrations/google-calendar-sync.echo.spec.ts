import { GoogleCalendarSyncService } from './google-calendar-sync.service';

/**
 * applyExternalEvent must not re-import OUR OWN pushed events as EXTERNAL_BUSY
 * "phantom" blocks. The DB googleEventId check misses the race window between
 * Google-create and the booking.googleEventId write, so we also honour the
 * extendedProperties tag the push stamps (defence in depth).
 */
function makeSvc() {
  const prisma: any = {
    booking: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'bk-new' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const bus = { on: jest.fn(), off: jest.fn() };
  const hostResolver = { resolve: jest.fn() };
  const scheduledJobs = { schedule: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const svc = new GoogleCalendarSyncService(
    prisma as any,
    bus as any,
    {} as any,
    hostResolver as any,
    scheduledJobs as any,
    runner as any,
    { available: () => false, createConfiguredSpace: jest.fn() } as any,
  );
  return { svc, prisma };
}

const CONN = { id: 'conn-1', workspaceId: 'ws-1' } as any;

describe('GoogleCalendarSyncService.applyExternalEvent — echo skip', () => {
  it('skips an event carrying our own extendedProperties tag (no phantom busy block)', async () => {
    const { svc, prisma } = makeSvc();
    const ev = {
      id: 'bkabc123',
      status: 'confirmed',
      summary: 'Our booking',
      start: { dateTime: '2026-07-01T10:00:00Z' },
      end: { dateTime: '2026-07-01T10:30:00Z' },
      extendedProperties: { private: { kdsBookingId: 'b-1', kdsWorkspaceId: 'ws-1' } },
    };
    const res = await (svc as any).applyExternalEvent(CONN, ev);
    expect(res).toEqual({ upserted: 0, deleted: 0 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('still imports a genuine external event (no tag) as EXTERNAL_BUSY', async () => {
    const { svc, prisma } = makeSvc();
    const ev = {
      id: 'ext-xyz',
      status: 'confirmed',
      summary: 'External meeting',
      start: { dateTime: '2026-07-01T10:00:00Z' },
      end: { dateTime: '2026-07-01T10:30:00Z' },
    };
    const res = await (svc as any).applyExternalEvent(CONN, ev);
    expect(res.upserted).toBe(1);
    expect(prisma.booking.create).toHaveBeenCalled();
  });

  it('drops a stale block when a timed event was edited to ALL-DAY (date, no dateTime)', async () => {
    // A timed meeting created an EXTERNAL_BUSY block; the rep later edits it to
    // an all-day event. We can't represent all-day as a timed block (skipped),
    // but the OLD timed block MUST be dropped — a timed→all-day edit is not a
    // cancellation, so nothing else removes it, and a stale block would falsely
    // hold the original slot busy (the same harm the free branch guards).
    const { svc, prisma } = makeSvc();
    prisma.booking.deleteMany.mockResolvedValue({ count: 1 }); // block from when it was timed
    const ev = {
      id: 'allday-1',
      status: 'confirmed',
      summary: 'Now all day',
      start: { date: '2026-07-02' },
      end: { date: '2026-07-03' },
    };
    const res = await (svc as any).applyExternalEvent(CONN, ev);
    expect(res).toEqual({ upserted: 0, deleted: 1 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ googleEventId: 'allday-1', status: 'EXTERNAL_BUSY' }),
      }),
    );
  });

  it('does NOT import a FREE-marked event (transparency: transparent) and drops any block it held', async () => {
    // A rep who marks an event "free" in Google left that slot bookable — it
    // must not create/keep a busy block (would falsely block availability).
    const { svc, prisma } = makeSvc();
    prisma.booking.deleteMany.mockResolvedValue({ count: 1 }); // it had a block from when it was busy
    const ev = {
      id: 'free-1',
      status: 'confirmed',
      transparency: 'transparent',
      summary: 'Optional (free)',
      start: { dateTime: '2026-07-01T10:00:00Z' },
      end: { dateTime: '2026-07-01T10:30:00Z' },
    };
    const res = await (svc as any).applyExternalEvent(CONN, ev);
    expect(res).toEqual({ upserted: 0, deleted: 1 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ googleEventId: 'free-1', status: 'EXTERNAL_BUSY' }),
      }),
    );
  });
});
