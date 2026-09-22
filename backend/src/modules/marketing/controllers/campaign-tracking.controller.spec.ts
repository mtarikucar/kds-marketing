import 'reflect-metadata';
import { CampaignTrackingController } from './campaign-tracking.controller';
import { PublicInvoiceController } from './public-invoice.controller';
import { ONE_CLICK_UNSUBSCRIBE_THROTTLE, PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';

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
  });
});
