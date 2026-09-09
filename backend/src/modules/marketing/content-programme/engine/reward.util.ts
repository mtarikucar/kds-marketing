/**
 * Reward of one published slot on one network, in [0, 1], against the
 * account's OWN baseline: 0.5 means "as good as this account usually does",
 * 1 means twice the baseline or better. Normalising per account is what
 * lets a 300-follower page and a 300k-follower page teach the same
 * posterior — raw counts would let the big account's noise drown the
 * signal from the small one.
 *
 * Pure functions: the learning service reads the metric rows and hands
 * them in; every intermediate number goes back in `breakdown` so the slot's
 * metrics panel can show its work.
 */

export type Goal = 'ENGAGEMENT' | 'VIEWS' | 'SAVES_SHARES' | 'LEADS' | 'COMPOSITE';

export interface MetricSnapshot {
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Link clicks (the metric row carries them): the LEADS goal's fallback signal. */
  clicks: number;
  videoViews: number;
  leads: number;
}

export interface Baseline {
  engagementRate: number;
  saveShareRate: number;
  views: number;
  source: 'account' | 'network-default';
}

/** What an account with no history is assumed to do (rates per impression / view). */
export const NETWORK_DEFAULTS = Object.freeze({ engagementRate: 0.03, saveShareRate: 0.005, views: 500 });
/** Leads have no per-account baseline yet (too sparse to take a median of): a fixed 0.2% of impressions. */
export const LEAD_RATE_BASELINE = 0.002;
/**
 * Click-through baseline for the LEADS goal when the row carries no leads.
 * WHY a fallback at all: SocialPostMetric.leads is first-party attribution
 * that no provider fills in, so a LEADS programme scored on leads alone
 * rewards every slot 0 and learns nothing. Clicks are the provider-counted
 * step right before a lead; 1% of the denominator is a typical organic CTR.
 */
export const CLICK_RATE_BASELINE = 0.01;
/** Rows an account needs before its own medians beat the network default. */
const MIN_BASELINE_ROWS = 3;
/** COMPOSITE mix: engagement first, saves/shares second, reach third. */
const COMPOSITE_WEIGHTS = Object.freeze({ engagement: 0.5, saveShare: 0.3, views: 0.2 });

const isTikTok = (network: string): boolean => network.toUpperCase() === 'TIKTOK';
const safeDiv = (num: number, den: number): number => (den > 0 ? num / den : 0);
const clip01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export type LeadSource = 'leads' | 'clicks';

export interface Rates {
  engagementRate: number;
  saveShareRate: number;
  views: number;
  leadRate: number;
  /** Which counter fed leadRate: real leads when the row has any, else clicks. */
  leadSource: LeadSource;
  /** The audience count every rate divides by; 0 means the row is not usable. */
  denominator: number;
  usable: boolean;
}

/**
 * The rates a snapshot yields on a network.
 *
 * The denominator is the first non-zero of impressions, reach, videoViews.
 * WHY not impressions alone: Meta retired `impressions` for Instagram media
 * and reports `views` instead, so a Reel row has impressions 0 and (as the
 * programme publishes video only) every Instagram slot would score as a flop
 * with an unusable row. `views` for the VIEWS goal prefers videoViews, then
 * impressions, then reach.
 *
 * TikTok's insight API has no engagements/saves counters, so its engagement
 * is (likes+comments+shares)/views and its "save-share" is shares/views.
 *
 * leadRate divides leads by the denominator when the row has any, else
 * clicks (see CLICK_RATE_BASELINE); `leadSource` says which.
 */
