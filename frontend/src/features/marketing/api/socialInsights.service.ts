/**
 * socialInsights.service.ts — ORGANIC performance of the connected social
 * accounts. The counterpart of `ads.service.ts`, which reports the paid half.
 *
 * The distinction matters when reading a chart: `ads/metrics` is money we spent
 * and what it bought; this is what the accounts did on their own. They are never
 * summed together and never drawn on one axis.
 *
 * Everything here is provider-reported and arrives by a scheduled pull, so it is
 * hours behind rather than live — and, more importantly, it is INCOMPLETE by
 * construction: a network we hold no insights scope for returns nothing at all.
 * That is what `coverage` is for. A panel that renders a flat zero line where a
 * network simply cannot be read is worse than one that says so, because the zero
 * is indistinguishable from a real result.
 */
import marketingApi from './marketingApi';
import type { SocialNetwork } from '../../../pages/marketing/social/socialSchemas';

/** One bucket of organic counts. Every field is a non-negative integer. */
export interface OrganicBucket {
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
  /** Targets that went out in this bucket — activity, not audience. */
  posts: number;
}

/** A day's slice. The `date` is a UTC `YYYY-MM-DD`, matching the stored column. */
export type OrganicDay = Pick<
  OrganicBucket,
  'impressions' | 'reach' | 'engagements' | 'clicks' | 'videoViews' | 'posts'
> & {
  date: string;
  /**
   * How that day's `posts` split across networks, when the backend can say.
   *
   * Optional rather than always-present because a client can be served by an
   * older backend during a rolling deploy — and because a UI that stacks by
   * network must be able to tell "the split is unknown" from "everything went
   * out on one network". Absent means the caller draws one undifferentiated
   * column rather than inventing a distribution.
   */
  byNetwork?: Record<string, number>;
};

export interface OrganicNetworkBucket {
  impressions: number;
  reach: number;
  engagements: number;
  posts: number;
}

export interface OrganicAccountRow {
  socialAccountId: string;
  network: SocialNetwork | string;
  displayName: string;
  /**
   * The latest follower level observed inside the window.
   *
   * `0` means BOTH "we never managed to read this account" and "this account
   * genuinely has no followers", because the backend has no third value to
   * return. Treat it as unknown: for a connected business account the second
   * reading is vanishingly rare, and drawing a flat line along the axis for an
   * account we simply cannot measure is a fabrication, where omitting it costs
   * only a line nobody could have acted on. `coverage` carries the real story.
   */
  followers: number;
  impressions: number;
  reach: number;
  engagements: number;
  posts: number;
}

export interface OrganicFollowersDay {
  date: string;
  /** socialAccountId → follower count on that day. Absent accounts had no row. */
  byAccount: Record<string, number>;
}

/**
 * How much of the picture we actually have.
 *
 * Read this BEFORE drawing anything. `accountsWithData < accounts` means some
 * connected account contributed nothing to the numbers below, and
 * `unsupportedNetworks` names the ones that structurally cannot contribute —
 * either the platform has no organic insights API for that account type, or the
 * workspace's OAuth grant does not include the insights scope.
 */
export interface OrganicCoverage {
  accounts: number;
  accountsWithData: number;
  /** ISO instant of the most recent successful pull, or null if never pulled. */
  lastPulledAt: string | null;
  unsupportedNetworks: string[];
}

export interface SocialInsightsResponse {
  totals: OrganicBucket;
  /**
   * SPARSE — only days that have stored rows appear, so a quiet week is missing
   * entries rather than carrying zeros. Zero-fill before charting or the x-axis
   * compresses and the line lies about when things happened.
   * See `components/charts/zeroFill.ts`.
   */
  byDay: OrganicDay[];
  byNetwork: Partial<Record<string, OrganicNetworkBucket>>;
  byAccount: OrganicAccountRow[];
  followersByDay: OrganicFollowersDay[];
  coverage: OrganicCoverage;
}

export interface SocialInsightsQuery {
  /** ISO instant or `YYYY-MM-DD`. Defaults to the trailing 30 days server-side. */
  from?: string;
  to?: string;
}

export const socialInsightsKey = (q: SocialInsightsQuery = {}) =>
  ['marketing', 'social', 'insights', q.from ?? '', q.to ?? ''] as const;

/**
 * The organic read model. `reports.read`, so a rep can see it — unlike the rest
 * of the planner, which is manager-only.
 *
 * The backend rejects `to <= from` and any window wider than 180 days with a
 * 400; callers building a range picker must clamp rather than rely on catching.
 */
export const getSocialInsights = (q: SocialInsightsQuery = {}) =>
  marketingApi
    .get<SocialInsightsResponse>('/social-planner/insights', { params: q })
    .then((r) => r.data);

/**
 * Force a pull now instead of waiting for the hourly sweep.
 *
 * MANAGER + `settings.manage`, audited. It talks to every connected network in
 * series, so it is slow and rate-limit-sensitive — wire it to an explicit
 * "refresh" affordance with a spinner, never to a mount effect or a poll.
 */
export const pullSocialInsights = () =>
  marketingApi
    .post<{ posts: number; accounts: number; errors: number }>('/social-planner/insights/pull')
    .then((r) => r.data);

// ── derived helpers ──────────────────────────────────────────────────────────

/**
 * Total followers across the accounts that actually reported one; null when
 * none did.
 *
 * Null rather than 0, because "we could not read any of your accounts" and
 * "your accounts have no followers" are different facts and only one of them is
 * about the business. The headline renders an em dash for null.
 */
export const totalFollowers = (rows: OrganicAccountRow[]): number | null => {
  const known = rows.filter((r) => (r.followers ?? 0) > 0);
  return known.length ? known.reduce((n, r) => n + r.followers, 0) : null;
};

/**
 * Engagements ÷ impressions, as a percentage, or null when there is nothing to
 * divide by. Returning null rather than 0 is the point: "no impressions yet" and
 * "impressions but nobody engaged" are different facts and a 0% badge conflates
 * them.
 */
export const engagementRate = (b: Pick<OrganicBucket, 'engagements' | 'impressions'>): number | null =>
  b.impressions > 0 ? (b.engagements / b.impressions) * 100 : null;

/** True when the response carries no measurable organic activity at all. */
export const isOrganicEmpty = (r: SocialInsightsResponse | undefined): boolean =>
  !r || (r.totals.impressions === 0 && r.totals.engagements === 0 && r.totals.posts === 0);
