import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `public/jeeta.js` — the site snippet (commerce ingest contract §7). It is a
 * static file a store pastes into its own pages, so these tests load the REAL
 * file into jsdom and drive it the way a browser would: a <script> element with
 * data attributes, a page URL, a referrer, an existing cookie.
 */
const FILE = resolve(__dirname, '../../public/jeeta.js');
const SOURCE = readFileSync(FILE, 'utf8');
const KEY = 'jst_0123456789abcdef0123456789abcdef';
const COOKIE = '_jeeta_attr';

let pixels: string[] = [];
let cookieWrites: string[] = [];
const realImage = window.Image;
const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;

function load(opts: {
  url?: string;
  referrer?: string;
  attrs?: Record<string, string>;
  src?: string;
} = {}) {
  window.history.replaceState({}, '', opts.url ?? '/');
  Object.defineProperty(document, 'referrer', { value: opts.referrer ?? '', configurable: true });
  const el = document.createElement('script');
  el.src = opts.src ?? 'https://jeetagrowth.com/jeeta.js';
  const attrs = { 'data-site-key': KEY, ...(opts.attrs ?? {}) };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  Object.defineProperty(document, 'currentScript', { value: el, configurable: true });
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
}

function readCookie(): Record<string, unknown> | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  return m ? JSON.parse(decodeURIComponent(m[1])) : null;
}

function clearCookie() {
  cookieDesc.set!.call(document, `${COOKIE}=; Max-Age=0; Path=/`);
}

function pixelParams(i = 0): URL {
  return new URL(pixels[i]);
}

beforeEach(() => {
  pixels = [];
  cookieWrites = [];
  clearCookie();
  (window as any).Image = function FakeImage(this: any) {
    Object.defineProperty(this, 'src', { set: (v: string) => pixels.push(v), configurable: true });
  };
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookieDesc.get!.call(document),
    set: (v: string) => {
      cookieWrites.push(v);
      cookieDesc.set!.call(document, v);
    },
  });
  delete (window as any).jeeta;
});

afterEach(() => {
  (window as any).Image = realImage;
  delete (document as any).cookie;
  delete (document as any).currentScript;
  delete (document as any).referrer;
});

describe('jeeta.js — the file itself', () => {
  it('stays under 3 KB (contract §7.1) and under the 5 KB task budget', () => {
    expect(statSync(FILE).size).toBeLessThanOrEqual(3072);
  });

  it('is ES5: no arrow functions, let/const, template literals or classes', () => {
    const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/\b(let|const|class)\s/);
    expect(code).not.toMatch(/`/);
  });
});

describe('jeeta.js — attribution cookie (§7.2)', () => {
  it('writes _jeeta_attr for 90 days from a UTM landing, with the webhook attribution field names', () => {
    load({
      url: '/?utm_source=instagram&utm_medium=paid_social&utm_campaign=ekim-hediye&fbclid=IwAR0abc',
      referrer: 'https://l.instagram.com/',
    });
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0]).toMatch(/^_jeeta_attr=[^;]+; Max-Age=7776000; Path=\/; SameSite=Lax/);
    const attr = readCookie()!;
    expect(attr).toMatchObject({
      v: 1,
      utmSource: 'instagram',
      utmMedium: 'paid_social',
      utmCampaign: 'ekim-hediye',
      utmContent: null,
      utmTerm: null,
      fbclid: 'IwAR0abc',
      gclid: null,
      ttclid: null,
      referrer: 'https://l.instagram.com/',
    });
    expect(String(attr.landingUrl)).toContain('utm_source=instagram');
    expect(typeof attr.ts).toBe('number');
    // Exactly the webhook's `attribution` keys, plus v and ts.
    expect(Object.keys(attr).sort()).toEqual(
      ['v', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'fbclid', 'gclid', 'ttclid', 'landingUrl', 'referrer', 'ts'].sort(),
    );
  });

  it('a click id alone counts as a meaningful touch', () => {
    load({ url: '/urun?gclid=Cj0KCQ' });
    expect(readCookie()).toMatchObject({ gclid: 'Cj0KCQ', utmSource: null });
  });

  it('an external referrer without UTM refreshes it (last meaningful touch)', () => {
    load({ url: '/?utm_source=old' });
    load({ url: '/', referrer: 'https://www.google.com/' });
    expect(readCookie()).toMatchObject({ utmSource: null, referrer: 'https://www.google.com/' });
  });

  it('a direct visit does not overwrite it', () => {
    load({ url: '/?utm_source=instagram' });
    cookieWrites = [];
    load({ url: '/' });
    expect(cookieWrites).toHaveLength(0);
    expect(readCookie()).toMatchObject({ utmSource: 'instagram' });
  });

  it('in-site navigation (same-host referrer) does not overwrite it', () => {
    load({ url: '/?utm_source=instagram' });
    cookieWrites = [];
    load({ url: '/sepet', referrer: `${window.location.origin}/urun/figur` });
    expect(cookieWrites).toHaveLength(0);
  });

  it('data-consent="denied" writes no cookie but still counts the page view', () => {
    load({ url: '/?utm_source=instagram', attrs: { 'data-consent': 'denied' } });
    expect(cookieWrites).toHaveLength(0);
    expect(readCookie()).toBeNull();
    expect(pixels).toHaveLength(1);
  });

  it('keeps the cookie value within 1200 bytes, whatever the URL', () => {
    load({ url: `/?utm_source=instagram&utm_campaign=${'x'.repeat(3000)}`, referrer: `https://a.test/${'r'.repeat(3000)}` });
    const raw = cookieWrites[0].split(';')[0].slice(`${COOKIE}=`.length);
    expect(raw.length).toBeLessThanOrEqual(1200);
    expect(readCookie()).toMatchObject({ v: 1, utmSource: 'instagram' });
  });
});

