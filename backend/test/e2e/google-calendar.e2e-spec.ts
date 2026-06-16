import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Env-gated Google Calendar 2-way sync end to end (DB + Google mocked).
 *
 * Covers: admin surface is OWNER/MANAGER-gated and requires auth; status
 * reports `configured`; connect returns a Google consent URL (calendar scope,
 * offline access) when configured; the listing masks OAuth tokens (never
 * echoed); cross-workspace disconnect 404s; and the whole feature is INERT
 * ("Google Calendar not configured") when the env OAuth client is unset.
 *
 * The secret-box key + env OAuth client are set before the app boots so the
 * configured-path tests work; one block clears the env client to assert inert.
 */
describe('Google Calendar sync (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 5).toString('base64');
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'e2e-google-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'e2e-google-client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.com';
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await closeTestApp(app);
    delete process.env.MARKETING_SECRET_KEY;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  });

  beforeEach(() => jest.clearAllMocks());

  const auth = (role: 'OWNER' | 'MANAGER' | 'REP' = 'OWNER') => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role })}`;
  };

  it('requires auth for the admin surface', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/marketing/integrations/google-calendar/status',
    );
    expect(res.status).toBe(401);
  });

  it('forbids a REP from managing the integration', async () => {
    const a = auth('REP');
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/google-calendar/status')
      .set('Authorization', a);
    expect(res.status).toBe(403);
  });

  it('status reports configured + the (empty) connection list', async () => {
    const a = auth('MANAGER');
    ctx.prisma.googleCalendarConnection.findMany.mockResolvedValue([] as never);
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/google-calendar/status')
      .set('Authorization', a);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.connections).toEqual([]);
  });

  it('connect returns a Google consent URL with the calendar scope + offline access', async () => {
    const a = auth('OWNER');
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/google-calendar/connect')
      .set('Authorization', a);
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('lists connections with OAuth tokens masked (never echoed)', async () => {
    const a = auth('OWNER');
    ctx.prisma.googleCalendarConnection.findMany.mockResolvedValue([
      {
        id: 'conn-1',
        workspaceId: 'ws-1',
        marketingUserId: 'mu-1',
        googleCalendarId: 'primary',
        accessToken: 'v1:aaa:bbb:ccc',
        refreshToken: 'v1:ddd:eee:fff',
        tokenExpiresAt: new Date(),
        syncToken: 'sync-xyz',
        channelId: null,
        resourceId: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/google-calendar')
      .set('Authorization', a);

    expect(res.status).toBe(200);
    expect(res.body[0].tokenSet).toBe(true);
    expect(res.body[0].accessToken).toBeUndefined();
    expect(res.body[0].refreshToken).toBeUndefined();
    // Neither the sealed blobs nor the sync token value leak.
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('v1:aaa');
    expect(blob).not.toContain('sync-xyz');
  });

  it('404s a cross-workspace disconnect (ws-1 cannot delete ws-other row)', async () => {
    const a = auth('OWNER'); // token is for ws-1
    ctx.prisma.googleCalendarConnection.findFirst.mockResolvedValue(null as never);
    const res = await request(app.getHttpServer())
      .delete('/api/marketing/integrations/google-calendar/conn-belongs-to-other-ws')
      .set('Authorization', a);
    expect(res.status).toBe(404);
    expect(ctx.prisma.googleCalendarConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-belongs-to-other-ws', workspaceId: 'ws-1' },
      }),
    );
  });

  it('disconnects an owned connection', async () => {
    const a = auth('OWNER');
    ctx.prisma.googleCalendarConnection.findFirst.mockResolvedValue({
      id: 'conn-1',
      workspaceId: 'ws-1',
    } as never);
    (ctx.prisma.googleCalendarConnection.delete as jest.Mock).mockResolvedValue(
      {} as never,
    );
    const res = await request(app.getHttpServer())
      .delete('/api/marketing/integrations/google-calendar/conn-1')
      .set('Authorization', a);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'conn-1', disconnected: true });
  });

  describe('inert when the env OAuth client is unset', () => {
    // Clear the env client for this block only; status must still answer
    // (configured:false) and connect must 400 cleanly.
    let savedId: string | undefined;
    let savedSecret: string | undefined;
    beforeAll(() => {
      savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    });
    afterAll(() => {
      if (savedId) process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
      if (savedSecret) process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
    });

    it('status reports configured:false', async () => {
      const a = auth('OWNER');
      ctx.prisma.googleCalendarConnection.findMany.mockResolvedValue([] as never);
      const res = await request(app.getHttpServer())
        .get('/api/marketing/integrations/google-calendar/status')
        .set('Authorization', a);
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
    });

    it('connect 400s "Google Calendar not configured"', async () => {
      const a = auth('OWNER');
      const res = await request(app.getHttpServer())
        .get('/api/marketing/integrations/google-calendar/connect')
        .set('Authorization', a);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Google Calendar not configured');
    });

    it('the public callback 302s back to the SPA with a coarse reason (no leak)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/marketing/integrations/google-calendar/callback')
        .query({ state: 'forged', code: 'whatever' });
      // Inert ⇒ the flow throws "not configured"; the browser is redirected to
      // the connections page with a coarse reason, never raw JSON / step detail.
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        '/settings/connections?gcal=error&reason=not_configured',
      );
    });
  });

  it('the public callback 302s with reason=state_invalid for a forged state (configured)', async () => {
    // Configured path (env client present): a forged/expired state is rejected
    // and surfaced as a coarse, actionable reason — not an opaque 400.
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/google-calendar/callback')
      .query({ state: 'forged-token', code: 'whatever' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      '/settings/connections?gcal=error&reason=state_invalid',
    );
  });
});
