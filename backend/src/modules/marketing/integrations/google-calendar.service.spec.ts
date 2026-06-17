import { GoogleCalendarService } from './google-calendar.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';
import * as safeFetchModule from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';

/**
 * Env-gated Google Calendar 2-way sync — Google APIs MOCKED (no live creds).
 *
 * Covers: auth-url scopes+state; callback exchanges the code and stores SEALED
 * tokens; push creates a Google event and stores googleEventId; pull with a
 * syncToken upserts EXTERNAL_BUSY blocks and persists the new nextSyncToken;
 * access-token refresh on expiry; cross-workspace isolation (ws-A's connection
 * is invisible to ws-B); and the whole feature is INERT when the env OAuth
 * client is unset.
 */

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const USER = 'mu-1';

// 32-byte master key so the secret-box can seal/open during the suite.
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { has: () => false, get: () => null },
  } as unknown as Response;
}

function emptyResponse(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { has: () => false, get: () => null },
  } as unknown as Response;
}

function freshConn(over: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    workspaceId: WS_A,
    marketingUserId: USER,
    googleCalendarId: 'primary',
    // sealed values are produced by the service; here we provide pre-sealed
    // tokens via the helper so getFreshAccessToken can open them.
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    syncToken: null as string | null,
    channelId: null as string | null,
    resourceId: null as string | null,
    channelToken: null as string | null,
    channelExpiration: null as Date | null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('Google Calendar integration (mocked Google)', () => {
  let prisma: MockPrismaClient;
  let svc: GoogleCalendarService;
  let safeFetchSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-xyz';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-xyz';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.com';
    prisma = mockPrismaClient();
    svc = new GoogleCalendarService(prisma as never);
    safeFetchSpy = jest.spyOn(safeFetchModule, 'safeFetch');
  });

  afterEach(() => {
    safeFetchSpy.mockRestore();
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  });

  // ------------------------------------------------------------------- //
  //  Gating / inert                                                     //
  // ------------------------------------------------------------------- //

  it('is INERT (400) when the env OAuth client is unset', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(svc.isConfigured()).toBe(false);
    expect(() => svc.getAuthUrl(WS_A, USER)).toThrow('Google Calendar not configured');
  });

  it('is configured only when env client AND secret-box are present', () => {
    expect(svc.isConfigured()).toBe(true);
  });

  // ------------------------------------------------------------------- //
  //  OAuth: auth url + callback                                         //
  // ------------------------------------------------------------------- //

  it('builds an auth url with the calendar scope, offline access and a state', () => {
    const { url, state } = svc.getAuthUrl(WS_A, USER);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('client-id-xyz');
    expect(u.searchParams.get('state')).toBe(state);
    expect(state.length).toBeGreaterThan(20);
  });

  it('callback exchanges the code and stores SEALED tokens (never plaintext)', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        access_token: 'ya29.PLAINTEXT-ACCESS',
        refresh_token: '1//PLAINTEXT-REFRESH',
        expires_in: 3600,
      }),
    );
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
    (prisma.googleCalendarConnection.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'conn-1',
          syncToken: null,
          channelId: null,
          resourceId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
    );

    const res = await svc.handleCallback(state, 'auth-code-123');

    // The token endpoint was hit with the auth-code grant.
    expect(safeFetchSpy).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
    // Response masks tokens entirely.
    expect(res.tokenSet).toBe(true);
    expect(JSON.stringify(res)).not.toContain('PLAINTEXT');

    // What we persisted is sealed (v1:...), and opens back to the plaintext.
    const persisted = (prisma.googleCalendarConnection.create as jest.Mock).mock
      .calls[0][0].data as { accessToken: string; refreshToken: string };
    expect(persisted.accessToken.startsWith('v1:')).toBe(true);
    expect(persisted.refreshToken.startsWith('v1:')).toBe(true);
    expect(openSecret(persisted.accessToken)).toBe('ya29.PLAINTEXT-ACCESS');
    expect(openSecret(persisted.refreshToken)).toBe('1//PLAINTEXT-REFRESH');
  });

  it('callback rejects an unknown/forged state (401)', async () => {
    await expect(svc.handleCallback('forged', 'code')).rejects.toThrow(
      'Invalid or expired OAuth state',
    );
  });

  it('state survives a process restart (stateless, sealed — not in-memory)', async () => {
    // Mint the state on one instance, then complete the callback on a BRAND NEW
    // instance with EMPTY in-memory state — this is exactly the connect→callback
    // hop across a container restart/redeploy that the old in-memory Map broke.
    const { state } = svc.getAuthUrl(WS_A, USER);
    const restarted = new GoogleCalendarService(prisma as never);

    safeFetchSpy.mockResolvedValue(
      jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    );
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
    (prisma.googleCalendarConnection.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'conn-1',
          syncToken: null,
          channelId: null,
          resourceId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
    );

    // Resolving (not throwing "Invalid or expired OAuth state") is the proof:
    // the fresh instance accepted state it never stored in memory.
    await expect(restarted.handleCallback(state, 'auth-code')).resolves.toEqual(
      expect.objectContaining({ tokenSet: true }),
    );
  });

  it('callback rejects a tampered state token (GCM auth fails → 401)', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    // Flip a char in the middle of the sealed token (guaranteed real iv/tag/ct
    // bytes, not ignored trailing padding bits); AES-GCM auth must reject it.
    const mid = Math.floor(state.length / 2);
    const swap = state[mid] === 'A' ? 'B' : 'A';
    const tampered = state.slice(0, mid) + swap + state.slice(mid + 1);
    await expect(svc.handleCallback(tampered, 'code')).rejects.toThrow(
      'Invalid or expired OAuth state',
    );
  });

  it('callback rejects when Google returns no refresh token', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ access_token: 'a', expires_in: 3600 }),
    );
    await expect(svc.handleCallback(state, 'code')).rejects.toThrow(
      /refresh token/i,
    );
  });

  it('surfaces Google\'s precise OAuth error on a failed code exchange', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    // Google answers 401 with {error:"invalid_client"} when the client_id/secret
    // pair is wrong — the message must carry that code (it's not a secret).
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ error: 'invalid_client' }, 401),
    );
    await expect(svc.handleCallback(state, 'code')).rejects.toThrow(
      'Google code exchange failed: invalid_client',
    );
  });

  // ------------------------------------------------------------------- //
  //  Token refresh on expiry                                            //
  // ------------------------------------------------------------------- //

  it('getFreshAccessToken returns the stored token when not expired', async () => {
    // Build a connection with a sealed, still-valid access token.
    const sealed = await sealViaCallback(svc, prisma, safeFetchSpy, {
      access_token: 'still-good',
      refresh_token: 'r',
      expires_in: 3600,
    });
    safeFetchSpy.mockClear();
    const token = await svc.getFreshAccessToken(sealed);
    expect(token).toBe('still-good');
    // No network call needed.
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('getFreshAccessToken refreshes via refresh_token when expired', async () => {
    const conn = await sealViaCallback(svc, prisma, safeFetchSpy, {
      access_token: 'old-access',
      refresh_token: 'the-refresh',
      expires_in: 3600,
    });
    // Force expiry.
    conn.tokenExpiresAt = new Date(Date.now() - 10_000);
    safeFetchSpy.mockClear();
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ access_token: 'NEW-access', expires_in: 3600 }),
    );
    (prisma.googleCalendarConnection.update as jest.Mock).mockResolvedValue({} as never);

    const token = await svc.getFreshAccessToken(conn);
    expect(token).toBe('NEW-access');
    // It called the token endpoint with a refresh_token grant.
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://oauth2.googleapis.com/token');
    expect(String(call[1].body)).toContain('grant_type=refresh_token');
    // It persisted the rotated (sealed) access token.
    const upd = (prisma.googleCalendarConnection.update as jest.Mock).mock.calls[0][0]
      .data as { accessToken: string };
    expect(upd.accessToken.startsWith('v1:')).toBe(true);
    expect(openSecret(upd.accessToken)).toBe('NEW-access');
  });

  // ------------------------------------------------------------------- //
  //  Cross-workspace isolation                                          //
  // ------------------------------------------------------------------- //

  it('owned() scopes by workspaceId so ws-B cannot read ws-A connection', async () => {
    // The scoped findFirst (id + workspaceId) returns null for the wrong ws.
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
    await expect(svc.owned(WS_B, 'conn-1')).rejects.toThrow(
      'Google Calendar connection not found',
    );
    expect(prisma.googleCalendarConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn-1', workspaceId: WS_B } }),
    );
  });

  it('list() masks tokens out of every row', async () => {
    prisma.googleCalendarConnection.findMany.mockResolvedValue([
      freshConn({ accessToken: 'v1:aaa:bbb:ccc', refreshToken: 'v1:ddd:eee:fff' }),
    ] as never);
    const rows = await svc.list(WS_A);
    expect(rows[0].tokenSet).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('v1:aaa');
    expect((rows[0] as Record<string, unknown>).accessToken).toBeUndefined();
    expect((rows[0] as Record<string, unknown>).refreshToken).toBeUndefined();
  });
});

