import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Ga4HttpClient } from '../../src/modules/marketing/analytics/ga4/ga4-http.client';
import { Ga4OAuthService } from '../../src/modules/marketing/analytics/ga4/ga4-oauth.service';
import { Ga4SyncCron } from '../../src/modules/marketing/analytics/ga4/ga4-sync.cron';
import { SiteTrackingService } from '../../src/modules/marketing/site-tracking/site-tracking.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * GA4 and the site snippet end to end against a REAL database, with Google
 * replaced by a fake behind Ga4HttpClient — no test property, no network.
 *
 *   connect URL → Google callback (HTTP, public route) → sealed tokens →
 *   properties → choose one → the hourly cron → ga4_daily_stats;
 *   then Google revokes access → REAUTH_REQUIRED.
 *   Pixel (HTTP) → site_traffic_daily.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** Data API v1beta shape. */
function report(dims: string[], rows: Array<[string[], number[]]>) {
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: ['sessions', 'totalUsers', 'newUsers', 'keyEvents', 'ecommercePurchases', 'purchaseRevenue'].map((name) => ({ name })),
    rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) })),
    metadata: { currencyCode: 'TRY', timeZone: 'Europe/Istanbul' },
  };
}

class FakeGoogle {
  calls: string[] = [];
  revoked = false;
  async fetch(url: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    this.calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code' && p.get('code') === 'good-code') {
        return json(200, { access_token: 'fake-access-1', refresh_token: 'fake-refresh', expires_in: 3599, scope: 'https://www.googleapis.com/auth/analytics.readonly' });
      }
      if (p.get('grant_type') === 'refresh_token') {
        return this.revoked ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: 'fake-access-2', expires_in: 3599 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.startsWith('https://analyticsadmin.googleapis.com/v1beta/accountSummaries')) {
      return json(200, {
        accountSummaries: [{ account: 'accounts/1', displayName: 'Demo shop', propertySummaries: [{ property: 'properties/424242', displayName: 'shop.example' }] }],
      });
    }
    if (url === 'https://analyticsdata.googleapis.com/v1beta/properties/424242:runReport') {
      if (this.revoked) return json(401, { error: { status: 'UNAUTHENTICATED' } });
      const dims = (JSON.parse(init.body ?? '{}').dimensions ?? []).map((d: { name: string }) => d.name);
      if (dims.length === 1) return json(200, report(['date'], [[['20261019'], [120, 100, 70, 4, 2, 6998]], [['20261020'], [80, 75, 40, 1, 1, 3499]]]));
      if (dims[1] === 'sessionSourceMedium') {
        return json(
          200,
          report(['date', 'sessionSourceMedium'], [
            [['20261020', 'instagram / paid_social'], [50, 48, 30, 1, 1, 3499]],
            [['20261020', 'google / organic'], [30, 27, 10, 0, 0, 0]],
          ]),
        );
      }
      return json(200, report(['date', 'sessionCampaignName'], [[['20261020', 'ekim-hediye'], [50, 48, 30, 1, 1, 3499]]]));
    }
    return json(404, {});
  }
}