describe('jeeta.js — page-view pixel (§7.3)', () => {
  it('sends one GET pixel to the script origin with path, source, medium, campaign and referrer host', () => {
    load({
      url: '/urun/figur?utm_source=instagram&utm_medium=paid_social&utm_campaign=ekim',
      referrer: 'https://l.instagram.com/x',
    });
    expect(pixels).toHaveLength(1);
    const u = pixelParams();
    expect(`${u.origin}${u.pathname}`).toBe(`https://jeetagrowth.com/api/public/s/${KEY}/pv.gif`);
    expect(u.searchParams.get('p')).toBe('/urun/figur');
    expect(u.searchParams.get('s')).toBe('instagram');
    expect(u.searchParams.get('m')).toBe('paid_social');
    expect(u.searchParams.get('c')).toBe('ekim');
    expect(u.searchParams.get('r')).toBe('l.instagram.com');
  });

  it('never sends the query string as the path', () => {
    load({ url: '/siparis/FIG-7K2M9QXA?email=a@b.test' });
    expect(pixelParams().searchParams.get('p')).toBe('/siparis/FIG-7K2M9QXA');
    expect(pixels[0]).not.toContain('a%40b.test');
  });

  it('names an external referrer as the source of a non-UTM visit', () => {
    load({ url: '/', referrer: 'https://www.google.com/search?q=figur' });
    const u = pixelParams();
    expect(u.searchParams.get('s')).toBe('www.google.com');
    expect(u.searchParams.get('m')).toBe('referral');
  });

  it('keeps the landing source for in-site pages, from the cookie', () => {
    load({ url: '/?utm_source=instagram&utm_medium=paid_social' });
    load({ url: '/sepet', referrer: `${window.location.origin}/` });
    expect(pixelParams(1).searchParams.get('s')).toBe('instagram');
    expect(pixelParams(1).searchParams.get('m')).toBe('paid_social');
  });

  it('honours data-api for a self-hosted or local API', () => {
    load({ attrs: { 'data-api': 'http://localhost:3999/' } });
    expect(pixels[0].startsWith(`http://localhost:3999/api/public/s/${KEY}/pv.gif?`)).toBe(true);
  });

  it('counts client-side navigations (pushState) once per new path', () => {
    load({ url: '/' });
    window.history.pushState({}, '', '/urun/a');
    window.history.pushState({}, '', '/urun/a');
    window.history.pushState({}, '', '/sepet');
    expect(pixels.map((p) => new URL(p).searchParams.get('p'))).toEqual(['/', '/urun/a', '/sepet']);
  });

  it('does nothing without a well-formed data-site-key', () => {
    load({ attrs: { 'data-site-key': 'nope' } });
    expect(pixels).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
  });
});
