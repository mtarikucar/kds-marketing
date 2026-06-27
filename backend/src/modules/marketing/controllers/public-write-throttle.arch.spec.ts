import 'reflect-metadata';
import { PublicDocumentController } from './public-document.controller';
import { PublicEstimateController } from './public-estimate.controller';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';

/**
 * Fitness test: every UNAUTHENTICATED public WRITE endpoint must carry the
 * tight PUBLIC_WRITE_THROTTLE — the e-signature sign/decline and estimate
 * accept/decline routes mutate state (and the estimate path mints an invoice on
 * convert), yet historically fell back to only the loose 300/min global bucket
 * while every sibling public-write controller (invoice, order-form, webhook,
 * referral, site, funnels) was tightly throttled. @Throttle({ default: {...} })
 * records the limit as Reflect metadata `THROTTLER:LIMITdefault` on the handler.
 */
const LIMIT_META = 'THROTTLER:LIMITdefault';
const EXPECTED = PUBLIC_WRITE_THROTTLE.default.limit;

function throttleLimit(proto: object, method: string): unknown {
  return Reflect.getMetadata(LIMIT_META, (proto as Record<string, unknown>)[method] as object);
}

describe('public write endpoints carry PUBLIC_WRITE_THROTTLE', () => {
  it('e-signature sign + decline are throttled', () => {
    expect(throttleLimit(PublicDocumentController.prototype, 'sign')).toBe(EXPECTED);
    expect(throttleLimit(PublicDocumentController.prototype, 'decline')).toBe(EXPECTED);
  });

  it('estimate accept + decline are throttled', () => {
    expect(throttleLimit(PublicEstimateController.prototype, 'accept')).toBe(EXPECTED);
    expect(throttleLimit(PublicEstimateController.prototype, 'decline')).toBe(EXPECTED);
  });
});
