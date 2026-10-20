import { SiteTrackingService, normaliseSitePath } from './site-tracking.service';

const WS = 'ws-1';
const KEY = 'jst_0123456789abcdef0123456789abcdef';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function build(row: Record<string, unknown> | null = { id: 'k1', workspaceId: WS, key: KEY, status: 'ACTIVE', allowedHosts: [] }) {
  const prisma = {
    siteTrackingKey: {
      findUnique: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(row),
      create: jest.fn(async ({ data }: any) => ({ id: 'k-new', status: 'ACTIVE', createdAt: new Date(), revokedAt: null, ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
    workspace: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Europe/Istanbul' }) },
    siteTrafficDaily: { upsert: jest.fn().mockResolvedValue({}) },
  };
  return { prisma, svc: new SiteTrackingService(prisma as never) };
}

const hit = (over: Record<string, unknown> = {}) => ({
  siteKey: KEY,
  query: { p: '/urun/figur', s: 'instagram', m: 'paid_social', c: 'ekim-hediye', r: 'l.instagram.com' },
  referer: 'https://shop.example/urun/figur',
  userAgent: BROWSER_UA,
  now: new Date('2026-10-20T22:30:00.000Z'),
  ...over,
});

describe('SiteTrackingService.recordPageView (contract §7.3)', () => {
  const saved = process.env.SITE_TRACKING_ENABLED;
  beforeEach(() => {
    process.env.SITE_TRACKING_ENABLED = 'true';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SITE_TRACKING_ENABLED;
    else process.env.SITE_TRACKING_ENABLED = saved;
  });

  it('counts a view: one upsert, increment, the workspace-local day, the normalised path', async () => {
    const { svc, prisma } = build();
    expect(await svc.recordPageView(hit())).toBe(true);
    // 22:30Z on the 20th is 01:30 on the 21st in Istanbul.
    expect(prisma.siteTrafficDaily.upsert).toHaveBeenCalledWith({
      where: {
        siteKeyId_date_path_source_medium_campaign: {
          siteKeyId: 'k1',
          date: new Date('2026-10-21T00:00:00.000Z'),
          path: '/urun/figur',
          source: 'instagram',
          medium: 'paid_social',
          campaign: 'ekim-hediye',
        },
      },
      create: {
        workspaceId: WS,
        siteKeyId: 'k1',
        date: new Date('2026-10-21T00:00:00.000Z'),
        path: '/urun/figur',
        source: 'instagram',
        medium: 'paid_social',
        campaign: 'ekim-hediye',
        views: 1,
      },
      update: { views: { increment: 1 } },
    });
  });

  it('stores no visitor identity: no IP, no user agent, no referrer URL', async () => {
    const { svc, prisma } = build();
    await svc.recordPageView(hit());
    const json = JSON.stringify(prisma.siteTrafficDaily.upsert.mock.calls[0][0]);
    expect(json).not.toContain('Mozilla');
    expect(json).not.toContain('shop.example');
  });

  it('defaults an empty source to (direct) and lower-cases source/medium', async () => {
    const { svc, prisma } = build();
    await svc.recordPageView(hit({ query: { p: '/' } }));
    expect(prisma.siteTrafficDaily.upsert.mock.calls[0][0].create).toMatchObject({
      path: '/',
      source: '(direct)',
      medium: '',
      campaign: '',
    });
    await svc.recordPageView(hit({ query: { p: '/', s: 'Instagram', m: 'CPC' } }));
    expect(prisma.siteTrafficDaily.upsert.mock.calls[1][0].create).toMatchObject({ source: 'instagram', medium: 'cpc' });
  });

  it('bounds every dimension so a crafted URL cannot grow the table without limit', async () => {
    const { svc, prisma } = build();
    await svc.recordPageView(hit({ query: { p: '/', s: 'x'.repeat(500), m: 'y'.repeat(500), c: 'z'.repeat(500) } }));
    const c = prisma.siteTrafficDaily.upsert.mock.calls[0][0].create;
    expect(c.source.length).toBeLessThanOrEqual(100);
    expect(c.medium.length).toBeLessThanOrEqual(100);
    expect(c.campaign.length).toBeLessThanOrEqual(100);
  });

  it.each([
    ['an unknown key', () => build(null), {}],
    ['a revoked key', () => build({ id: 'k1', workspaceId: WS, key: KEY, status: 'REVOKED', allowedHosts: [] }), {}],
    ['a malformed key', () => build(), { siteKey: 'jst_nope' }],
    ['a bot user agent', () => build(), { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }],
    ['a headless browser', () => build(), { userAgent: 'Mozilla/5.0 HeadlessChrome/129.0' }],
    ['an unusable path', () => build(), { query: { p: 'javascript:alert(1)' } }],
  ])('writes nothing for %s', async (_label, make, over) => {
    const { svc, prisma } = make();
    expect(await svc.recordPageView(hit(over as never))).toBe(false);
    expect(prisma.siteTrafficDaily.upsert).not.toHaveBeenCalled();
  });

  it('writes nothing with SITE_TRACKING_ENABLED off, and does not even look the key up', async () => {
    process.env.SITE_TRACKING_ENABLED = 'false';
    const { svc, prisma } = build();
    expect(await svc.recordPageView(hit())).toBe(false);
    expect(prisma.siteTrackingKey.findUnique).not.toHaveBeenCalled();
  });

  it('enforces allowedHosts against the Referer host (exact, port ignored)', async () => {
    const row = { id: 'k1', workspaceId: WS, key: KEY, status: 'ACTIVE', allowedHosts: ['figurunica.com', 'www.figurunica.com'] };
    const ok = build(row);
    expect(await ok.svc.recordPageView(hit({ referer: 'https://www.figurunica.com/urun' }))).toBe(true);
    const evil = build(row);
    expect(await evil.svc.recordPageView(hit({ referer: 'https://figurunica.com.evil.test/' }))).toBe(false);
    const none = build(row);
    expect(await none.svc.recordPageView(hit({ referer: undefined }))).toBe(false);
    expect(evil.prisma.siteTrafficDaily.upsert).not.toHaveBeenCalled();
    expect(none.prisma.siteTrafficDaily.upsert).not.toHaveBeenCalled();
  });

  it('swallows a database failure (a counter must never break the store page)', async () => {
    const { svc, prisma } = build();
    prisma.siteTrafficDaily.upsert.mockRejectedValue(new Error('db down'));
    await expect(svc.recordPageView(hit())).resolves.toBe(false);
  });
});

describe('normaliseSitePath (C3)', () => {
  it.each([
    ['/siparis/FIG-7K2M9QXA?x=1', '/siparis/:id'],
    ['/siparis/FIG-7K2M9QXA', '/siparis/:id'],
    ['/urun/kisiye-ozel-figur-15cm', '/urun/kisiye-ozel-figur-15cm'],
    ['/Urun/Figur', '/urun/figur'],
    ['/orders/12345', '/orders/:id'],
    ['/t/6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b', '/t/:id'],
    ['/', '/'],
    ['', null],
    ['https://evil.test/x', null],
    [`/${'ab-'.repeat(60)}x`, null],
    [`/${'a'.repeat(200)}`, '/:id'],
  ])('%p → %p', (input, expected) => {
    expect(normaliseSitePath(input)).toBe(expected);
  });
});

describe('SiteTrackingService keys (workspace-scoped)', () => {
  it('mints jst_ + 32 hex and normalises allowed hosts', async () => {
    const { svc, prisma } = build();
    const k = await svc.createKey(WS, { label: 'Store', allowedHosts: ['https://Figurunica.com/', 'www.figurunica.com:443'] });
    expect(k.key).toMatch(/^jst_[0-9a-f]{32}$/);
    expect(prisma.siteTrackingKey.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: WS,
      label: 'Store',
      allowedHosts: ['figurunica.com', 'www.figurunica.com'],
    });
  });

  it('refuses an allowed host that is not a host name', async () => {
    const { svc } = build();
    await expect(svc.createKey(WS, { allowedHosts: ['not a host'] })).rejects.toMatchObject({ status: 400 });
  });

  it('revokes only a key of the caller workspace', async () => {
    const { svc, prisma } = build();
    prisma.siteTrackingKey.findFirst.mockResolvedValueOnce(null);
    await expect(svc.revoke('ws-other', 'k1')).rejects.toMatchObject({ status: 404 });
    expect(prisma.siteTrackingKey.findFirst).toHaveBeenCalledWith({ where: { id: 'k1', workspaceId: 'ws-other' } });
    await svc.revoke(WS, 'k1');
    expect(prisma.siteTrackingKey.update.mock.calls[0][0].data).toMatchObject({ status: 'REVOKED' });
  });

  it('lists with the snippet tag ready to paste', async () => {
    const { svc, prisma } = build();
    prisma.siteTrackingKey.findMany.mockResolvedValue([{ id: 'k1', key: KEY, label: null, allowedHosts: [], status: 'ACTIVE', createdAt: new Date(), revokedAt: null }]);
    const [k] = await svc.list(WS);
    expect(prisma.siteTrackingKey.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS });
    expect(k.snippet).toBe(`<script src="https://jeetagrowth.com/jeeta.js" data-site-key="${KEY}" async></script>`);
  });
});
