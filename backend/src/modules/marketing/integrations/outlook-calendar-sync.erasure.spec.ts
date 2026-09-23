import { OutlookCalendarSyncService } from './outlook-calendar-sync.service';

/**
 * `erasure-calendar` — the Graph half, mirroring
 * `google-calendar-sync.erasure.spec.ts`.
 *
 * Graph PATCH has the same merge semantics as Google's, and `eventBody` omits
 * `body`/`attendees` when the booking column is null — so a post-erasure
 * re-push leaves the attendee address on the organiser's Outlook event. The
 * scrub therefore sends explicit clearing values, and it clears `attendees`
 * with a PATCH (Graph has no `sendUpdates` query parameter, so the only way
 * not to mail the erased person is to leave no attendee behind AND not to
 * cancel the event).
 */
function makeSvc(overrides: any = {}) {
  const conn = {
    id: 'conn-1',
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
    outlookEventId: 'oevt-1',
    conferenceProvider: null,
    ...overrides.booking,
  };
  const prisma: any = {
    booking: {
      findFirst: jest.fn().mockResolvedValue(overrides.booking === null ? null : booking),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    outlookCalendarConnection: {
      findFirst: jest.fn().mockResolvedValue(overrides.conn === null ? null : conn),
    },
  };
  const bus = { on: jest.fn(), off: jest.fn() };
  const outlook = {
    isConfigured: () => overrides.configured ?? true,
    getFreshAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  const hostResolver = { resolve: jest.fn().mockResolvedValue(null) };
  const svc = new OutlookCalendarSyncService(
    prisma,
    bus as any,
    outlook as any,
    hostResolver as any,
  );
  return { svc, prisma };
}

describe('OutlookCalendarSyncService.scrubBooking — erasure reaches the calendar copy', () => {
  it('patches the mirror with EXPLICIT clearing values (a merge PATCH keeps what it omits)', async () => {
    const { svc } = makeSvc();
    const apiVoid = jest.spyOn(svc as any, 'apiVoid').mockResolvedValue(undefined);

    const ok = await svc.scrubBooking('ws-1', 'b-1');

    expect(ok).toBe(true);
    const [url, , init] = apiVoid.mock.calls[0];
    expect(String(url)).toContain('/me/events/oevt-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        subject: '[Silinmiş]',
        body: { contentType: 'text', content: '' },
        attendees: [],
      }),
    );
  });

  it('never issues a DELETE — the attendee is dropped in place, so Graph mails nobody', async () => {
    const { svc } = makeSvc();
    const apiVoid = jest.spyOn(svc as any, 'apiVoid').mockResolvedValue(undefined);

    await svc.scrubBooking('ws-1', 'b-1');

    expect(apiVoid).toHaveBeenCalledTimes(1);
    expect(apiVoid.mock.calls.every((c: any[]) => c[2].method !== 'DELETE')).toBe(true);
  });

  it('is a no-op for an unlinked, still-claiming, external or inert booking', async () => {
    for (const build of [
      () => makeSvc({ booking: { outlookEventId: null } }),
      () => makeSvc({ booking: { outlookEventId: 'pending:123:abc' } }),
      () => makeSvc({ booking: { status: 'EXTERNAL_BUSY' } }),
      () => makeSvc({ booking: null }),
      () => makeSvc({ configured: false }),
      () => makeSvc({ conn: null }),
    ]) {
      const { svc } = build();
      const apiVoid = jest.spyOn(svc as any, 'apiVoid').mockResolvedValue(undefined);
      await expect(svc.scrubBooking('ws-1', 'b-1')).resolves.toBe(false);
      expect(apiVoid).not.toHaveBeenCalled();
    }
  });

  it('never throws when Graph fails', async () => {
    const { svc } = makeSvc();
    jest.spyOn(svc as any, 'apiVoid').mockRejectedValue(new Error('Graph API HTTP 503'));

    await expect(svc.scrubBooking('ws-1', 'b-1')).resolves.toBe(false);
  });
});
