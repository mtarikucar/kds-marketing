import { OutlookCalendarService } from './outlook-calendar.service';
import { OutlookCalendarSyncService } from './outlook-calendar-sync.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';
import * as safeFetchModule from '../../../common/util/safe-fetch';

/**
 * Outlook/O365 (Microsoft Graph) 2-way sync — Graph MOCKED (no live creds).
 *
 * Covers: BookingCreated subscribe/unsubscribe; push claims + creates a Graph
 * event and stores outlookEventId; a concurrent (already-claimed) push makes NO
 * second Graph event; push PATCHES an existing mirror; cancel deletes the
 * mirror; delta pull upserts EXTERNAL_BUSY blocks + persists the deltaLink;
 * removed/cancelled events delete the block; our own events don't echo; 410
 * resets the delta cursor; pullBySubscription validates the clientState nonce;
 * and the whole feature is INERT when MS_OAUTH_* is unset.
 */

const WS_A = 'ws-a';
const USER = 'mu-1';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { has: () => false, get: () => null },
  } as unknown as Response;
}

function emptyResponse(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => '',
    headers: { has: () => false, get: () => null },
  } as unknown as Response;
}

function freshConn(over: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    workspaceId: WS_A,
    marketingUserId: USER,
    outlookCalendarId: 'primary',
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    deltaToken: null as string | null,
    subscriptionId: null as string | null,
    clientState: null as string | null,
    subscriptionExpiration: null as Date | null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('OutlookCalendarSyncService (mocked Graph)', () => {
  let prisma: MockPrismaClient;
  let outlook: OutlookCalendarService;
  let sync: OutlookCalendarSyncService;
  let bus: { on: jest.Mock; off: jest.Mock };
  let safeFetchSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    process.env.MS_OAUTH_CLIENT_ID = 'ms-client-id';
    process.env.MS_OAUTH_CLIENT_SECRET = 'ms-client-secret';
    prisma = mockPrismaClient();
    outlook = new OutlookCalendarService(prisma as never);
    bus = { on: jest.fn(), off: jest.fn() };
    sync = new OutlookCalendarSyncService(
      prisma as never,
      bus as never,
      outlook,
      { resolve: jest.fn().mockResolvedValue(null) } as never,
    );
    safeFetchSpy = jest.spyOn(safeFetchModule, 'safeFetch');
    jest.spyOn(outlook, 'getFreshAccessToken').mockResolvedValue('access-token-live');
  });
  afterEach(() => {
    safeFetchSpy.mockRestore();
    jest.restoreAllMocks();
    delete process.env.MS_OAUTH_CLIENT_ID;
    delete process.env.MS_OAUTH_CLIENT_SECRET;
    delete process.env.MARKETING_PUBLIC_URL;
  });

  it('subscribes to BookingCreated on init and unsubscribes on destroy', () => {
    sync.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith('marketing.booking.created.v1', expect.any(Function));
    sync.onModuleDestroy();
    expect(bus.off).toHaveBeenCalled();
  });

  it('push claims the booking, creates a Graph event, and stores outlookEventId', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1', workspaceId: WS_A, name: 'Demo call', notes: null,
      email: 'guest@example.com',
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED', outlookEventId: null,
    } as never);
    // The atomic claim succeeds (count 1).
    (prisma.booking.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    safeFetchSpy.mockResolvedValue(jsonResponse({ id: 'oevt-123' }));

    const eventId = await sync.pushBooking(WS_A, 'bk-1');

    expect(eventId).toBe('oevt-123');
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/me/events');
    expect(call[1].method).toBe('POST');
    // The Graph body uses subject + UTC-no-offset times.
    const body = JSON.parse(call[1].body as string);
    expect(body.subject).toBe('Demo call');
    expect(body.start).toEqual({ dateTime: '2027-06-14T09:00:00.000', timeZone: 'UTC' });
    // The first updateMany is the claim; the last stores the real id.
    const calls = (prisma.booking.updateMany as jest.Mock).mock.calls;
    expect(calls[0][0].data.outlookEventId).toMatch(/^pending:/);
    expect(calls[calls.length - 1][0]).toEqual(
      expect.objectContaining({ where: { id: 'bk-1', workspaceId: WS_A }, data: { outlookEventId: 'oevt-123' } }),
    );
  });

  it('push makes NO second Graph event when a sibling path already claimed the create', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst
      // first read: not yet linked
      .mockResolvedValueOnce({
        id: 'bk-1', workspaceId: WS_A, name: 'Demo', notes: null, email: null,
        startAt: new Date('2027-06-14T09:00:00.000Z'),
        endAt: new Date('2027-06-14T09:30:00.000Z'),
        status: 'CONFIRMED', outlookEventId: null,
      } as never)
      // re-read after a lost claim: sibling already linked it
      .mockResolvedValueOnce({ outlookEventId: 'oevt-sibling' } as never);
    // The claim loses the race (count 0).
    (prisma.booking.updateMany as jest.Mock).mockResolvedValue({ count: 0 } as never);

    const eventId = await sync.pushBooking(WS_A, 'bk-1');

    expect(eventId).toBe('oevt-sibling');
    // No Graph call was made — the sibling owns the create.
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('push PATCHES an existing event when outlookEventId is already set', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1', workspaceId: WS_A, name: 'x', notes: null, email: null,
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED', outlookEventId: 'oevt-existing',
    } as never);
    safeFetchSpy.mockResolvedValue(emptyResponse(200));

    await sync.pushBooking(WS_A, 'bk-1');
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/me/events/oevt-existing');
    expect(call[1].method).toBe('PATCH');
  });

  it('push releases the claim when the Graph create fails (so a retry can re-create)', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1', workspaceId: WS_A, name: 'x', notes: null, email: null,
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED', outlookEventId: null,
    } as never);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    safeFetchSpy.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    const eventId = await sync.pushBooking(WS_A, 'bk-1');
    expect(eventId).toBeNull();
    // The claim was released (reset to null) on the pending sentinel.
    const releases = (prisma.booking.updateMany as jest.Mock).mock.calls.filter(
      (c) => c[0]?.data?.outlookEventId === null,
    );
    expect(releases.length).toBeGreaterThan(0);
    expect(releases[0][0].where).toEqual(
      expect.objectContaining({ id: 'bk-1', workspaceId: WS_A, outlookEventId: { startsWith: 'pending:' } }),
    );
  });

  it('cancel deletes the mirrored Graph event', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({ outlookEventId: 'oevt-9', status: 'CONFIRMED' } as never);
    safeFetchSpy.mockResolvedValue(emptyResponse(204));

    const ok = await sync.cancelBooking(WS_A, 'bk-1');
    expect(ok).toBe(true);
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/me/events/oevt-9');
    expect(call[1].method).toBe('DELETE');
  });

  it('push is a no-op (no Graph call) when no connection exists', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(null as never);
    const eventId = await sync.pushBooking(WS_A, 'bk-1');
    expect(eventId).toBeNull();
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('delta pull upserts an EXTERNAL_BUSY block and persists the new deltaLink', async () => {
    const conn = freshConn({ deltaToken: null });
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: 'ext-evt-1',
            subject: 'Busy elsewhere',
            start: { dateTime: '2027-06-14T11:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2027-06-14T12:00:00.0000000', timeZone: 'UTC' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=NEW',
      }),
    );
    prisma.booking.findFirst.mockResolvedValue(null as never); // not ours, no existing block
    (prisma.booking.create as jest.Mock).mockResolvedValue({ id: 'busy-1' } as never);

    const result = await sync.pullEvents(conn as never);

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(1);
    const created = (prisma.booking.create as jest.Mock).mock.calls[0][0].data;
    expect(created.status).toBe('EXTERNAL_BUSY');
    expect(created.outlookEventId).toBe('ext-evt-1');
    expect(created.workspaceId).toBe(WS_A);
    // The new deltaLink is persisted (workspace-scoped).
    expect(prisma.outlookCalendarConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1', workspaceId: WS_A },
        data: { deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=NEW' },
      }),
    );
  });

  it('delta pull deletes the busy block when the source event is removed (tombstone)', async () => {
    const conn = freshConn({ deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=OLD' });
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        value: [{ id: 'ext-evt-1', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=tok2',
      }),
    );
    prisma.booking.findFirst.mockResolvedValue(null as never); // not ours
    (prisma.booking.deleteMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const result = await sync.pullEvents(conn as never);
    expect(result.deleted).toBe(1);
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_A, outlookEventId: 'ext-evt-1', status: 'EXTERNAL_BUSY' },
      }),
    );
  });

  it('delta pull skips events WE pushed (no echo loop)', async () => {
    const conn = freshConn({ deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=OLD' });
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        value: [
          {
            id: 'ours-1',
            subject: 'Our booking',
            start: { dateTime: '2027-06-14T11:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2027-06-14T12:00:00.0000000', timeZone: 'UTC' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=tok2',
      }),
    );
    // The skip-ours lookup finds a non-busy booking with this event id.
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk-ours' } as never);

    const result = await sync.pullEvents(conn as never);
    expect(result.upserted).toBe(0);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('delta pull resets the cursor and recovers on HTTP 410 (expired delta token)', async () => {
    const conn = freshConn({ deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=STALE' });
    safeFetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 410))
      .mockResolvedValueOnce(
        jsonResponse({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=FRESH',
        }),
      );

    const result = await sync.pullEvents(conn as never);
    expect(result.ok).toBe(true);
    expect(result.resyncRequired).toBe(true);
    // The stale cursor was cleared, then the fresh deltaLink persisted.
    const datas = (prisma.outlookCalendarConnection.updateMany as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(datas).toContainEqual({ deltaToken: null });
    expect(datas).toContainEqual({ deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=FRESH' });
  });

  it('pull is inert (not-configured) when MS_OAUTH_* is unset', async () => {
    delete process.env.MS_OAUTH_CLIENT_ID;
    delete process.env.MS_OAUTH_CLIENT_SECRET;
    const result = await sync.pullEvents(freshConn() as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-configured');
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('pullBySubscription validates the clientState nonce (rejects a forged one)', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(
      freshConn({ subscriptionId: 'sub-1', clientState: 'secret-nonce' }) as never,
    );
    const result = await sync.pullBySubscription('sub-1', 'WRONG-nonce');
    expect(result).toBeNull();
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('pullBySubscription pulls when the clientState nonce matches', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(
      freshConn({ subscriptionId: 'sub-1', clientState: 'secret-nonce', deltaToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=X' }) as never,
    );
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=Y' }),
    );
    const result = await sync.pullBySubscription('sub-1', 'secret-nonce');
    expect(result?.ok).toBe(true);
    expect(safeFetchSpy).toHaveBeenCalled();
  });

  it('startSubscription POSTs a Graph subscription and persists id + expiry + clientState', async () => {
    process.env.MARKETING_PUBLIC_URL = 'https://app.example.com';
    const conn = freshConn();
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    safeFetchSpy.mockResolvedValue(jsonResponse({ id: 'sub-xyz', expirationDateTime: exp }));

    const ok = await sync.startSubscription(conn as never);
    expect(ok).toBe(true);
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/subscriptions');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body.resource).toBe('me/events');
    expect(body.notificationUrl).toBe('https://app.example.com/api/marketing/integrations/outlook-calendar/notifications');
    expect(body.changeType).toContain('updated');
    expect(prisma.outlookCalendarConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1', workspaceId: WS_A },
        data: expect.objectContaining({ subscriptionId: 'sub-xyz' }),
      }),
    );
  });

  it('startSubscription stays in manual mode (no throw) when the webhook host is not https', async () => {
    delete process.env.MARKETING_PUBLIC_URL;
    const ok = await sync.startSubscription(freshConn() as never);
    expect(ok).toBe(false);
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });
});
