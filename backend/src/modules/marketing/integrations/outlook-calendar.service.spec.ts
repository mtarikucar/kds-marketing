import { OutlookCalendarService } from './outlook-calendar.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import * as safeFetchModule from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';

/**
 * Env-gated Outlook/O365 Calendar OAuth (Microsoft MOCKED, no live creds).
 * Mirrors the Google Calendar suite: inert gating; auth-url scope+state; callback
 * exchanges the code and stores SEALED tokens; forged/expired state rejected;
 * token refresh on expiry; cross-workspace isolation; tokens masked.
 */

const WS_A = 'ws-a';
const WS_B = 'ws-b';
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

describe('Outlook Calendar integration (mocked Microsoft)', () => {
  let prisma: MockPrismaClient;
  let svc: OutlookCalendarService;
  let safeFetchSpy: jest.SpyInstance;

  beforeAll(() => { process.env.MARKETING_SECRET_KEY = MASTER_KEY; });
  afterAll(() => { delete process.env.MARKETING_SECRET_KEY; });

  beforeEach(() => {
    process.env.MS_OAUTH_CLIENT_ID = 'ms-client-id';
    process.env.MS_OAUTH_CLIENT_SECRET = 'ms-client-secret';
    process.env.MS_OAUTH_REDIRECT_URI = 'https://app.example.com';
    prisma = mockPrismaClient();
    svc = new OutlookCalendarService(prisma as never);
    safeFetchSpy = jest.spyOn(safeFetchModule, 'safeFetch');
  });
  afterEach(() => {
    safeFetchSpy.mockRestore();
    delete process.env.MS_OAUTH_CLIENT_ID;
    delete process.env.MS_OAUTH_CLIENT_SECRET;
    delete process.env.MS_OAUTH_REDIRECT_URI;
  });

  it('is INERT (400) when the env OAuth client is unset', () => {
    delete process.env.MS_OAUTH_CLIENT_ID;
    delete process.env.MS_OAUTH_CLIENT_SECRET;
    expect(svc.isConfigured()).toBe(false);
    expect(() => svc.getAuthUrl(WS_A, USER)).toThrow('Outlook Calendar not configured');
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('is configured only when env client AND secret-box are present', () => {
    expect(svc.isConfigured()).toBe(true);
  });

  it('builds an MS auth url with the calendar scope + offline access + a state', () => {
    const { url, state } = svc.getAuthUrl(WS_A, USER);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')).toContain('Calendars.ReadWrite');
    expect(u.searchParams.get('scope')).toContain('offline_access');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('ms-client-id');
    expect(u.searchParams.get('state')).toBe(state);
  });

  it('callback exchanges the code and stores SEALED tokens (never plaintext)', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    safeFetchSpy.mockResolvedValue(jsonResponse({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600 }));
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(null as never);
    (prisma.outlookCalendarConnection.create as jest.Mock).mockImplementation((a: any) =>
      Promise.resolve({ id: 'c1', ...a.data, createdAt: new Date(), updatedAt: new Date(), deltaToken: null, subscriptionId: null, clientState: null, subscriptionExpiration: null }),
    );
    const masked: any = await svc.handleCallback(state, 'auth-code');
    // tokens are sealed at rest and masked out of the response
    expect(masked.tokenSet).toBe(true);
    expect(JSON.stringify(masked)).not.toContain('AT-1');
    expect(JSON.stringify(masked)).not.toContain('RT-1');
    const data = (prisma.outlookCalendarConnection.create as jest.Mock).mock.calls[0][0].data;
    expect(openSecret(data.accessToken)).toBe('AT-1');
    expect(openSecret(data.refreshToken)).toBe('RT-1');
  });

  it('callback rejects an unknown/forged state (401)', async () => {
    await expect(svc.handleCallback('not-a-real-state', 'code')).rejects.toThrow(/Invalid or expired/);
    expect(safeFetchSpy).not.toHaveBeenCalled();
  });

  it('callback rejects when Microsoft returns no refresh token', async () => {
    const { state } = svc.getAuthUrl(WS_A, USER);
    safeFetchSpy.mockResolvedValue(jsonResponse({ access_token: 'AT-1', expires_in: 3600 }));
    await expect(svc.handleCallback(state, 'code')).rejects.toThrow(/did not return a refresh token/);
  });

  it('getFreshAccessToken refreshes via refresh_token when expired', async () => {
    const { sealSecret } = await import('../../../common/crypto/secret-box.helper');
    const conn: any = {
      id: 'c1', workspaceId: WS_A, marketingUserId: USER, outlookCalendarId: 'primary',
      accessToken: sealSecret('OLD'), refreshToken: sealSecret('RT'),
      tokenExpiresAt: new Date(Date.now() - 1000), deltaToken: null, subscriptionId: null,
      clientState: null, subscriptionExpiration: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
    };
    safeFetchSpy.mockResolvedValue(jsonResponse({ access_token: 'NEW', expires_in: 3600 }));
    (prisma.outlookCalendarConnection.update as jest.Mock).mockResolvedValue({});
    const tok = await svc.getFreshAccessToken(conn);
    expect(tok).toBe('NEW');
    const stored = (prisma.outlookCalendarConnection.update as jest.Mock).mock.calls[0][0].data;
    expect(openSecret(stored.accessToken)).toBe('NEW');
  });

  it('owned() scopes by workspaceId so ws-B cannot read ws-A connection', async () => {
    prisma.outlookCalendarConnection.findFirst.mockResolvedValue(null as never);
    await expect(svc.owned(WS_B, 'conn-a')).rejects.toThrow('not found');
    expect(prisma.outlookCalendarConnection.findFirst.mock.calls[0][0].where).toEqual({ id: 'conn-a', workspaceId: WS_B });
  });
});
