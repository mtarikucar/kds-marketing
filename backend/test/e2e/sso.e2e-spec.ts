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
 * Epic G — env-gated SSO (OIDC) end to end (DB seam mocked).
 *
 * Covers: admin CRUD is OWNER/MANAGER-gated; the client secret is sealed and
 * NEVER echoed (responses carry only `clientSecretSet`); cross-workspace reads
 * 404; and the PUBLIC start endpoint is inert ("SSO not configured") when no
 * enabled connection / no workspace matches — never a crash.
 *
 * The secret-box master key is set before the app boots so `create` can seal
 * the secret; the seal/open path itself is unit-tested separately.
 */
describe('SSO/OIDC (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    // Configure the secret-box so SsoService.create can seal the clientSecret.
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await closeTestApp(app);
    // The secret-box caches the key module-side for the process lifetime, but
    // clear the env so nothing downstream inspects a stale value. No other e2e
    // spec depends on the secret-box being unconfigured.
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = (role: 'OWNER' | 'MANAGER' | 'REP' = 'OWNER') => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser({ role }) as never,
    );
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role })}`;
  };

  it('creates a connection without ever echoing the client secret', async () => {
    const auth = ownerAuth('OWNER');
    (ctx.prisma.ssoConnection.create as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'sso-1',
          provider: 'OIDC',
          enabled: false,
          allowedDomains: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/marketing/integrations/sso')
      .set('Authorization', auth)
      .send({
        issuer: 'https://idp.example.com',
        clientId: 'client-abc',
        clientSecret: 'top-secret-value',
        allowedDomains: ['acme.com'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sso-1');
    expect(res.body.clientSecretSet).toBe(true);
    // The plaintext nor the sealed blob ever leaves the API.
    expect(res.body.clientSecret).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('top-secret-value');

    // What we persisted is sealed (v1:...), not the plaintext.
    const persisted = (ctx.prisma.ssoConnection.create as jest.Mock).mock
      .calls[0][0].data as { clientSecret: string };
    expect(persisted.clientSecret).not.toBe('top-secret-value');
    expect(persisted.clientSecret.startsWith('v1:')).toBe(true);
  });

  it('rejects a non-HTTPS issuer (DTO validation)', async () => {
    const auth = ownerAuth('OWNER');
    const res = await request(app.getHttpServer())
      .post('/api/marketing/integrations/sso')
      .set('Authorization', auth)
      .send({
        issuer: 'http://idp.example.com',
        clientId: 'client-abc',
        clientSecret: 'x',
      });
    expect(res.status).toBe(400);
  });

  it('lists connections with the secret masked', async () => {
    const auth = ownerAuth('MANAGER');
    ctx.prisma.ssoConnection.findMany.mockResolvedValue([
      {
        id: 'sso-1',
        workspaceId: 'ws-1',
        provider: 'OIDC',
        issuer: 'https://idp.example.com',
        clientId: 'client-abc',
        clientSecret: 'v1:aaa:bbb:ccc',
        enabled: true,
        allowedDomains: ['acme.com'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/sso')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body[0].clientSecretSet).toBe(true);
    expect(res.body[0].clientSecret).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('v1:aaa');
  });

  it('forbids a REP from managing SSO', async () => {
    const auth = ownerAuth('REP');
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/sso')
      .set('Authorization', auth);
    expect(res.status).toBe(403);
  });

  it('404s a cross-workspace get (ws-B cannot read ws-A row)', async () => {
    const auth = ownerAuth('OWNER'); // token is for ws-1
    // The scoped findFirst (id + workspaceId) finds nothing for the other ws.
    ctx.prisma.ssoConnection.findFirst.mockResolvedValue(null as never);
    const res = await request(app.getHttpServer())
      .get('/api/marketing/integrations/sso/sso-belongs-to-other-ws')
      .set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(ctx.prisma.ssoConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sso-belongs-to-other-ws', workspaceId: 'ws-1' },
      }),
    );
  });

  it('requires auth for the admin surface', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/marketing/integrations/sso',
    );
    expect(res.status).toBe(401);
  });

  describe('public start endpoint (inert when not configured)', () => {
    it('404s "SSO not configured" for an unknown workspace', async () => {
      ctx.prisma.workspace.findFirst.mockResolvedValue(null as never);
      const res = await request(app.getHttpServer()).get(
        '/api/marketing/auth/sso/nope/start',
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('SSO not configured');
    });

    it('404s "SSO not configured" when the workspace has no enabled connection', async () => {
      ctx.prisma.workspace.findFirst.mockResolvedValue({ id: 'ws-1' } as never);
      ctx.prisma.ssoConnection.findFirst.mockResolvedValue(null as never);
      const res = await request(app.getHttpServer()).get(
        '/api/marketing/auth/sso/acme/start',
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('SSO not configured');
    });
  });

  describe('public callback', () => {
    it('401s a forged/unknown state (no live IdP needed)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/marketing/auth/sso/callback')
        .query({ state: 'forged', code: 'whatever' });
      expect(res.status).toBe(401);
    });
  });
});
