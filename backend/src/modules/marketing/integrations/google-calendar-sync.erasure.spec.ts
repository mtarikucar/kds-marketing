import { GoogleCalendarSyncService } from './google-calendar-sync.service';

/**
 * `erasure-calendar` — the Google half.
 *
 * Erasure scrubs the Booking row, but the mirrored Google event keeps the
 * person's name in the summary, their notes in the description and their
 * address in `attendees`. Re-pushing the booking does NOT fix it: Google's
 * events.patch has MERGE semantics and `pushBooking` OMITS description and
 * attendees when the source column is null, so a re-push only rewrites the
 * summary and leaves the attendee address on the host's calendar forever.
 *
 * So the scrub sends EXPLICIT clearing values, patches instead of deleting
 * (fulfillErasure keeps bookings as the operator's calendar history) and
 * suppresses the invitation-updated notice Google would otherwise mail to the
 * very person who asked to be forgotten.
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
    googleEventId: 'gevt-1',
    conferenceProvider: null,
    ...overrides.booking,
  };
  const prisma: any = {
    booking: {
      findFirst: jest.fn().mockResolvedValue(overrides.booking === null ? null : booking),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    googleCalendarConnection: {
      findFirst: jest.fn().mockResolvedValue(overrides.conn === null ? null : conn),
    },
  };
  const bus = { on: jest.fn(), off: jest.fn() };
  const google = {
    isConfigured: () => overrides.configured ?? true,
    getFreshAccessToken: jest.fn().mockResolvedValue('tok'),
  };
  const hostResolver = { resolve: jest.fn().mockResolvedValue(null) };
  const scheduledJobs = { schedule: jest.fn() };
  const runner = { registerHandler: jest.fn() };
  const meetSpaces = { available: () => false, createConfiguredSpace: jest.fn() };
  const svc = new GoogleCalendarSyncService(
    prisma,
    bus as any,
    google as any,
    hostResolver as any,
    scheduledJobs as any,
    runner as any,
    meetSpaces as any,
  );
  return { svc, prisma };
}

describe('GoogleCalendarSyncService.scrubBooking — erasure reaches the calendar copy', () => {
  it('patches the mirror with EXPLICIT clearing values (a merge PATCH keeps what it omits)', async () => {
    const { svc } = makeSvc();
    const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({ id: 'gevt-1' });

    const ok = await svc.scrubBooking('ws-1', 'b-1');

    expect(ok).toBe(true);
    const [url, , init] = apiJson.mock.calls[0];
    expect(String(url)).toContain('/events/gevt-1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    // Every PII carrier is sent with a value, never omitted.
    expect(body).toEqual(
      expect.objectContaining({ summary: '[Silinmiş]', description: '', attendees: [] }),
    );
  });

  it('suppresses the attendee notification (Google must not mail the erased person)', async () => {
    const { svc } = makeSvc();
    const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({ id: 'gevt-1' });

    await svc.scrubBooking('ws-1', 'b-1');

    expect(String(apiJson.mock.calls[0][0])).toContain('sendUpdates=none');
  });

  it('patches, never deletes — the operator keeps the appointment history', async () => {
    const { svc } = makeSvc();
    jest.spyOn(svc as any, 'apiJson').mockResolvedValue({ id: 'gevt-1' });
    const apiVoid = jest.spyOn(svc as any, 'apiVoid').mockResolvedValue(undefined);

    await svc.scrubBooking('ws-1', 'b-1');

    expect(apiVoid).not.toHaveBeenCalled();
  });

  it('is a no-op when the booking has no mirror, is an external block, or the feature is inert', async () => {
    for (const build of [
      () => makeSvc({ booking: { googleEventId: null } }),
      () => makeSvc({ booking: { status: 'EXTERNAL_BUSY' } }),
      () => makeSvc({ booking: null }),
      () => makeSvc({ configured: false }),
      () => makeSvc({ conn: null }),
    ]) {
      const { svc } = build();
      const apiJson = jest.spyOn(svc as any, 'apiJson').mockResolvedValue({});
      await expect(svc.scrubBooking('ws-1', 'b-1')).resolves.toBe(false);
      expect(apiJson).not.toHaveBeenCalled();
    }
  });

  it('never throws when Google fails — the erasure transaction must not be held hostage', async () => {
    const { svc } = makeSvc();
    jest.spyOn(svc as any, 'apiJson').mockRejectedValue(new Error('Google API HTTP 503'));

    await expect(svc.scrubBooking('ws-1', 'b-1')).resolves.toBe(false);
  });
});
