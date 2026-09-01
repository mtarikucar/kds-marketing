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
  /**
   * Why this account contributed nothing, in the provider's own words — or null
   * when its last pull succeeded.
   *
   * This is the difference between "this account did badly" and "we could not
   * see this account", and only one of those is a reason to change what you
   * publish. Optional on the type because a client can be served by an older
   * backend during a rolling deploy; absent means unknown, not healthy.
   */
  insightsError?: string | null;
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
 * connected account contributed nothing to the numbers below, and the two
 * remaining fields say which KIND of nothing it is — a distinction the UI has to
 * keep, because one of them is a to-do list and the other is not.
 *
 * `unsupportedNetworks` names the networks that structurally cannot contribute:
 * the platform publishes no organic insights API for that account type at all
 * (Pinterest, Google Business Profile, a LinkedIn personal profile). Nothing to
 * retry, nothing to ask for.
 *
 * `accountsWithErrors` counts the accounts we DID try and were refused — a
 * missing scope waiting on an app review, a rate limit, a dead token. The reason
 * for each is on the account row itself (`byAccount[].insightsError`), so a
 * coverage note can name the account and quote the provider rather than
 * gesturing at a count.
 */
export interface OrganicCoverage {
  accounts: number;
  accountsWithData: number;
  /**
   * Enabled accounts whose last pull recorded a failure. Optional: an older
   * backend during a rolling deploy does not send it, and 0 and "not reported"
   * must not be drawn as the same claim.
   */
  accountsWithErrors?: number;
  /**
   * ISO instant of the most recent pull ATTEMPT, or null if the sweep has never
   * reached any account in this workspace.
   *
   * An attempt, NOT a success, and this line used to say the opposite. The
   * backend stamps `insightsPulledAt` on every failure path as well, on purpose:
   * an account that only ever fails and never got stamped would sit at the
   * nulls-first head of the oldest-first due queue forever and starve every
   * healthy account behind it. So a fresh timestamp here means "we tried
   * recently" and says nothing whatever about whether the numbers below are
   * complete — that question is `accountsWithErrors` and
   * `byAccount[].insightsError`. A staleness alarm built on this field alone
   * would sit silent through a workspace whose every account is refused.
   */
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
 * The organic read model. MANAGER **and** `reports.read` — both, not either.
 *
 * The earlier version of this line said "`reports.read`, so a rep can see it",
 * which is the opposite of what ships. `SocialPlannerController` carries a
 * class-level `@MarketingRoles('MANAGER')`, and `@RequirePermission('reports.read')`
 * on this handler NARROWS it — a custom role inside MANAGER that holds only
 * reporting access still reaches it, while the write routes' `campaigns.send`
 * does not. A permission never widens a role. The handler's own doc block says
 * exactly this; only the client-side copy was wrong, and it was wrong in the
 * dangerous direction: it is the sentence that would justify deleting
 * AccountStatsPanel's `enabled: isManager` gate and shipping a rep-facing 403.
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
 *
 * EXCLUSIVE per workspace: 409 when a pull is already in flight, whether that is
 * the hourly sweep or another manager's click. Treat it as "already happening",
 * not as a failure — the numbers are being fetched either way.
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
  const known = followersReported(rows);
  return known.length ? known.reduce((n, r) => n + r.followers, 0) : null;
};

/**
 * The accounts whose follower count we actually read, which is what
 * `totalFollowers` sums over.
 *
 * Exported because the sum on its own is only half a fact. Two of five accounts
 * reporting produces a perfectly confident-looking headline that is the audience
 * of two accounts labelled as the audience of the workspace, and nothing else on
 * the panel says so — the coverage note below the charts speaks about INSIGHTS
 * coverage, which is a different read with a different failure mode. A caller
 * that renders the total is expected to compare these two lengths and caption
 * the gap.
 *
 * `Number.isFinite` rather than a truthiness check: a follower count that
 * arrived as null, undefined or NaN is not a small audience, it is no reading,
 * and adding it to a sum poisons the whole total into NaN.
 */
export const followersReported = (rows: OrganicAccountRow[]): OrganicAccountRow[] =>
  rows.filter((r) => Number.isFinite(r.followers) && r.followers > 0);

/**
 * Engagements ÷ impressions, as a percentage, or null when there is nothing to
 * divide by. Returning null rather than 0 is the point: "no impressions yet" and
 * "impressions but nobody engaged" are different facts and a 0% badge conflates
 * them.
 *
 * BOTH sides are checked for finiteness, not just the divisor. The types say
 * every bucket field is a number, but this whole file is written on the premise
 * that a client can be served by an older backend mid-deploy — that is why
 * `insightsError` and `accountsWithErrors` are optional — and a totals blob
 * missing `engagements` divides to NaN, which the caller then renders as
 * "NaN%". A percentage sign after a non-number is the loudest possible way to
 * state something we do not know, so it is refused here rather than formatted
 * downstream: `compactNumber` and `fullNumber` already draw this same line.
 */
export const engagementRate = (b: Pick<OrganicBucket, 'engagements' | 'impressions'>): number | null =>
  Number.isFinite(b.engagements) && Number.isFinite(b.impressions) && b.impressions > 0
    ? (b.engagements / b.impressions) * 100
    : null;

/** True when the response carries no measurable organic activity at all. */
export const isOrganicEmpty = (r: SocialInsightsResponse | undefined): boolean =>
  !r || (r.totals.impressions === 0 && r.totals.engagements === 0 && r.totals.posts === 0);
