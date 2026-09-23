import 'reflect-metadata';
import { CampaignTrackingController } from './campaign-tracking.controller';
import { PublicInvoiceController } from './public-invoice.controller';
import {
  ONE_CLICK_UNSUBSCRIBE_THROTTLE,
  PUBLIC_WRITE_THROTTLE,
  TRACKING_GET_THROTTLE,
} from '../public-throttle.const';

/**
 * Unsubscribe must be a GET-confirm → POST-act flow: a GET that flipped the
 * opt-out gets silently triggered by mail-security link scanners (Safe Links,
 * Mimecast…), unsubscribing recipients who never clicked.
 */
describe('CampaignTrackingController — unsubscribe is scanner-safe', () => {
  function makeRes() {
    const res: any = { _html: '', _headers: {}, _status: 200 };
    res.set = (k: any, v?: any) => {
      if (typeof k === 'object') Object.assign(res._headers, k);
      else res._headers[k] = v;
      return res;
    };
    res.send = (b: any) => {
      res._html = b;
      return res;
    };
    res.redirect = () => res;
    res.status = (c: number) => {
      res._status = c;
      return res;
    };
    return res;
  }
  const config = { get: () => 'https://app.test' } as any;
  const make = (tracking: any) => new CampaignTrackingController(tracking, config);
  /** The default double: an English workspace and a token that resolves. */
  const trackingDouble = (over: any = {}) => ({
    unsubscribe: jest.fn().mockResolvedValue(true),
    pageLang: jest.fn().mockResolvedValue('en'),
    ...over,
  });

  it('GET renders a confirm form and does NOT change the opt-out', async () => {
    const tracking = trackingDouble({ unsubscribe: jest.fn() });
    const ctrl = make(tracking);
    const res = makeRes();
    await ctrl.unsubscribe('cr_tok', res);
    // No mutation on a GET (a link scanner must not unsubscribe anyone).
    expect(tracking.unsubscribe).not.toHaveBeenCalled();
    // It offers a POST form back to the same token.
    expect(res._html).toContain('method="POST"');
    expect(res._html).toContain('/api/public/u/cr_tok');
  });

  it('POST performs the unsubscribe and confirms it', async () => {
    const tracking = trackingDouble();
    const ctrl = make(tracking);
    const res = makeRes();
    await ctrl.unsubscribeSubmit('cr_tok', res);
    expect(tracking.unsubscribe).toHaveBeenCalledWith('cr_tok');
    expect(res._html).toContain('unsubscribed');
    expect(res._status).toBe(200);
  });

  it('POST shows "expired" for an invalid token', async () => {
    const tracking = trackingDouble({ unsubscribe: jest.fn().mockResolvedValue(false) });
    const ctrl = make(tracking);
    const res = makeRes();
    await ctrl.unsubscribeSubmit('bad', res);
    expect(res._html.toLowerCase()).toContain('expired');
    // An unknown token is not OUR failure: 200, so a provider stops retrying.
    expect(res._status).toBe(200);
  });

  it('escapes the token in the form action (no HTML injection)', async () => {
    const tracking = trackingDouble({ unsubscribe: jest.fn() });
    const ctrl = make(tracking);
    const res = makeRes();
    await ctrl.unsubscribe('a"><script>x', res);
    expect(res._html).not.toContain('<script>x');
    expect(res._html).toContain('&quot;');
  });

  /**
   * `unsubscribe-post-swallows`: a DB blip used to render "you have been
   * unsubscribed" over a flag that was never written. The 5xx is the only
   * thing that makes Gmail/Yahoo redeliver a One-Click POST.
   */
  describe('a failure is reported as a failure', () => {
    it('answers 5xx — not a success page — when the opt-out throws', async () => {
      const tracking = trackingDouble({ unsubscribe: jest.fn().mockRejectedValue(new Error('db down')) });
      const ctrl = make(tracking);
      const res = makeRes();
      await ctrl.unsubscribeSubmit('cr_tok', res);
      expect(res._status).toBeGreaterThanOrEqual(500);
      expect(res._html.toLowerCase()).not.toContain('you have been unsubscribed');
      // …and it SAYS so. The retry form alone never claimed success, but it
      // also never told the person anything had gone wrong — it looked exactly
      // like the page they had just pressed the button on.
      expect(res._html).toContain('Something went wrong');
      expect(res._html.toLowerCase()).toContain('try again');
      // Still one press away from retrying.
      expect(res._html).toContain('<form method="POST"');
    });

    it('never lets the language lookup break the opt-out', async () => {
      const tracking = trackingDouble({ pageLang: jest.fn().mockRejectedValue(new Error('db down')) });
      const ctrl = make(tracking);
      const res = makeRes();
      await ctrl.unsubscribeSubmit('cr_tok', res);
      expect(tracking.unsubscribe).toHaveBeenCalledWith('cr_tok');
      expect(res._status).toBe(200);
    });
  });

  /**
   * R1 — the lead-scoped footer link. `/api/public/ul/:token` is the URL the
   * gateway signs into workflow/drip mail; it keeps the same confirm/act split
   * and posts back to its OWN path.
   */
  describe('the lead-token route', () => {
    it('GET renders a confirm form posting back to /api/public/ul/<token>', async () => {
      const tracking = trackingDouble({ unsubscribe: jest.fn() });
      const ctrl = make(tracking);
      const res = makeRes();
      await ctrl.leadUnsubscribe('lead.tok', res);
      expect(tracking.unsubscribe).not.toHaveBeenCalled();
      expect(res._html).toContain('action="/api/public/ul/lead.tok"');
    });

    it('POST acts through the same resolver', async () => {
      const tracking = trackingDouble();
      const ctrl = make(tracking);
      const res = makeRes();
      await ctrl.leadUnsubscribeSubmit('lead.tok', res);
      expect(tracking.unsubscribe).toHaveBeenCalledWith('lead.tok');
      expect(res._html).toContain('unsubscribed');
    });

    it('answers 5xx on a failure, exactly like the campaign route', async () => {
      const tracking = trackingDouble({ unsubscribe: jest.fn().mockRejectedValue(new Error('db down')) });
      const ctrl = make(tracking);
      const res = makeRes();
      await ctrl.leadUnsubscribeSubmit('lead.tok', res);
      expect(res._status).toBeGreaterThanOrEqual(500);
    });
  });

  /**
   * `engagement-unqualified`: only the controller knows how the hit arrived, so
   * it is the one place that can tell the service. A mail-security scanner
   * fetching every link (often with HEAD) must not read as a person.
   */
  describe('the tracking routes describe the hit they got', () => {
    const req = (over: any = {}) => ({ method: 'GET', headers: {}, ...over });

    it('passes the method and the User-Agent through to the open', async () => {
      const tracking = trackingDouble({ open: jest.fn().mockResolvedValue(undefined) });
      const res = makeRes();
      await make(tracking).open('tok', req({ method: 'HEAD', headers: { 'user-agent': 'Barracuda' } }) as any, res);
      expect(tracking.open).toHaveBeenCalledWith('tok', { method: 'HEAD', ua: 'Barracuda' });
      // The pixel is still served — a broken image is a worse outcome than an
      // uncounted open, and a HEAD must not 500 either.
      expect(res._headers['Content-Type']).toBe('image/gif');
    });

    it('passes the hit through to the click and still redirects', async () => {
      const tracking = trackingDouble({ click: jest.fn().mockResolvedValue('https://shop.example/x') });
      const res = makeRes();
      res.redirect = jest.fn();
      await make(tracking).click('tok', '2', req({ headers: { 'user-agent': 'curl/8.4.0' } }) as any, res);
      // The click also carries the navigation verdict, which the pixel cannot
      // have — curl announces itself, so it is `true` here either way.
      expect(tracking.click).toHaveBeenCalledWith('tok', 2, {
        method: 'GET',
        ua: 'curl/8.4.0',
        automated: true,
      });
      expect(res.redirect).toHaveBeenCalledWith(302, 'https://shop.example/x');
    });

    it('survives a request object with no headers at all', async () => {
      const tracking = trackingDouble({ open: jest.fn().mockResolvedValue(undefined) });
      const res = makeRes();
      await make(tracking).open('tok', {} as any, res);
      expect(tracking.open).toHaveBeenCalledWith('tok', { method: 'GET', ua: null });
    });
  });

  it('renders the page in the workspace language', async () => {
    const tracking = trackingDouble({ pageLang: jest.fn().mockResolvedValue('tr') });
    const ctrl = make(tracking);
    const res = makeRes();
    await ctrl.unsubscribe('cr_tok', res);
    expect(res._html).toContain('Abonelikten');
  });

  // The unsubscribe POST is a public state-changing write (flips the lead's
  // opt-out + bumps the campaign counter), so like every other public write it
  // must carry a per-route @Throttle, not rely only on the coarse global limiter.
  describe('rate limiting', () => {
    // Count @nestjs/throttler metadata keys on a route handler, checking both
    // possible targets (the method fn and the prototype+propertyKey) so the
    // assertion never depends on the throttler's internal key string.
    const throttlerKeys = (proto: any, name: string): unknown[] => {
      const fn = proto[name];
      return [
        ...(Reflect.getMetadataKeys(fn) ?? []),
        ...(Reflect.getMetadataKeys(proto, name) ?? []),
      ].filter((k) => String(k).toUpperCase().includes('THROTTLER'));
    };
    const limitOf = (proto: any, name: string): unknown =>
      Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name]);

    it('a known public write (invoice pay) is throttled — validates the probe', () => {
      expect(throttlerKeys(PublicInvoiceController.prototype, 'pay').length).toBeGreaterThan(0);
    });

    it('throttles the unsubscribe POST', () => {
      expect(throttlerKeys(CampaignTrackingController.prototype, 'unsubscribeSubmit').length).toBeGreaterThan(0);
      expect(throttlerKeys(CampaignTrackingController.prototype, 'leadUnsubscribeSubmit').length).toBeGreaterThan(0);
    });

    // `one-click-throttle`: RFC 8058 POSTs arrive from a handful of shared
    // mailbox-provider egress IPs, so the 20/min form bucket dropped real
    // opt-outs. They get their OWN, looser bucket — never no bucket at all.
    it('uses the one-click bucket, not the 20/min form bucket', () => {
      expect(limitOf(CampaignTrackingController.prototype, 'unsubscribeSubmit')).toBe(
        ONE_CLICK_UNSUBSCRIBE_THROTTLE.default.limit,
      );
      expect(limitOf(CampaignTrackingController.prototype, 'leadUnsubscribeSubmit')).toBe(
        ONE_CLICK_UNSUBSCRIBE_THROTTLE.default.limit,
      );
      expect(ONE_CLICK_UNSUBSCRIBE_THROTTLE.default.limit).toBeGreaterThan(PUBLIC_WRITE_THROTTLE.default.limit);
      // No blockDuration: today's 60s blackout is what turned one provider
      // burst into a minute of dropped opt-outs.
      expect((ONE_CLICK_UNSUBSCRIBE_THROTTLE.default as Record<string, unknown>).blockDuration).toBeUndefined();
    });

    // The two tracking GETs write (a counter, a recipient timestamp, a workflow
    // event) and had no bucket of their own, so they fell to the global 300/min
    // IP limit — with its 60 s blackout. One office behind a NAT gateway, or a
    // security gateway detonating a blast from a few egress addresses, and a
    // 429 here is a click that vanished with nowhere for the reader to retry.
    it('gives the open pixel and the click redirect their own loose bucket', () => {
      expect(limitOf(CampaignTrackingController.prototype, 'open')).toBe(
        TRACKING_GET_THROTTLE.default.limit,
      );
      expect(limitOf(CampaignTrackingController.prototype, 'click')).toBe(
        TRACKING_GET_THROTTLE.default.limit,
      );
      expect(TRACKING_GET_THROTTLE.default.limit).toBeGreaterThanOrEqual(300);
      expect((TRACKING_GET_THROTTLE.default as Record<string, unknown>).blockDuration).toBeUndefined();
    });
  });
});

