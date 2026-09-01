import { describe, it, expect, vi } from 'vitest';

vi.mock('./marketingApi', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import {
  engagementRate,
  followersReported,
  totalFollowers,
  type OrganicAccountRow,
  type OrganicBucket,
} from './socialInsights.service';

/**
 * The three derived helpers, which are the last thing standing between a
 * provider payload and a number on the Growth Studio's headline row.
 *
 * They are tested apart from the panel because the panel can only reach them
 * through a query, and the interesting inputs are the ones a query cannot
 * easily produce: a bucket from an older backend that is missing a field, an
 * account row whose follower count is not a reading at all. Everything here is
 * one rule stated three ways — a number we do not have is `null`, never `0` and
 * never `NaN`.
 */

const bucket = (over: Partial<OrganicBucket> = {}): OrganicBucket => ({
  impressions: 0,
  reach: 0,
  engagements: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  clicks: 0,
  videoViews: 0,
  posts: 0,
  ...over,
});

const row = (over: Partial<OrganicAccountRow> = {}): OrganicAccountRow => ({
  socialAccountId: 'a1',
  network: 'INSTAGRAM',
  displayName: '@jeeta',
  followers: 0,
  impressions: 0,
  reach: 0,
  engagements: 0,
  posts: 0,
  insightsError: null,
  ...over,
});

describe('engagementRate', () => {
  it('divides when there is something to divide by', () => {
    expect(engagementRate(bucket({ engagements: 60, impressions: 3000 }))).toBeCloseTo(2);
  });

  it('is null with no impressions, not zero', () => {
    // "Nobody saw it" and "people saw it and did not engage" are different
    // facts; a 0% badge states the second about the first.
    expect(engagementRate(bucket({ engagements: 0, impressions: 0 }))).toBeNull();
  });

  /**
   * A totals blob from an older backend, mid rolling deploy — the exact case
   * this whole module is written around (`insightsError` and
   * `accountsWithErrors` are optional for the same reason). Without the
   * finiteness guard the division is `undefined / 3000`, and the panel renders
   * the result as `NaN%`: a percentage sign after a non-number, which is the
   * loudest possible way to state something we do not know.
   */
  it('is null rather than NaN when a side of the ratio is missing', () => {
    const partial = { impressions: 3000 } as unknown as OrganicBucket;
    expect(engagementRate(partial)).toBeNull();
    expect(engagementRate({ engagements: 60, impressions: NaN })).toBeNull();
  });
});

describe('totalFollowers / followersReported', () => {
  it('sums only the accounts that reported a count', () => {
    expect(totalFollowers([row({ followers: 1200 }), row({ socialAccountId: 'a2', followers: 0 })])).toBe(
      1200,
    );
  });

  it('is null when nobody reported one', () => {
    // The backend has no third value: 0 means both "no followers" and "never
    // read", and for a connected business account the second is the likely one.
    expect(totalFollowers([row({ followers: 0 }), row({ socialAccountId: 'a2', followers: 0 })])).toBeNull();
    expect(totalFollowers([])).toBeNull();
  });

  it('never lets a non-reading poison the sum', () => {
    const bad = [row({ followers: 1200 }), row({ socialAccountId: 'a2', followers: NaN })];
    expect(totalFollowers(bad)).toBe(1200);
  });

  /**
   * The count the sum is over, which is the half a caller needs to caption an
   * honest headline: two of five accounts reporting produces a confident number
   * that is the audience of two, and nothing else on the panel says so.
   */
  it('names how many accounts the total actually covers', () => {
    const rows = [
      row({ followers: 1200 }),
      row({ socialAccountId: 'a2', followers: 0 }),
      row({ socialAccountId: 'a3', followers: 800 }),
    ];
    expect(followersReported(rows).map((r) => r.socialAccountId)).toEqual(['a1', 'a3']);
  });
});
