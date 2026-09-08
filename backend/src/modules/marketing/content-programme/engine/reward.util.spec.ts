import { accountBaseline, Baseline, MetricSnapshot, NETWORK_DEFAULTS, rewardFor } from './reward.util';

const snap = (over: Partial<MetricSnapshot> = {}): MetricSnapshot => ({
  impressions: 0, reach: 0, engagements: 0, likes: 0, comments: 0, shares: 0, saves: 0, videoViews: 0, leads: 0, ...over,
});
const base = (over: Partial<Baseline> = {}): Baseline => ({
  engagementRate: 0.04, saveShareRate: 0.01, views: 1000, source: 'account', ...over,
});

describe('reward.util — rewardFor', () => {
  it('scores ENGAGEMENT as engagements/impressions against twice the baseline, clipped to [0, 1]', () => {
    const m = snap({ impressions: 1000, engagements: 40 }); // rate 0.04 = baseline → 0.5
    const r = rewardFor('ENGAGEMENT', 'INSTAGRAM', m, base());
    expect(r.reward).toBeCloseTo(0.5, 9);
    expect(r.breakdown.engagementRate).toBeCloseTo(0.04, 9);
    expect(r.breakdown.engagementBaseline).toBe(0.04);
    expect(r.breakdown.engagementR).toBeCloseTo(0.5, 9);
    // 3× the baseline is still 1, never more.
    expect(rewardFor('ENGAGEMENT', 'INSTAGRAM', snap({ impressions: 1000, engagements: 120 }), base()).reward).toBe(1);
    expect(rewardFor('ENGAGEMENT', 'INSTAGRAM', snap({ impressions: 1000 }), base()).reward).toBe(0);
    // No impressions at all: the rate is 0, not NaN.
    expect(rewardFor('ENGAGEMENT', 'INSTAGRAM', snap({ engagements: 5 }), base()).reward).toBe(0);
  });

  it('uses TikTok\'s own rates: (likes+comments+shares)/videoViews and shares/videoViews', () => {
    const m = snap({ impressions: 5, engagements: 999, videoViews: 2000, likes: 50, comments: 20, shares: 10, saves: 400 });
    const r = rewardFor('COMPOSITE', 'TIKTOK', m, base({ engagementRate: 0.04, saveShareRate: 0.005, views: 1000 }));
    expect(r.breakdown.engagementRate).toBeCloseTo(80 / 2000, 9);
    expect(r.breakdown.saveShareRate).toBeCloseTo(10 / 2000, 9);
    // Saves do not count on TikTok even when reported.
    expect(r.breakdown.saveShareRate).not.toBeCloseTo(410 / 2000, 9);
    expect(r.breakdown.views).toBe(2000);
    expect(r.breakdown.engagementR).toBeCloseTo(0.5, 9);
    expect(r.breakdown.saveShareR).toBeCloseTo(0.5, 9);
    expect(r.breakdown.viewsR).toBe(1);
    expect(r.reward).toBeCloseTo(0.5 * 0.5 + 0.3 * 0.5 + 0.2 * 1, 9);
  });

  it('picks the right component per goal and falls back to impressions for views', () => {
    const m = snap({ impressions: 2000, engagements: 40, saves: 10, shares: 10, leads: 2 });
    const b = base({ engagementRate: 0.04, saveShareRate: 0.01, views: 1000 });
    expect(rewardFor('ENGAGEMENT', 'INSTAGRAM', m, b).reward).toBeCloseTo(0.25, 9); // 0.02 / 0.08
    expect(rewardFor('SAVES_SHARES', 'INSTAGRAM', m, b).reward).toBeCloseTo(0.5, 9); // 0.01 / 0.02
    expect(rewardFor('VIEWS', 'INSTAGRAM', m, b).reward).toBe(1); // views = impressions 2000 / 2000
    expect(rewardFor('VIEWS', 'INSTAGRAM', m, b).breakdown.views).toBe(2000);
    // LEADS: leads/impressions = 0.001 against the fixed 2 × 0.002 → 0.25.
    const l = rewardFor('LEADS', 'INSTAGRAM', m, b);
    expect(l.reward).toBeCloseTo(0.25, 9);
    expect(l.breakdown.leadRate).toBeCloseTo(0.001, 9);
    expect(l.breakdown.leadBaseline).toBe(0.002);
    const c = rewardFor('COMPOSITE', 'INSTAGRAM', m, b);
    expect(c.reward).toBeCloseTo(0.5 * 0.25 + 0.3 * 0.5 + 0.2 * 1, 9);
    // Every raw count travels in the breakdown so the UI can show its work.
    expect(c.breakdown).toEqual(expect.objectContaining({ impressions: 2000, engagements: 40, saves: 10, shares: 10, leads: 2, reward: c.reward }));
  });

  it('substitutes the network default for a zero baseline component', () => {
    const m = snap({ impressions: 1000, engagements: 30, saves: 5, videoViews: 500 });
    const r = rewardFor('COMPOSITE', 'INSTAGRAM', m, base({ engagementRate: 0, saveShareRate: 0, views: 0 }));
    expect(r.breakdown.engagementBaseline).toBe(NETWORK_DEFAULTS.engagementRate);
    expect(r.breakdown.saveShareBaseline).toBe(NETWORK_DEFAULTS.saveShareRate);
    expect(r.breakdown.viewsBaseline).toBe(NETWORK_DEFAULTS.views);
    expect(r.breakdown.engagementR).toBeCloseTo(0.5, 9);
    expect(r.breakdown.saveShareR).toBeCloseTo(0.5, 9);
    expect(r.breakdown.viewsR).toBeCloseTo(0.5, 9);
    expect(r.reward).toBeCloseTo(0.5, 9);
  });

  it('an unknown goal scores like COMPOSITE', () => {
    const m = snap({ impressions: 1000, engagements: 40, saves: 10 });
    expect(rewardFor('WHATEVER' as any, 'INSTAGRAM', m, base()).reward).toBe(rewardFor('COMPOSITE', 'INSTAGRAM', m, base()).reward);
  });
});

