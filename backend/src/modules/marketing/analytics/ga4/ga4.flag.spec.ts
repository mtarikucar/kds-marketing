import { ga4SyncEnabled } from './ga4.flag';
import { siteTrackingEnabled } from '../../site-tracking/site-tracking.flag';

describe('GA4 / site-tracking flags (contract §9): off unless 1 | true | on', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['yes', false],
    ['1', true],
    ['true', true],
    [' ON ', true],
  ])('%p → %p', (value, expected) => {
    for (const [name, fn] of [
      ['GA4_SYNC_ENABLED', ga4SyncEnabled],
      ['SITE_TRACKING_ENABLED', siteTrackingEnabled],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      expect(fn()).toBe(expected);
    }
  });
});
