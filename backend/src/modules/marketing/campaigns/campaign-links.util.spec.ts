import {
  decodeCampaignHtml,
  extractCampaignLinks,
  extractHrefLinks,
  extractPlainLinks,
  screenCampaignLinks,
  MAX_TRACKED_LINKS,
} from './campaign-links.util';

/**
 * The tracked-link array is an INDEX: `?i=` points straight into it
 * (campaign-tracking.service.ts). So these tests pin two things — WHICH urls
 * are extracted (an `<img src>` must never be one: every image load would
 * count as a click) and in WHAT ORDER (control body, control html, then each
 * variant in the order it was handed in).
 */
describe('campaign-links.util', () => {
  describe('extractPlainLinks', () => {
    it('finds bare urls in a plain-text body (the SMS/WhatsApp and text-part source)', () => {
      expect(extractPlainLinks('Kampanya: https://shop.test/x and https://b.test')).toEqual([
        'https://shop.test/x',
        'https://b.test',
      ]);
    });

    it('dedupes a repeated url', () => {
      expect(extractPlainLinks('a https://x.test b https://x.test')).toEqual(['https://x.test']);
    });
  });

  describe('extractHrefLinks', () => {
    // The whole point of img-src-click: an image url must not become a tracked
    // link, or an image proxy (Apple MPP, Gmail) registers a click on open.
    it('takes the <a href> and leaves the <img src> alone', () => {
      const html =
        '<a href="https://shop.test/sale"><img src="https://cdn.test/logo.png" /></a>' +
        '<img src="https://cdn.test/hero.jpg">';
      expect(extractHrefLinks(html)).toEqual(['https://shop.test/sale']);
    });

    it('reads single-quoted and unquoted href values', () => {
      const html = "<a href='https://a.test'>a</a><a href=https://b.test>b</a>";
      expect(extractHrefLinks(html)).toEqual(['https://a.test', 'https://b.test']);
    });

    it('ignores non-http targets (mailto, tel, anchors, relative)', () => {
      const html =
        '<a href="mailto:x@y.test">m</a><a href="tel:+90">t</a>' +
        '<a href="#top">a</a><a href="/local">r</a><a href="https://ok.test">o</a>';
      expect(extractHrefLinks(html)).toEqual(['https://ok.test']);
    });

    it('keeps document order and dedupes', () => {
      const html = '<a href="https://b.test">b</a><a href="https://a.test">a</a><a href="https://b.test">b</a>';
      expect(extractHrefLinks(html)).toEqual(['https://b.test', 'https://a.test']);
    });
  });

  describe('decodeCampaignHtml', () => {
    it('reverses the renderer escaping so a tracked link redirects to the real url', () => {
      expect(decodeCampaignHtml('https://x.test/?a=1&amp;b=2')).toBe('https://x.test/?a=1&b=2');
    });

    it('decodes &amp; last so &amp;lt; does not become <', () => {
      expect(decodeCampaignHtml('&amp;lt;')).toBe('&lt;');
    });
  });

  describe('extractCampaignLinks', () => {
    it('unions the control text + html with every variant, in a stable order', () => {
      const links = extractCampaignLinks(
        { body: 'text https://one.test', bodyHtml: '<a href="https://two.test">x</a>' },
        [
          { body: 'v1 https://three.test', bodyHtml: null },
          { body: '', bodyHtml: '<a href="https://four.test">y</a>' },
        ],
      );
      expect(links).toEqual([
        'https://one.test',
        'https://two.test',
        'https://three.test',
        'https://four.test',
      ]);
    });

    it('still tracks a plain-text campaign body with no html at all (SMS parity)', () => {
      expect(extractCampaignLinks({ body: 'Stop by https://only.test', bodyHtml: null }, [])).toEqual([
        'https://only.test',
      ]);
    });

    it('decodes escaped html before reading the href', () => {
      const links = extractCampaignLinks(
        { body: '', bodyHtml: '<a href="https://x.test/?a=1&amp;b=2">x</a>' },
        [],
      );
      expect(links).toEqual(['https://x.test/?a=1&b=2']);
    });

    it('never emits an image url even when the same html also carries a link', () => {
      const links = extractCampaignLinks(
        {
          body: '',
          bodyHtml: '<a href="https://shop.test"><img src="https://shop.test/logo.png"></a>',
        },
        [],
      );
      expect(links).toEqual(['https://shop.test']);
    });
  });
});

/**
 * THE REDIRECTOR IS SHARED.
 *
 * `/api/public/t/c/:token?i=N` resolves its destination out of `Campaign.links`
 * on the PLATFORM's own domain, and until launch time nothing looked at what
 * went into that array beyond "starts with http". That is an open redirector
 * with a tenant's name on it: aim it at a credential-harvesting page and every
 * reputation system sees jeetagrowth.com, not the tenant.
 *
 * Screening is deliberately NARROW. Refusing a link a tenant legitimately
 * wanted is a campaign that cannot ship, so only the shapes that cannot be a
 * real marketing destination are refused — the rest is somebody else's
 * judgement call, not this function's.
 */
describe('screenCampaignLinks', () => {
  it('passes ordinary destinations, including odd but real ones', () => {
    expect(
      screenCampaignLinks([
        'https://acme.com/spring?utm_source=mail&a=b#top',
        'http://blog.acme.co.uk/2026/09/post',
        'https://acme.com:8443/portal',
      ]),
    ).toEqual({ ok: true });
  });

  it('refuses credentials smuggled into the authority', () => {
    // `https://acme.com@evil.test/` reads as Acme to a person and resolves to
    // evil.test — the oldest phishing trick there is, and never a real
    // marketing link.
    const out = screenCampaignLinks(['https://acme.com@evil.test/login']);
    expect(out).toMatchObject({ ok: false, reason: 'CREDENTIALS_IN_URL' });
    expect((out as { url: string }).url).toContain('evil.test');
  });

  it('refuses a URL that does not parse', () => {
    expect(screenCampaignLinks(['https://'])).toMatchObject({ ok: false, reason: 'UNPARSEABLE' });
  });

  it('refuses a scheme the redirect must never emit', () => {
    // Nothing should reach this array, but the redirector trusts it, so the
    // guard does not depend on the extractor having been careful.
    expect(screenCampaignLinks(['javascript:alert(1)'])).toMatchObject({ ok: false, reason: 'BAD_SCHEME' });
    expect(screenCampaignLinks(['data:text/html,<script>'])).toMatchObject({ ok: false, reason: 'BAD_SCHEME' });
  });

  it('bounds how many destinations one campaign may carry', () => {
    const many = Array.from({ length: MAX_TRACKED_LINKS + 1 }, (_, i) => `https://acme.com/${i}`);
    expect(screenCampaignLinks(many)).toMatchObject({ ok: false, reason: 'TOO_MANY' });
    expect(screenCampaignLinks(many.slice(0, MAX_TRACKED_LINKS))).toEqual({ ok: true });
  });

  it('is fine with nothing to screen', () => {
    expect(screenCampaignLinks([])).toEqual({ ok: true });
  });
});

