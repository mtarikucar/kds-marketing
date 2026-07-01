import { OutlookCalendarSyncService } from './outlook-calendar-sync.service';

/**
 * pushBooking must create the Graph event as a Teams online meeting
 * (isOnlineMeeting) and persist the returned joinUrl ONLY when the booking's
 * calendar opted into TEAMS.
 */
function makeSvc(overrides: any = {}) {
  const conn = {
    id: 'oconn-1',
    workspaceId: 'ws-1',
    outlookCalendarId: 'primary',
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
    outlookEventId: null,
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
        .mockResolvedValue({ conferencing: overrides.conferencing ?? 'TEAMS' }),
    },
    outlookCalendarConnection: { findFirst: jest.fn().mockResolvedValue(conn) },
  };
  const bus = { on: jest.fn(), off: jest.fn() };
  const outlook = {
    isConfigured: () => true,
    getFreshAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  const hostResolver = {
    resolve: jest.fn().mockResolvedValue({
      kind: 'TEAMS',
      connectionId: 'oconn-1',
      marketingUserId: 'u1',
    }),
  };
  const svc = new OutlookCalendarSyncService(
    prisma,
    bus as any,
    outlook as any,
    hostResolver as any,
  );
  return { svc, prisma };
}

describe('OutlookCalendarSyncService.pushBooking — Teams conferencing', () => {
  it('creates an online meeting and persists the Teams join link when opted in', async () => {
    const { svc, prisma } = makeSvc();
    const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({
      id: 'graph-ev-1',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/xyz' },
    });
    await svc.pushBooking('ws-1', 'b-1');

    const postCall = apiJson.mock.calls.find((c) => c[2]?.method === 'POST');
    const body = JSON.parse(postCall![2].body);
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          meetingUrl: 'https://teams.microsoft.com/l/xyz',
          conferenceProvider: 'TEAMS',
          conferenceStatus: 'created',
        }),
      }),
    );
  });

  it('does NOT set isOnlineMeeting when conferencing is NONE', async () => {
    const { svc, prisma } = makeSvc({ conferencing: 'NONE' });
    const apiJson = jest
      .spyOn(svc as any, 'apiJson')
      .mockResolvedValue({ id: 'graph-ev-1' });
    await svc.pushBooking('ws-1', 'b-1');

    const postCall = apiJson.mock.calls.find((c) => c[2]?.method === 'POST');
    expect(JSON.parse(postCall![2].body).isOnlineMeeting).toBeUndefined();
    const persistedMeet = prisma.booking.updateMany.mock.calls
      .map((c: any) => c[0].data)
      .some((d: any) => d.meetingUrl !== undefined);
    expect(persistedMeet).toBe(false);
  });
});