describe('reward.util — accountBaseline', () => {
  it('takes the median rate over usable rows and labels the source "account" from three rows on', () => {
    const rows = [
      snap({ impressions: 1000, engagements: 10, saves: 1, shares: 1, videoViews: 100 }), // 0.01 / 0.002
      snap({ impressions: 1000, engagements: 30, saves: 2, shares: 3, videoViews: 300 }), // 0.03 / 0.005
      snap({ impressions: 1000, engagements: 90, saves: 10, shares: 10, videoViews: 900 }), // 0.09 / 0.02
      snap({ engagements: 500 }), // no impressions: ignored, not a zero
    ];
    const b = accountBaseline(rows, 'INSTAGRAM');
    expect(b).toEqual({ engagementRate: 0.03, saveShareRate: 0.005, views: 300, source: 'account' });
  });

  it('averages the two middle rows on an even count', () => {
    const rows = [
      snap({ impressions: 100, engagements: 1 }), snap({ impressions: 100, engagements: 3 }),
      snap({ impressions: 100, engagements: 5 }), snap({ impressions: 100, engagements: 7 }),
    ];
    expect(accountBaseline(rows, 'FACEBOOK').engagementRate).toBeCloseTo(0.04, 9);
  });

  it('falls back to the network defaults with fewer than three usable rows', () => {
    const two = [snap({ impressions: 1000, engagements: 500 }), snap({ impressions: 1000, engagements: 500 })];
    expect(accountBaseline(two, 'INSTAGRAM')).toEqual({ ...NETWORK_DEFAULTS, source: 'network-default' });
    expect(accountBaseline([], 'INSTAGRAM')).toEqual({ ...NETWORK_DEFAULTS, source: 'network-default' });
    // Rows without a denominator do not count toward the three.
    const padded = [...two, snap({ engagements: 9 }), snap({ engagements: 9 })];
    expect(accountBaseline(padded, 'INSTAGRAM').source).toBe('network-default');
  });

  it('judges TikTok usability by videoViews and computes its rates from them', () => {
    const rows = [
      snap({ impressions: 1000, videoViews: 1000, likes: 10, comments: 0, shares: 0 }), // 0.01
      snap({ impressions: 1000, videoViews: 1000, likes: 20, comments: 5, shares: 5 }), // 0.03
      snap({ impressions: 1000, videoViews: 1000, likes: 40, comments: 5, shares: 5 }), // 0.05
      snap({ impressions: 1000, engagements: 900 }), // no views: ignored on TikTok
    ];
    const b = accountBaseline(rows, 'TIKTOK');
    expect(b.source).toBe('account');
    expect(b.engagementRate).toBeCloseTo(0.03, 9);
    expect(b.saveShareRate).toBeCloseTo(0.005, 9);
    expect(b.views).toBe(1000);
    // Three impressions-only rows are NOT enough on TikTok.
    const noViews = [snap({ impressions: 10, engagements: 1 }), snap({ impressions: 10, engagements: 1 }), snap({ impressions: 10, engagements: 1 })];
    expect(accountBaseline(noViews, 'TIKTOK').source).toBe('network-default');
  });
});