export function ratesOf(network: string, m: MetricSnapshot): Rates {
  const views = m.videoViews || m.impressions || m.reach || 0;
  const leadSource: LeadSource = m.leads > 0 ? 'leads' : 'clicks';
  if (isTikTok(network)) {
    const denominator = m.videoViews || 0;
    return {
      engagementRate: safeDiv(m.likes + m.comments + m.shares, denominator),
      saveShareRate: safeDiv(m.shares, denominator),
      views,
      leadRate: safeDiv(leadSource === 'leads' ? m.leads : m.clicks, denominator),
      leadSource,
      denominator,
      usable: denominator > 0,
    };
  }
  const denominator = m.impressions || m.reach || m.videoViews || 0;
  return {
    engagementRate: safeDiv(m.engagements, denominator),
    saveShareRate: safeDiv(m.saves + m.shares, denominator),
    views,
    leadRate: safeDiv(leadSource === 'leads' ? m.leads : m.clicks, denominator),
    leadSource,
    denominator,
    usable: denominator > 0,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Median rates over an account's recent posts on one network. Rows without
 * a denominator (a post the provider has not counted yet) are skipped, not
 * read as zero — three of those would otherwise drag a healthy baseline to
 * nothing. Under three usable rows the network default is used instead.
 */
export function accountBaseline(rows: MetricSnapshot[], network: string): Baseline {
  const usable = rows.map((r) => ratesOf(network, r)).filter((r) => r.usable);
  if (usable.length < MIN_BASELINE_ROWS) return { ...NETWORK_DEFAULTS, source: 'network-default' };
  const views = usable.map((r) => r.views).filter((v) => v > 0);
  return {
    engagementRate: median(usable.map((r) => r.engagementRate)),
    saveShareRate: median(usable.map((r) => r.saveShareRate)),
    views: median(views),
    source: 'account',
  };
}

/** r = clip(x / 2·baseline): the baseline itself scores 0.5, double scores 1. */
const normalise = (x: number, baseline: number): number => clip01(x / (2 * baseline));

/** The goal's reward and every number that went into it. */
export function rewardFor(goal: Goal, network: string, m: MetricSnapshot, b: Baseline): {
  reward: number; breakdown: Record<string, number | string>;
} {
  const rates = ratesOf(network, m);
  const engagementBaseline = b.engagementRate > 0 ? b.engagementRate : NETWORK_DEFAULTS.engagementRate;
  const saveShareBaseline = b.saveShareRate > 0 ? b.saveShareRate : NETWORK_DEFAULTS.saveShareRate;
  const viewsBaseline = b.views > 0 ? b.views : NETWORK_DEFAULTS.views;
  const engagementR = normalise(rates.engagementRate, engagementBaseline);
  const saveShareR = normalise(rates.saveShareRate, saveShareBaseline);
  const viewsR = normalise(rates.views, viewsBaseline);
  // A row with no leads is scored on clicks against the click baseline; the
  // breakdown's `leadSource` says which, so the metrics panel can tell.
  const leadBaseline = rates.leadSource === 'leads' ? LEAD_RATE_BASELINE : CLICK_RATE_BASELINE;
  const leadR = normalise(rates.leadRate, leadBaseline);

  let reward: number;
  switch (goal) {
    case 'ENGAGEMENT': reward = engagementR; break;
    case 'VIEWS': reward = viewsR; break;
    case 'SAVES_SHARES': reward = saveShareR; break;
    case 'LEADS': reward = leadR; break;
    default:
      reward = COMPOSITE_WEIGHTS.engagement * engagementR
        + COMPOSITE_WEIGHTS.saveShare * saveShareR
        + COMPOSITE_WEIGHTS.views * viewsR;
  }
  reward = clip01(reward);

  return {
    reward,
    breakdown: {
      impressions: m.impressions, reach: m.reach, engagements: m.engagements, likes: m.likes, comments: m.comments,
      shares: m.shares, saves: m.saves, clicks: m.clicks, videoViews: m.videoViews, leads: m.leads,
      denominator: rates.denominator,
      engagementRate: rates.engagementRate, saveShareRate: rates.saveShareRate, views: rates.views, leadRate: rates.leadRate,
      leadSource: rates.leadSource,
      engagementBaseline, saveShareBaseline, viewsBaseline, leadBaseline,
      engagementR, saveShareR, viewsR, leadR,
      reward,
    },
  };
}