// ===================================================================== //
//  Sync service (push + pull)                                           //
// ===================================================================== //

describe('GoogleCalendarSyncService (mocked Google)', () => {
  let prisma: MockPrismaClient;
  let google: GoogleCalendarService;
  let sync: GoogleCalendarSyncService;
  let bus: { on: jest.Mock; off: jest.Mock };
  let safeFetchSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-xyz';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-xyz';
    prisma = mockPrismaClient();
    google = new GoogleCalendarService(prisma as never);
    bus = { on: jest.fn(), off: jest.fn() };
    sync = new GoogleCalendarSyncService(prisma as never, bus as never, google);
    safeFetchSpy = jest.spyOn(safeFetchModule, 'safeFetch');
    // Make getFreshAccessToken trivial: stub it to return a constant.
    jest
      .spyOn(google, 'getFreshAccessToken')
      .mockResolvedValue('access-token-live');
  });
  afterEach(() => {
    safeFetchSpy.mockRestore();
    jest.restoreAllMocks();
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.MARKETING_PUBLIC_URL;
  });

  it('subscribes to BookingCreated on init and unsubscribes on destroy', () => {
    sync.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith(
      'marketing.booking.created.v1',
      expect.any(Function),
    );
    sync.onModuleDestroy();
    expect(bus.off).toHaveBeenCalled();
  });

  it('push creates a Google event and stores googleEventId on the booking', async () => {
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(
      freshConn() as never,
    );
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1',
      workspaceId: WS_A,
      name: 'Demo call',
      notes: null,
      email: 'guest@example.com',
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED',
      googleEventId: null,
    } as never);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    safeFetchSpy.mockResolvedValue(jsonResponse({ id: 'gevt-123' }));

    const eventId = await sync.pushBooking(WS_A, 'bk-1');

    expect(eventId).toBe('gevt-123');
    // POST to the events insert endpoint.
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/calendars/primary/events');
    expect(call[1].method).toBe('POST');
    // Stored the Google event id back on the booking (workspace-scoped).
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bk-1', workspaceId: WS_A },
        data: { googleEventId: 'gevt-123' },
      }),
    );
  });

  it('push is idempotent — a duplicate create (409) adopts the deterministic id, no second event', async () => {
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1',
      workspaceId: WS_A,
      name: 'Demo',
      notes: null,
      email: null,
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED',
      googleEventId: null,
    } as never);
    (prisma.booking.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    // The sibling push path already created this event ⇒ Google answers 409.
    safeFetchSpy.mockResolvedValue(jsonResponse({ error: 'duplicate' }, 409));

    const eventId = await sync.pushBooking(WS_A, 'bk-1');
    // The create carried our deterministic id (bk + booking id sans hyphens)…
    const body = JSON.parse(safeFetchSpy.mock.calls[0][1].body as string);
    expect(body.id).toBe('bkbk1');
    // …and the 409 was adopted (no throw), the id persisted so pull won't see a
    // phantom external block.
    expect(eventId).toBe('bkbk1');
    expect(prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { googleEventId: 'bkbk1' } }),
    );
  });

  it('push PATCHES an existing event when googleEventId is already set', async () => {
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      id: 'bk-1',
      workspaceId: WS_A,
      name: 'x',
      notes: null,
      email: null,
      startAt: new Date('2027-06-14T09:00:00.000Z'),
      endAt: new Date('2027-06-14T09:30:00.000Z'),
      status: 'CONFIRMED',
      googleEventId: 'gevt-existing',
    } as never);
    safeFetchSpy.mockResolvedValue(jsonResponse({ id: 'gevt-existing' }));

    await sync.pushBooking(WS_A, 'bk-1');
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/events/gevt-existing');
    expect(call[1].method).toBe('PATCH');
  });

  it('push is a no-op (and makes no Google call) when no connection exists', async () => {
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
    const res = await sync.pushBooking(WS_A, 'bk-1');
    expect(res).toBeNull();
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('cancel deletes the mirrored Google event', async () => {
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(freshConn() as never);
    prisma.booking.findFirst.mockResolvedValue({
      googleEventId: 'gevt-9',
      status: 'CONFIRMED',
    } as never);
    safeFetchSpy.mockResolvedValue(emptyResponse(204));

    const ok = await sync.cancelBooking(WS_A, 'bk-1');
    expect(ok).toBe(true);
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/events/gevt-9');
    expect(call[1].method).toBe('DELETE');
  });

  // --------------------------- PULL ---------------------------------- //

  it('pull with a syncToken upserts EXTERNAL_BUSY blocks and persists the new syncToken', async () => {
    const conn = freshConn({ syncToken: 'PREV-SYNC-TOKEN' });
    // events.list returns one external event + a fresh nextSyncToken.
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'ext-evt-1',
            status: 'confirmed',
            summary: 'External meeting',
            start: { dateTime: '2027-06-14T11:00:00.000Z' },
            end: { dateTime: '2027-06-14T12:00:00.000Z' },
          },
        ],
        nextSyncToken: 'NEW-SYNC-TOKEN',
      }),
    );
    // Not ours, and no existing busy block ⇒ create.
    prisma.booking.findFirst.mockResolvedValue(null as never);
    (prisma.booking.create as jest.Mock).mockResolvedValue({ id: 'busy-1' } as never);
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const result = await sync.pullEvents(conn as never);

    expect(result.ok).toBe(true);
    expect(result.upserted).toBe(1);
    // The request carried the stored syncToken (incremental).
    const url = safeFetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('syncToken=PREV-SYNC-TOKEN');
    // It created an EXTERNAL_BUSY booking keyed by the Google event id.
    const created = (prisma.booking.create as jest.Mock).mock.calls[0][0].data;
    expect(created.status).toBe('EXTERNAL_BUSY');
    expect(created.googleEventId).toBe('ext-evt-1');
    expect(created.workspaceId).toBe(WS_A);
    // It persisted the NEW sync token (workspace-scoped updateMany).
    expect(prisma.googleCalendarConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1', workspaceId: WS_A },
        data: { syncToken: 'NEW-SYNC-TOKEN' },
      }),
    );
  });

  it('pull deletes the busy block when the source Google event is cancelled', async () => {
    const conn = freshConn({ syncToken: 'tok' });
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        items: [{ id: 'ext-evt-1', status: 'cancelled' }],
        nextSyncToken: 'tok2',
      }),
    );
    // Not one of ours.
    prisma.booking.findFirst.mockResolvedValue(null as never);
    (prisma.booking.deleteMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const result = await sync.pullEvents(conn as never);
    expect(result.deleted).toBe(1);
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_A, googleEventId: 'ext-evt-1', status: 'EXTERNAL_BUSY' },
      }),
    );
  });

  it('pull skips events WE pushed (no echo loop)', async () => {
    const conn = freshConn({ syncToken: 'tok' });
    safeFetchSpy.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'our-mirror',
            status: 'confirmed',
            start: { dateTime: '2027-06-14T11:00:00.000Z' },
            end: { dateTime: '2027-06-14T12:00:00.000Z' },
          },
        ],
        nextSyncToken: 'tok2',
      }),
    );
    // findFirst for "ours" returns a hit ⇒ skip.
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk-ours' } as never);
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const result = await sync.pullEvents(conn as never);
    expect(result.upserted).toBe(0);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('pull resets the sync token and recovers on HTTP 410 (expired token)', async () => {
    const conn = freshConn({ syncToken: 'STALE' });
    safeFetchSpy
      // first call: 410 GONE for the stale token
      .mockResolvedValueOnce(jsonResponse({ error: 'gone' }, 410))
      // second call: a clean full pull
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextSyncToken: 'FRESH' }),
      );
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const result = await sync.pullEvents(conn as never);
    expect(result.ok).toBe(true);
    expect(result.resyncRequired).toBe(true);
    // It cleared the stale token then persisted the fresh one.
    const datas = (prisma.googleCalendarConnection.updateMany as jest.Mock).mock.calls.map(
      (c) => c[0].data,
    );
    expect(datas).toContainEqual({ syncToken: null });
    expect(datas).toContainEqual({ syncToken: 'FRESH' });
  });

  it('pull is inert (not-configured) when the env OAuth client is unset', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const result = await sync.pullEvents(freshConn() as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-configured');
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('pullByChannel resolves the connection by channel id and validates the resource', async () => {
    const conn = freshConn({ channelId: 'chan-1', resourceId: 'res-1', syncToken: 'tk' });
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(conn as never);
    safeFetchSpy.mockResolvedValue(jsonResponse({ items: [], nextSyncToken: 'tk2' }));
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const ok = await sync.pullByChannel('chan-1', 'res-1');
    expect(ok?.ok).toBe(true);

    // Wrong resource id ⇒ ignored (null), no pull.
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(conn as never);
    const bad = await sync.pullByChannel('chan-1', 'WRONG-RES');
    expect(bad).toBeNull();
  });

  // --------------------------- WATCH --------------------------------- //

  it('startWatch registers a push channel and stores id/resource/token/expiration', async () => {
    process.env.MARKETING_PUBLIC_URL = 'https://app.example.com';
    const conn = freshConn();
    const exp = Date.now() + 7 * 24 * 3600 * 1000;
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ id: 'chan-x', resourceId: 'res-x', expiration: String(exp) }),
    );
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const ok = await sync.startWatch(conn as never);
    expect(ok).toBe(true);

    // POSTed to events.watch with our webhook address, a token, web_hook type.
    const call = safeFetchSpy.mock.calls[0];
    expect(call[0]).toContain('/calendars/primary/events/watch');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body.type).toBe('web_hook');
    expect(body.address).toBe(
      'https://app.example.com/api/marketing/integrations/google-calendar/notifications',
    );
    expect(typeof body.token).toBe('string');

    // Persisted the channel resource (workspace-scoped), token matches the body.
    const data = (prisma.googleCalendarConnection.updateMany as jest.Mock).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data.channelId).toBe(body.id);
    expect(data.resourceId).toBe('res-x');
    expect(data.channelToken).toBe(body.token);
    expect(data.channelExpiration instanceof Date).toBe(true);
  });

  it('startWatch degrades to manual mode (returns false) on a Google error', async () => {
    process.env.MARKETING_PUBLIC_URL = 'https://app.example.com';
    safeFetchSpy.mockResolvedValue(
      jsonResponse({ error: 'push.webhookUrlUnauthorized' }, 401),
    );
    const ok = await sync.startWatch(freshConn() as never);
    expect(ok).toBe(false);
  });

  it('startWatch is a no-op (false) without an https MARKETING_PUBLIC_URL', async () => {
    delete process.env.MARKETING_PUBLIC_URL;
    const ok = await sync.startWatch(freshConn() as never);
    expect(ok).toBe(false);
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('startWatch registers the new channel BEFORE retiring the old (no orphan window)', async () => {
    process.env.MARKETING_PUBLIC_URL = 'https://app.example.com';
    const conn = freshConn({ channelId: 'old-chan', resourceId: 'old-res' });
    safeFetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ id: 'new', resourceId: 'r', expiration: String(Date.now() + 1e6) }),
      ) // events.watch (new) — FIRST
      .mockResolvedValueOnce(emptyResponse(204)); // channels.stop (old) — AFTER persist
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const ok = await sync.startWatch(conn as never);
    expect(ok).toBe(true);
    expect(safeFetchSpy.mock.calls[0][0]).toContain('/events/watch');
    expect(safeFetchSpy.mock.calls[1][0]).toContain('/channels/stop');
    // The channel we retire is the OLD one.
    expect(JSON.parse(safeFetchSpy.mock.calls[1][1].body as string).id).toBe('old-chan');
  });

  it('stopWatch stops the channel and clears every channel field', async () => {
    const conn = freshConn({ channelId: 'chan-1', resourceId: 'res-1', channelToken: 'tok' });
    safeFetchSpy.mockResolvedValue(emptyResponse(204));
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    await sync.stopWatch(conn as never);
    expect(safeFetchSpy.mock.calls[0][0]).toContain('/channels/stop');
    const data = (prisma.googleCalendarConnection.updateMany as jest.Mock).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data).toEqual({
      channelId: null,
      resourceId: null,
      channelToken: null,
      channelExpiration: null,
    });
  });

  it('pullByChannel rejects a forged channel token, accepts the right one', async () => {
    const conn = freshConn({
      channelId: 'chan-1',
      resourceId: 'res-1',
      channelToken: 'secret-tok',
      syncToken: 'tk',
    });
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(conn as never);
    const bad = await sync.pullByChannel('chan-1', 'res-1', 'WRONG-TOKEN');
    expect(bad).toBeNull();

    safeFetchSpy.mockResolvedValue(jsonResponse({ items: [], nextSyncToken: 'tk2' }));
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(conn as never);
    const ok = await sync.pullByChannel('chan-1', 'res-1', 'secret-tok');
    expect(ok?.ok).toBe(true);
  });

  it('renewWatches re-registers channels within the renewal window', async () => {
    process.env.MARKETING_PUBLIC_URL = 'https://app.example.com';
    const near = freshConn({
      id: 'c1',
      channelId: 'old-chan',
      resourceId: 'old-res',
      channelExpiration: new Date(Date.now() + 3600_000), // ~1h out ⇒ due
    });
    prisma.googleCalendarConnection.findMany.mockResolvedValue([near] as never);
    safeFetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ id: 'new', resourceId: 'r', expiration: String(Date.now() + 7 * 24 * 3600 * 1000) }),
      ) // events.watch (new)
      .mockResolvedValueOnce(emptyResponse(204)); // channels.stop (old)
    (prisma.googleCalendarConnection.updateMany as jest.Mock).mockResolvedValue({ count: 1 } as never);

    const res = await sync.renewWatches();
    expect(res.renewed).toBe(1);
  });

  it('ensureWatch skips re-registration when a healthy channel exists', async () => {
    const healthy = freshConn({
      channelId: 'chan-1',
      channelExpiration: new Date(Date.now() + 5 * 24 * 3600_000), // far from expiry
    });
    prisma.googleCalendarConnection.findFirst.mockResolvedValue(healthy as never);
    const ok = await sync.ensureWatch(WS_A);
    expect(ok).toBe(true);
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Helper: run a real callback so the returned connection carries SEALED tokens
 * the service can later open. Returns a mutable connection row.
 */
async function sealViaCallback(
  svc: GoogleCalendarService,
  prisma: MockPrismaClient,
  safeFetchSpy: jest.SpyInstance,
  tokens: { access_token: string; refresh_token: string; expires_in: number },
) {
  const { state } = svc.getAuthUrl(WS_A, USER);
  safeFetchSpy.mockResolvedValue(jsonResponse(tokens));
  prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
  let captured: Record<string, unknown> = {};
  (prisma.googleCalendarConnection.create as jest.Mock).mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => {
      captured = data;
      return Promise.resolve({ id: 'conn-1', syncToken: null, channelId: null, resourceId: null, createdAt: new Date(), updatedAt: new Date(), ...data });
    },
  );
  await svc.handleCallback(state, 'code');
  return {
    id: 'conn-1',
    workspaceId: WS_A,
    marketingUserId: USER,
    googleCalendarId: 'primary',
    accessToken: captured.accessToken as string,
    refreshToken: captured.refreshToken as string,
    tokenExpiresAt: captured.tokenExpiresAt as Date,
    syncToken: null as string | null,
    channelId: null as string | null,
    resourceId: null as string | null,
    channelToken: null as string | null,
    channelExpiration: null as Date | null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
