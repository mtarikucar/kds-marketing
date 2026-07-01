import { GoogleCalendarSyncService } from './google-calendar-sync.service';

/**
 * pushBooking must attach a Google Meet conference (conferenceData +
 * conferenceDataVersion=1) and persist the returned join link ONLY when the
 * booking's calendar opted into GOOGLE_MEET; a pending conference queues a
 * durable follow-up.
 */
function makeSvc(overrides: any = {}) {
  const conn = {
    id: 'conn-1',
    workspaceId: 'ws-1',
    googleCalendarId: 'primary',
    enabled: true,
  };
  const booking = {
    id: 'b-1',
    workspaceId: 'ws-1',
    calendarId: 'cal-1',
    assigneeUserId: 'u1',
    status: 'CONFIRMED',
    name: 'Demo',
    notes: null,
    email: 'ada@x.com',
    startAt: new Date('2026-07-01T10:00:00Z'),
    endAt: new Date('2026-07-01T10:30:00Z'),
    googleEventId: null,
    ...overrides.booking,
  };
  const prisma: any = {
    booking: {
      findFirst: jest.fn().mockResolvedValue(booking),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingCalendar: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ conferencing: overrides.conferencing ?? 'GOOGLE_MEET' }),
    },
    googleCalendarConnection: { findFirst: jest.fn().mockResolvedValue(conn) },
  };
  const bus = { on: jest.fn(), off: jest.fn() };
  const google = {
    isConfigured: () => true,
    getFreshAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  const hostResolver = {
    resolve: jest.fn().mockResolvedValue({
      kind: 'GOOGLE_MEET',
      connectionId: 'conn-1',
      marketingUserId: 'u1',
    }),
  };
  const scheduledJobs = { schedule: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const svc = new GoogleCalendarSyncService(
    prisma,
    bus as any,
    google as any,
    hostResolver as any,
    scheduledJobs as any,
    runner as any,
  );
  return { svc, prisma, scheduledJobs, hostResolver };
}

describe('GoogleCalendarSyncService.pushBooking — conferencing', () => {
  it('adds conferenceData and persists the Meet link when the calendar opts in', async () => {
    const { svc, prisma } = makeSvc();
    const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({
      id: 'bkb1',
      hangoutLink: 'https://meet.google.com/abc',
      conferenceData: {
        conferenceId: 'abc',
        createRequest: { status: { statusCode: 'success' } },
      },
    });
    await svc.pushBooking('ws-1', 'b-1');

    expect(
      apiJson.mock.calls.some((c) => String(c[0]).includes('conferenceDataVersion=1')),
    ).toBe(true);
    const postCall = apiJson.mock.calls.find((c) => c[2]?.method === 'POST');
    expect(JSON.parse(postCall![2].body)).toEqual(
      expect.objectContaining({ conferenceData: expect.any(Object) }),
    );
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meetingUrl: 'https://meet.google.com/abc',
          conferenceProvider: 'GOOGLE_MEET',
          conferenceStatus: 'created',
        }),
      }),
    );
  });

  it('does NOT add conferenceData when conferencing is NONE', async () => {
    const { svc, prisma } = makeSvc({ conferencing: 'NONE' });
    const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({ id: 'bkb1' });
    await svc.pushBooking('ws-1', 'b-1');

    expect(
      apiJson.mock.calls.some((c) => String(c[0]).includes('conferenceDataVersion=1')),
    ).toBe(false);
    const postCall = apiJson.mock.calls.find((c) => c[2]?.method === 'POST');
    expect(JSON.parse(postCall![2].body).conferenceData).toBeUndefined();
    const persistedMeet = prisma.booking.updateMany.mock.calls
      .map((c: any) => c[0].data)
      .some((d: any) => d.meetingUrl !== undefined);
    expect(persistedMeet).toBe(false);
  });

  it('schedules a follow-up when the conference is pending', async () => {
    const { svc, prisma, scheduledJobs } = makeSvc();
    jest.spyOn(svc as any, 'apiJson').mockResolvedValue({
      id: 'bkb1',
      conferenceData: { createRequest: { status: { statusCode: 'pending' } } },
    });
    await svc.pushBooking('ws-1', 'b-1');

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conferenceStatus: 'pending', meetingUrl: null }),
      }),
    );
    expect(scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'booking.conference.resolve' }),
    );
  });
});
