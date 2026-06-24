import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';
import { CustomDomainsService } from '../../src/modules/marketing/custom-domains/custom-domains.service';
import { SitesService } from '../../src/modules/marketing/sites/sites.service';

/**
 * Custom-domain Host-header middleware — REAL HTTP through the production
 * `configureApp` pipeline (D3). The unit spec drives the middleware function
 * directly; this proves it behaves the same when actually mounted on the app:
 * it serves matched custom domains, but NEVER hijacks /api, /.well-known, the
 * platform host, or an unknown host. The render itself is unit-tested
 * elsewhere, so we spy on the two collaborators the middleware captured at wire
 * time (resolveHost + renderPublic) to isolate the routing decisions.
 */
describe('Custom-domain Host middleware (e2e, real HTTP)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  let resolveHost: jest.SpyInstance;
  let renderPublic: jest.SpyInstance;

  beforeAll(async () => {
    process.env.CUSTOM_DOMAINS_ENABLED = '1'; // arm the otherwise-inert middleware
    ctx = await createTestApp();
    app = ctx.app;
    // The middleware closed over these exact singletons in app.config.ts.
    resolveHost = jest.spyOn(app.get(CustomDomainsService), 'resolveHost');
    renderPublic = jest.spyOn(app.get(SitesService), 'renderPublic');
  });

  afterAll(async () => {
    delete process.env.CUSTOM_DOMAINS_ENABLED;
    await closeTestApp(app);
  });

  beforeEach(() => {
    resolveHost.mockReset();
    renderPublic.mockReset();
  });

  it('serves the home slug for "/" on a matched (VERIFIED) custom domain', async () => {
    resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
    renderPublic.mockResolvedValue('<h1>Acme home</h1>');

    const res = await request(app.getHttpServer()).get('/').set('Host', 'shop.acme.com');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Acme home');
    // Rendered the connection's home slug.
    expect(renderPublic).toHaveBeenCalledWith('ws-1', 'home', expect.stringContaining('shop.acme.com'));
  });

  it('maps a sub-path to its slug and 404s an unknown page (without falling through)', async () => {
    resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
    renderPublic.mockResolvedValue(null); // no such published page

    const res = await request(app.getHttpServer()).get('/pricing').set('Host', 'shop.acme.com');

    expect(res.status).toBe(404);
    expect(res.text).toContain('not found');
    expect(renderPublic).toHaveBeenCalledWith('ws-1', 'pricing', expect.any(String));
  });

  it('NEVER hijacks /api even when the Host is a matched custom domain', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/marketing/leads')
      .set('Host', 'shop.acme.com');

    // Normal API behaviour (401, unauthenticated) — not custom-domain HTML.
    expect(res.status).toBe(401);
    // The middleware short-circuited before resolving / rendering anything.
    expect(resolveHost).not.toHaveBeenCalled();
    expect(renderPublic).not.toHaveBeenCalled();
  });

  it('passes through ACME HTTP-01 challenge paths untouched', async () => {
    const res = await request(app.getHttpServer())
      .get('/.well-known/acme-challenge/some-token')
      .set('Host', 'shop.acme.com');

    expect(resolveHost).not.toHaveBeenCalled();
    expect(renderPublic).not.toHaveBeenCalled();
    expect(res.status).toBe(404); // no controller for it — normal routing
  });

  it('falls through to normal routing when the host is NOT a custom domain', async () => {
    resolveHost.mockResolvedValue(null);

    const res = await request(app.getHttpServer()).get('/').set('Host', 'totally-unknown.example');

    expect(resolveHost).toHaveBeenCalled();
    expect(renderPublic).not.toHaveBeenCalled();
    expect(res.status).toBe(404); // no SPA fallback in the API process
  });

  it('falls through (never 500s) when rendering throws', async () => {
    resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
    renderPublic.mockRejectedValue(new Error('renderer boom'));

    const res = await request(app.getHttpServer()).get('/').set('Host', 'shop.acme.com');

    // The error is swallowed and the request falls through to normal routing.
    expect(res.status).toBe(404);
  });
});
