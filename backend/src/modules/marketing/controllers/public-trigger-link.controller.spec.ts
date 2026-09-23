import 'reflect-metadata';
import { PublicTriggerLinkController } from './public-trigger-link.controller';
import { TRACKING_GET_THROTTLE } from '../public-throttle.const';

const BASE = 'https://app.test';

function makeRes() {
  return { redirect: jest.fn() } as any;
}

function makeReq(over: Record<string, any> = {}) {
  return {
    method: 'GET',
    ip: '203.0.113.9',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'tr-TR,tr;q=0.9',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      ...(over.headers ?? {}),
    },
    ...over,
  } as any;
}

describe('PublicTriggerLinkController', () => {
  let links: { click: jest.Mock };
  let ctl: PublicTriggerLinkController;

  beforeEach(() => {
    links = { click: jest.fn().mockResolvedValue('https://target.test/promo') };
    ctl = new PublicTriggerLinkController(links as any, { get: () => BASE } as any);
  });

  it('redirects to the resolved target and passes the resolved client IP', async () => {
    const res = makeRes();
    await ctl.click('promo', 'tok', makeReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://target.test/promo');
    expect(links.click.mock.calls[0][0]).toBe('promo');
    expect(links.click.mock.calls[0][1]).toMatchObject({ contactId: 'tok', ip: '203.0.113.9' });
  });

  it('uses getClientIp, not the raw left-most X-Forwarded-For hop', async () => {
    // The value is re-exported in the KVKK data export, so a spoofable hop
    // would put an attacker-chosen address into a legal document.
    const req = makeReq({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } });
    await ctl.click('promo', undefined, req, makeRes());
    expect(links.click.mock.calls[0][1].ip).toBe('203.0.113.9');
  });

  it('marks a HEAD probe as automated', async () => {
    await ctl.click('promo', undefined, makeReq({ method: 'HEAD' }), makeRes());
    expect(links.click.mock.calls[0][1].automated).toBe(true);
  });

  it('marks a mail-scanner user agent as automated', async () => {
    const req = makeReq({ headers: { 'user-agent': 'Mimecast Link Protection' } });
    await ctl.click('promo', undefined, req, makeRes());
    expect(links.click.mock.calls[0][1].automated).toBe(true);
  });

  it('does NOT mark a real browser navigation as automated', async () => {
    await ctl.click('promo', undefined, makeReq(), makeRes());
    expect(links.click.mock.calls[0][1].automated).toBe(false);
  });

  it('still redirects an automated hit — short-circuiting it is how this breaks real users', async () => {
    const res = makeRes();
    await ctl.click('promo', undefined, makeReq({ method: 'HEAD' }), res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://target.test/promo');
  });

  it('falls back to PUBLIC_BASE_URL for an unknown slug', async () => {
    links.click.mockResolvedValue(null);
    const res = makeRes();
    await ctl.click('nope', undefined, makeReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(302, BASE);
  });

  it('redirects even when recording throws', async () => {
    links.click.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await ctl.click('promo', undefined, makeReq(), res);
    expect(res.redirect).toHaveBeenCalledWith(302, BASE);
  });

  it('carries its own loose tracking bucket, never the 20/min form-submit one', () => {
    // A redirect is not a form submit: one corporate NAT gateway is the whole
    // office, and a 429 here is a click that silently went nowhere.
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      PublicTriggerLinkController.prototype.click,
    );
    expect(limit).toBe(TRACKING_GET_THROTTLE.default.limit);
    expect(TRACKING_GET_THROTTLE.default.limit).toBeGreaterThanOrEqual(300);
    expect((TRACKING_GET_THROTTLE.default as { blockDuration?: number }).blockDuration).toBeUndefined();
  });
});
