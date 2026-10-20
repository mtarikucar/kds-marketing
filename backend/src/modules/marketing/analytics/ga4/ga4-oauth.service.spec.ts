import { randomBytes } from 'crypto';
import { Ga4OAuthService, GA4_SCOPE } from './ga4-oauth.service';
import { openSecret, sealSecret } from '../../../../common/crypto/secret-box.helper';

const WS = 'ws-1';
const USER = 'user-1';
const TEST_KEY = randomBytes(32).toString('base64');

/** A Response-like object, as fetch returns. */
function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function build(existing: Record<string, unknown> | null = null) {
  const store: { row: any } = { row: existing };
  const prisma = {
    ga4Connection: {
      findUnique: jest.fn(async () => store.row),
      upsert: jest.fn(async ({ create, update }: any) => (store.row = store.row ? { ...store.row, ...update } : { id: 'c1', ...create })),
      update: jest.fn(async ({ data }: any) => (store.row = { ...store.row, ...data })),
      deleteMany: jest.fn(async () => {
        const n = store.row ? 1 : 0;
        store.row = null;
        return { count: n };
      }),
    },
  };
  const http = { fetch: jest.fn() };
  return { prisma, http, store, svc: new Ga4OAuthService(prisma as never, http as never) };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe('Ga4OAuthService (contract §6.1, B1/B2)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.MARKETING_SECRET_KEY = TEST_KEY;
    process.env.MARKETING_PUBLIC_URL = 'https://jeetagrowth.com';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('builds the consent URL: analytics.readonly only, offline, consent, granted scopes, sealed state, GA4 callback', () => {
    const { svc } = build();
    const { url } = svc.connectUrl(WS, USER);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/analytics.readonly');
    expect(GA4_SCOPE).toBe('https://www.googleapis.com/auth/analytics.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('include_granted_scopes')).toBe('true');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
    expect(u.searchParams.get('redirect_uri')).toBe('https://jeetagrowth.com/api/marketing/integrations/ga4/callback');
    // The state carries the workspace, sealed: nothing readable, nothing forgeable.
    const state = stateOf(url);
    expect(state).not.toContain(WS);
    expect(Buffer.from(state, 'base64url').toString('utf8')).toMatch(/^v1:/);
  });

  it('refuses to start when the Google client or the secret box is missing', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { svc } = build();
    expect(() => svc.connectUrl(WS, USER)).toThrow(/not configured/i);
  });

  it('callback: exchanges the code, stores both tokens SEALED, one connection per workspace', async () => {
    const { svc, http, prisma, store } = build();
    const { url } = svc.connectUrl(WS, USER);
    http.fetch.mockResolvedValueOnce(
      json(200, { access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3599, scope: GA4_SCOPE }),
    );
    const out = await svc.handleCallback(stateOf(url), 'auth-code');
    expect(out).toEqual({ workspaceId: WS });

    const [tokenUrl, init] = http.fetch.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe('https://jeetagrowth.com/api/marketing/integrations/ga4/callback');

    const arg = prisma.ga4Connection.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: WS });
    expect(store.row.accessToken).toMatch(/^v1:/);
    expect(store.row.refreshToken).toMatch(/^v1:/);
    expect(openSecret(store.row.accessToken)).toBe('ya29.access');
    expect(openSecret(store.row.refreshToken)).toBe('1//refresh');
    expect(store.row).toMatchObject({ marketingUserId: USER, scopes: GA4_SCOPE, enabled: true, lastError: null });
    expect(JSON.stringify(arg)).not.toContain('ya29.access');
  });

  it('callback: a forged/expired state, a missing code, or no refresh token connect nothing', async () => {
    const { svc, http, prisma } = build();
    await expect(svc.handleCallback('forged', 'code')).rejects.toThrow(/state/i);
    const { url } = svc.connectUrl(WS, USER);
    await expect(svc.handleCallback(stateOf(url), '')).rejects.toThrow(/code/i);
    http.fetch.mockResolvedValueOnce(json(200, { access_token: 'a', expires_in: 3600 }));
    await expect(svc.handleCallback(stateOf(url), 'code')).rejects.toThrow(/refresh token/i);
    expect(prisma.ga4Connection.upsert).not.toHaveBeenCalled();
  });

  it('callback: surfaces Google’s OAuth error code from a failed exchange', async () => {
    const { svc, http } = build();
    const { url } = svc.connectUrl(WS, USER);
    http.fetch.mockResolvedValueOnce(json(400, { error: 'redirect_uri_mismatch' }));
    await expect(svc.handleCallback(stateOf(url), 'code')).rejects.toThrow('GA4 code exchange failed: redirect_uri_mismatch');
  });

  it('lists the GA4 properties the Google account can read (Admin API accountSummaries)', async () => {
    const { svc, http } = build(connection());
    http.fetch.mockResolvedValueOnce(
      json(200, {
        accountSummaries: [
          {
            account: 'accounts/1',
            displayName: 'Figurunica',
            propertySummaries: [
              { property: 'properties/123456789', displayName: 'figurunica.com', propertyType: 'PROPERTY_TYPE_ORDINARY' },
            ],
          },
          { account: 'accounts/2', displayName: 'Empty account' },
        ],
      }),
    );
    expect(await svc.listProperties(WS)).toEqual([
      { propertyId: 'properties/123456789', displayName: 'figurunica.com', account: 'Figurunica' },
    ]);
    const [url, init] = http.fetch.mock.calls[0];
    expect(url).toBe('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
    expect(init.headers.authorization).toBe('Bearer ya29.live');
  });

  it('selects only a property the account can actually read, and resets the sync for a backfill', async () => {
    const { svc, http, store } = build(connection({ lastSyncedAt: new Date() }));
    const summaries = json(200, {
      accountSummaries: [{ account: 'accounts/1', displayName: 'A', propertySummaries: [{ property: 'properties/123', displayName: 'Shop' }] }],
    });
    http.fetch.mockResolvedValueOnce(summaries);
    await expect(svc.selectProperty(WS, 'properties/999')).rejects.toMatchObject({ status: 400 });
    http.fetch.mockResolvedValueOnce(summaries);
    await svc.selectProperty(WS, 'properties/123');
    expect(store.row).toMatchObject({ propertyId: 'properties/123', propertyName: 'Shop', lastSyncedAt: null, lastError: null });
    await expect(svc.selectProperty(WS, 'not-a-property')).rejects.toMatchObject({ status: 400 });
  });

  it('refreshes an expired access token with the sealed refresh token, and persists the new one', async () => {
    const { svc, http, store } = build(connection({ tokenExpiresAt: new Date(Date.now() - 1000) }));
    http.fetch.mockResolvedValueOnce(json(200, { access_token: 'ya29.new', expires_in: 3600 }));
    expect(await svc.accessToken(store.row)).toBe('ya29.new');
    const body = new URLSearchParams(http.fetch.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('1//refresh');
    expect(openSecret(store.row.accessToken)).toBe('ya29.new');
    expect(store.row.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('uses a live access token as is, unless a refresh is forced', async () => {
    const { svc, http, store } = build(connection());
    expect(await svc.accessToken(store.row)).toBe('ya29.live');
    expect(http.fetch).not.toHaveBeenCalled();
    http.fetch.mockResolvedValueOnce(json(200, { access_token: 'ya29.forced', expires_in: 3600 }));
    expect(await svc.accessToken(store.row, { forceRefresh: true })).toBe('ya29.forced');
  });

  it('reports status without any token, and disconnects', async () => {
    const { svc, store } = build(connection({ propertyId: 'properties/123', propertyName: 'Shop' }));
    const s = await svc.status(WS);
    expect(s).toMatchObject({ configured: true, connected: true, propertyId: 'properties/123', propertyName: 'Shop', enabled: true });
    expect(JSON.stringify(s)).not.toMatch(/ya29|refresh|v1:/);
    await svc.disconnect(WS);
    expect(store.row).toBeNull();
    expect(await svc.status(WS)).toMatchObject({ connected: false });
  });
});

function connection(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    workspaceId: WS,
    marketingUserId: USER,
    googleEmail: null,
    propertyId: null,
    propertyName: null,
    accessToken: sealSecret('ya29.live'),
    refreshToken: sealSecret('1//refresh'),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    scopes: GA4_SCOPE,
    lastSyncedAt: null,
    lastError: null,
    enabled: true,
    ...over,
  };
}