describeRealDb('GA4 + site snippet — real DB, fake Google (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const google = new FakeGoogle();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const saved = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      GA4_SYNC_ENABLED: 'true',
      SITE_TRACKING_ENABLED: 'true',
      GOOGLE_OAUTH_CLIENT_ID: 'fake-client.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
      MARKETING_PUBLIC_URL: 'http://localhost:3999',
    });
    process.env.MARKETING_SECRET_KEY ??= randomBytes(32).toString('base64');
    ({ app, prisma } = await createRealDbTestApp((b) => b.overrideProvider(Ga4HttpClient).useValue(google)));
    await prisma.workspace.create({
      data: { id: workspaceId, slug: `ga4-${workspaceId.slice(0, 8)}`, name: 'GA4', productName: 'GA4', timezone: 'Europe/Istanbul' } as never,
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.ga4DailyStat.deleteMany({ where: { workspaceId } });
      await prisma.ga4Connection.deleteMany({ where: { workspaceId } });
      await prisma.siteTrackingKey.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await closeTestApp(app);
    process.env = saved;
  });

  it('connects: the Google callback stores a SEALED connection and sends the browser back to the panel', async () => {
    const { url } = app.get(Ga4OAuthService).connectUrl(workspaceId, userId);
    const state = new URL(url).searchParams.get('state')!;
    const res = await request(app.getHttpServer()).get('/api/marketing/integrations/ga4/callback').query({ state, code: 'good-code' });
    // eslint-disable-next-line no-console
    console.log('GET /api/marketing/integrations/ga4/callback →', res.status, res.headers.location);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3999/settings/connections?ga4=connected');
    const row = await prisma.ga4Connection.findUniqueOrThrow({ where: { workspaceId } });
    expect(row.accessToken).toMatch(/^v1:/);
    expect(row.refreshToken).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain('fake-access-1');
    expect(row).toMatchObject({ marketingUserId: userId, enabled: true, propertyId: null });
  });

  it('a forged state is refused with a coarse reason and writes nothing new', async () => {
    const res = await request(app.getHttpServer()).get('/api/marketing/integrations/ga4/callback').query({ state: 'forged', code: 'good-code' });
    expect(res.headers.location).toBe('http://localhost:3999/settings/connections?ga4=error&reason=state_invalid');
  });

  it('lists the readable properties and selects one', async () => {
    const oauth = app.get(Ga4OAuthService);
    expect(await oauth.listProperties(workspaceId)).toEqual([{ propertyId: 'properties/424242', displayName: 'shop.example', account: 'Demo shop' }]);
    const status = await oauth.selectProperty(workspaceId, 'properties/424242');
    expect(status).toMatchObject({ connected: true, propertyId: 'properties/424242', propertyName: 'shop.example', lastSyncedAt: null });
  });

  it('the hourly cron backfills the property into ga4_daily_stats', async () => {
    const out = await app.get(Ga4SyncCron).runDue(new Date());
    // eslint-disable-next-line no-console
    console.log('Ga4SyncCron.runDue →', JSON.stringify(out));
    expect(out).toMatchObject({ ran: true, synced: 1, failed: 0 });
    const rows = await prisma.ga4DailyStat.findMany({ where: { workspaceId }, orderBy: [{ date: 'asc' }, { dimension: 'asc' }, { key: 'asc' }] });
    // eslint-disable-next-line no-console
    console.log('ga4_daily_stats →', JSON.stringify(rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), dimension: r.dimension, key: r.key, sessions: r.sessions, purchaseCount: r.purchaseCount, purchaseValue: r.purchaseValue.toString(), currency: r.currency }))));
    expect(rows.map((r) => `${r.date.toISOString().slice(0, 10)} ${r.dimension} ${r.key} ${r.sessions}`)).toEqual([
      '2026-10-19 TOTAL  120',
      '2026-10-20 CAMPAIGN ekim-hediye 50',
      '2026-10-20 SOURCE_MEDIUM google / organic 30',
      '2026-10-20 SOURCE_MEDIUM instagram / paid_social 50',
      '2026-10-20 TOTAL  80',
    ]);
    expect(rows[0].purchaseValue.toString()).toBe('6998');
    expect(google.calls.filter((u) => u.endsWith(':runReport'))).toHaveLength(3);
  });

  it('a second pull replaces the same days instead of duplicating them', async () => {
    await prisma.ga4Connection.update({ where: { workspaceId }, data: { lastSyncedAt: new Date(Date.now() - 21 * 3600_000) } });
    const out = await app.get(Ga4SyncCron).runDue(new Date());
    expect(out.synced).toBe(1);
    expect(await prisma.ga4DailyStat.count({ where: { workspaceId } })).toBe(5);
  });

  it('when Google revokes access the connection stops with REAUTH_REQUIRED', async () => {
    google.revoked = true;
    await prisma.ga4Connection.update({ where: { workspaceId }, data: { lastSyncedAt: new Date(Date.now() - 21 * 3600_000) } });
    const out = await app.get(Ga4SyncCron).runDue(new Date());
    expect(out).toMatchObject({ synced: 0, failed: 1 });
    const row = await prisma.ga4Connection.findUniqueOrThrow({ where: { workspaceId } });
    expect(row).toMatchObject({ enabled: false, lastError: 'REAUTH_REQUIRED' });
    // A disabled connection is not retried every hour.
    expect((await app.get(Ga4SyncCron).runDue(new Date())).connections).toBe(0);
  });

  it('the pixel counts a browser page view into site_traffic_daily, and only for allowed hosts', async () => {
    const key = await app.get(SiteTrackingService).createKey(workspaceId, { label: 'Shop', allowedHosts: ['shop.example'] });
    const hit = (referer: string, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36') =>
      request(app.getHttpServer())
        .get(`/api/public/s/${key.key}/pv.gif`)
        .query({ p: '/siparis/FIG-7K2M9QXA', s: 'instagram', m: 'paid_social', c: 'ekim-hediye', r: 'l.instagram.com' })
        .set('referer', referer)
        .set('user-agent', ua);
    const ok = await hit('https://shop.example/siparis/FIG-7K2M9QXA');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/gif');
    await hit('https://shop.example/siparis/FIG-7K2M9QXA');
    await hit('https://evil.test/');
    await hit('https://shop.example/', 'curl/8.4.0');
    const rows = await prisma.siteTrafficDaily.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: '/siparis/:id', source: 'instagram', medium: 'paid_social', campaign: 'ekim-hediye', views: 2 });
  });
});
