import 'reflect-metadata';
import { CampaignTrackingController } from './campaign-tracking.controller';
import { PublicInvoiceController } from './public-invoice.controller';

/**
 * Unsubscribe must be a GET-confirm → POST-act flow: a GET that flipped the
 * opt-out gets silently triggered by mail-security link scanners (Safe Links,
 * Mimecast…), unsubscribing recipients who never clicked.
 */
describe('CampaignTrackingController — unsubscribe is scanner-safe', () => {
  function makeRes() {
    const res: any = { _html: '', _headers: {} };
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
    res.status = () => res;
    return res;
  }
  const config = { get: () => 'https://app.test' } as any;

  it('GET renders a confirm form and does NOT change the opt-out', async () => {
    const tracking = { unsubscribe: jest.fn() } as any;
    const ctrl = new CampaignTrackingController(tracking, config);
    const res = makeRes();
    await ctrl.unsubscribe('cr_tok', res);
    // No mutation on a GET (a link scanner must not unsubscribe anyone).
    expect(tracking.unsubscribe).not.toHaveBeenCalled();
    // It offers a POST form back to the same token.
    expect(res._html).toContain('method="POST"');
    expect(res._html).toContain('/api/public/u/cr_tok');
  });

  it('POST performs the unsubscribe and confirms it', async () => {
    const tracking = { unsubscribe: jest.fn().mockResolvedValue(true) } as any;
    const ctrl = new CampaignTrackingController(tracking, config);
    const res = makeRes();
    await ctrl.unsubscribeSubmit('cr_tok', res);
    expect(tracking.unsubscribe).toHaveBeenCalledWith('cr_tok');
    expect(res._html).toContain('unsubscribed');
  });

  it('POST shows "expired" for an invalid token', async () => {
    const tracking = { unsubscribe: jest.fn().mockResolvedValue(false) } as any;
    const ctrl = new CampaignTrackingController(tracking, config);
    const res = makeRes();
    await ctrl.unsubscribeSubmit('bad', res);
    expect(res._html.toLowerCase()).toContain('expired');
  });

  it('escapes the token in the form action (no HTML injection)', async () => {
    const tracking = { unsubscribe: jest.fn() } as any;
    const ctrl = new CampaignTrackingController(tracking, config);
    const res = makeRes();
    await ctrl.unsubscribe('a"><script>x', res);
    expect(res._html).not.toContain('<script>x');
    expect(res._html).toContain('&quot;');
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

    it('a known public write (invoice pay) is throttled — validates the probe', () => {
      expect(throttlerKeys(PublicInvoiceController.prototype, 'pay').length).toBeGreaterThan(0);
    });

    it('throttles the unsubscribe POST', () => {
      expect(throttlerKeys(CampaignTrackingController.prototype, 'unsubscribeSubmit').length).toBeGreaterThan(0);
    });
  });
});
