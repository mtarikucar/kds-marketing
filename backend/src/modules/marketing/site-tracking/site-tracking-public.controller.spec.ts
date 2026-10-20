import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SiteTrackingPublicController } from './site-tracking-public.controller';
import { SiteTrackingService } from './site-tracking.service';

const KEY = 'jst_0123456789abcdef0123456789abcdef';
const GIF_MAGIC = Buffer.from('GIF89a');

describe('GET /api/public/s/:siteKey/pv.gif (contract §7.3, C2)', () => {
  let app: INestApplication;
  const svc = { recordPageView: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SiteTrackingPublicController],
      providers: [{ provide: SiteTrackingService, useValue: svc }],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => svc.recordPageView.mockReset().mockResolvedValue(true));

  const get = (path = `/api/public/s/${KEY}/pv.gif?p=/urun&s=instagram&m=paid_social&c=ekim&r=l.instagram.com`) =>
    request(app.getHttpServer())
      .get(path)
      .set('referer', 'https://shop.example/urun')
      .set('user-agent', 'Mozilla/5.0 Chrome/129.0')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('answers a 1×1 GIF that is never cached, and hands the service only what it needs', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['cache-control']).toContain('no-store');
    expect((res.body as Buffer).subarray(0, 6).equals(GIF_MAGIC)).toBe(true);
    expect(svc.recordPageView).toHaveBeenCalledWith({
      siteKey: KEY,
      query: { p: '/urun', s: 'instagram', m: 'paid_social', c: 'ekim', r: 'l.instagram.com' },
      referer: 'https://shop.example/urun',
      userAgent: 'Mozilla/5.0 Chrome/129.0',
    });
  });

  it('still answers 200 GIF when nothing was written (bad key, flag off, foreign host)', async () => {
    svc.recordPageView.mockResolvedValue(false);
    const res = await get(`/api/public/s/jst_unknown/pv.gif?p=/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
  });

  it('still answers 200 GIF if the service throws — a store page must never break', async () => {
    svc.recordPageView.mockRejectedValue(new Error('boom'));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
  });

  it('passes only string query values (arrays and junk are dropped)', async () => {
    await get(`/api/public/s/${KEY}/pv.gif?p=/a&p=/b&s[x]=1&z=extra`);
    const q = svc.recordPageView.mock.calls[0][0].query;
    expect(q).toEqual({ p: undefined, s: undefined, m: undefined, c: undefined, r: undefined });
  });
});