/**
 * WHO IS BEHIND THE CLICK.
 *
 * `machineHitReason` reads the User-Agent and the send time; that is all the
 * open pixel can see. A click redirect is a top-level NAVIGATION, so it also
 * carries the `Sec-Fetch-*` / `Accept` shape that a scanner cannot fake without
 * actually being a browser — the same evidence the trigger-link redirect reads
 * through the shared `isAutomatedFetch`.
 *
 * The pixel must NOT be judged that way: it is a subresource fetch, so its
 * `Sec-Fetch-Dest` is `image` and every genuine open would be read as a machine.
 */
describe('CampaignTrackingController — the click redirect uses the shared classifier', () => {
  const config = { get: () => 'https://app.test' } as any;
  const res = () => {
    const r: any = {};
    r.set = () => r;
    r.send = () => r;
    r.redirect = jest.fn(() => r);
    r.status = () => r;
    return r;
  };
  const BROWSER = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'tr-TR,tr;q=0.9',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };

  it('marks a scanner-shaped click automated, and a real navigation not', async () => {
    const tracking: any = {
      click: jest.fn().mockResolvedValue('https://acme.test/pricing'),
      pageLang: jest.fn().mockResolvedValue('en'),
    };
    const ctrl = new CampaignTrackingController(tracking, config);

    await ctrl.click('tok', '0', { method: 'GET', headers: BROWSER } as any, res());
    expect(tracking.click.mock.calls[0][2]).toMatchObject({ automated: false });

    // Present-but-wrong `Sec-Fetch-Mode` is the giveaway a detonation cannot hide.
    await ctrl.click(
      'tok',
      '0',
      { method: 'GET', headers: { ...BROWSER, 'sec-fetch-mode': 'cors' } } as any,
      res(),
    );
    expect(tracking.click.mock.calls[1][2]).toMatchObject({ automated: true });
  });

  it('never judges the open pixel by the navigation headers', async () => {
    const tracking: any = { open: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new CampaignTrackingController(tracking, config);
    // Exactly what a mail client's image load looks like. Reading this as a
    // machine would zero every open in the product.
    await ctrl.open(
      'tok',
      {
        method: 'GET',
        headers: { ...BROWSER, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', accept: 'image/*,*/*;q=0.8' },
      } as any,
      res(),
    );
    expect(tracking.open.mock.calls[0][1].automated).toBeUndefined();
  });
});
