import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccountRow, isNetworkConfigured } from './network-adapters';
import {
  AccountInsights,
  fetchAccountInsights,
  fetchPostInsights,
  networkSupportsInsights,
} from './network-insights';
import { SocialPostMetricService } from './social-post-metric.service';

/** One day of the byDay series. Flow metrics only — followers live in their own series. */
export interface InsightsDay {
  /** UTC 'YYYY-MM-DD'. */
  date: string;
  impressions: number;
  reach: number;
  engagements: number;
  clicks: number;
  videoViews: number;
  /** Targets that went PUBLISHED on this day. */
  posts: number;
}

export interface InsightsTotals {
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
  posts: number;
}

export interface InsightsNetworkTotals {
  impressions: number;
  reach: number;
  engagements: number;
  posts: number;
}

export interface InsightsAccountRow {
  socialAccountId: string;
  network: string;
  displayName: string;
  /** Latest follower LEVEL inside the window (0 when we never read this account). */
  followers: number;
  impressions: number;
  reach: number;
  engagements: number;
  posts: number;
}

export interface InsightsFollowersDay {
  date: string;
  byAccount: Record<string, number>;
}

export interface InsightsCoverage {
  /** Enabled connected accounts in this workspace. */
  accounts: number;
  /** How many of them produced ANY metric row inside the window. */
  accountsWithData: number;
  /** Last time the sweep touched any account (attempt, not success). */
  lastPulledAt: string | null;
  /** Networks whose numbers can never be read, however the OAuth grant is fixed. */
  unsupportedNetworks: string[];
}

export interface InsightsSummary {
  totals: InsightsTotals;
  byDay: InsightsDay[];
  byNetwork: Record<string, InsightsNetworkTotals>;
  byAccount: InsightsAccountRow[];
  followersByDay: InsightsFollowersDay[];
  coverage: InsightsCoverage;
}

/** Fields the sweep needs off a SocialAccount — a superset of AccountRow. */
interface DueAccount extends AccountRow {
  workspaceId: string;
}

/**
 * The organic insights pipeline: pull provider numbers back for published posts
 * and connected profiles, and reduce them into the read model the charts want.
 *
 * This is the organic twin of AdAccountService.pullAccount + AdsPullService,
 * and it is written to the same rules, because those rules were learned the
 * hard way on the paid side:
 *
 *  - every write is an UPSERT on a (subject, UTC day) unique key, so a re-pull
 *    three hours later overwrites the day instead of appending a second row and
 *    silently doubling every aggregate;
 *  - every item is individually try/caught and pullWorkspace NEVER throws, so
 *    one dead token cannot abort a sweep over two hundred accounts;
 *  - every failure — including a DB write failure — stamps insightsPulledAt, so
 *    a permanently-failing account rotates to the BACK of the oldest-first due
 *    queue rather than wedging at the nulls-first front and starving the
 *    healthy accounts behind it.
 *
 * WHAT A ROW MEANS, which matters for how summary() reduces them. Every
 * provider in network-insights.ts reports post counts as LIFETIME-TO-DATE, not
 * as a daily delta: ask Instagram about a media id and it answers with the
 * total impressions that post has ever had. So a SocialPostMetric row is a
 * SNAPSHOT of a cumulative counter, and summing those rows across days would
 * report a thirty-day-old post thirty times over. summary() therefore reduces
 * to ONE row per target — the latest snapshot inside the window — and
 * attributes it to the day the post was PUBLISHED. That keeps the arithmetic
 * honest (Σ byDay === totals, exactly) and makes the series answer the question
 * a content report is actually asked: "what did the things we posted that day
 * go on to earn?".
 */
@Injectable()
export class SocialInsightsService {
  private readonly logger = new Logger(SocialInsightsService.name);

  /** Re-read an account at most this often (insights move slowly + rate limits). */
  static readonly PULL_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** Only re-read posts published inside this trailing window. */
  static readonly POST_WINDOW_DAYS = 30;
  /** Accounts touched per pullWorkspace call (a workspace cannot monopolise a tick). */
  private static readonly ACCOUNT_LIMIT = 100;
  /** Targets re-read per pullWorkspace call. */
  private static readonly TARGET_LIMIT = 500;
  /** Hard caps on the summary reads. Ordered so truncation drops the OLDEST rows. */
  private static readonly POST_METRIC_ROW_LIMIT = 50_000;
  private static readonly ACCOUNT_METRIC_ROW_LIMIT = 20_000;
  private static readonly TARGET_ROW_LIMIT = 20_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly postMetrics: SocialPostMetricService,
  ) {}

  // ────────────────────────────────────────────────────────────────── Pull

  /**
   * Refresh one workspace's organic numbers. Idempotent: both writes are
   * upserts keyed on a UTC day, so calling this four times an hour produces the
   * same rows as calling it once. Never throws — every failure is counted and
   * recorded on the account.
   *
   * `force` bypasses the every-6h staleness gate (the manual refresh button);
   * without it only accounts that are actually due are touched, which is what
   * makes the hourly cron cheap.
   */
  async pullWorkspace(
    workspaceId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ posts: number; accounts: number; errors: number }> {
    const result = { posts: 0, accounts: 0, errors: 0 };
    const now = new Date();
    const today = SocialPostMetricService.utcDay(now);
    const dueBefore = new Date(now.getTime() - SocialInsightsService.PULL_INTERVAL_MS);

    // The staleness gate is expressed as a where-fragment rather than an
    // inline ternary so `force` can drop it entirely. Note it is spread into an
    // object that ALWAYS carries workspaceId — never a `?.`-derived id, which
    // Prisma would drop and turn into a cross-tenant match.
    const stale = opts.force
      ? {}
      : { OR: [{ insightsPulledAt: null }, { insightsPulledAt: { lt: dueBefore } }] };

    let accounts: DueAccount[];
    try {
      accounts = await this.prisma.socialAccount.findMany({
        where: { workspaceId, enabled: true, ...stale },
        orderBy: { insightsPulledAt: { sort: 'asc', nulls: 'first' } },
        take: SocialInsightsService.ACCOUNT_LIMIT,
        select: {
          id: true,
          workspaceId: true,
          network: true,
          externalId: true,
          accessToken: true,
          accountType: true,
        },
      });
    } catch (e) {
      this.logger.error(`insights pull: due-account read failed for ${workspaceId}: ${(e as Error)?.message ?? e}`);
      return result;
    }
    if (accounts.length === 0) return result;

    // Targets are loaded once for the whole batch rather than per account: one
    // indexed read beats N, and grouping them here keeps the per-account loop
    // below a straight line.
    //
    // Caught for the same reason the due-account read above is, and then one
    // reason more. This method's contract is that it NEVER throws; an
    // unguarded await here breaks that on any DB hiccup, and the damage does
    // not stop at the exception. Every account in this batch would leave the
    // method without its insightsPulledAt stamped, so all of them stay pinned
    // at the nulls-first head of the oldest-first due queue and are retried
    // first on the next tick — where the same hiccup starves every healthy
    // account behind them, indefinitely. Continuing with an empty Map costs
    // this workspace one tick of post metrics; the account snapshots and the
    // stamping still happen.
    const since = new Date(now.getTime() - SocialInsightsService.POST_WINDOW_DAYS * 86_400_000);
    let byAccount = new Map<string, Array<{ id: string; externalPostId: string }>>();
    try {
      byAccount = await this.dueTargets(workspaceId, accounts.map((a) => a.id), since);
    } catch (e) {
      result.errors++;
      this.logger.error(
        `insights pull: due-target read failed for ${workspaceId}: ${(e as Error)?.message ?? e}`,
      );
    }

    for (const account of accounts) {
      // One account can never abort the sweep: everything below is inside this
      // try, including the bookkeeping write, and the catch still stamps the
      // account so it rotates out of the front of the due queue.
      try {
        const outcome = await this.pullAccount(workspaceId, account, byAccount.get(account.id) ?? [], today);
        result.accounts += outcome.accountWritten ? 1 : 0;
        result.posts += outcome.postsWritten;
        result.errors += outcome.errors;
        await this.stamp(workspaceId, account.id, outcome.error, outcome.authFailed);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        this.logger.error(`insights pull: account ${account.id} failed: ${msg}`);
        result.errors++;
        await this.stamp(workspaceId, account.id, msg.slice(0, 500), false);
      }
    }

    return result;
  }

  /**
   * Published targets of the given accounts whose post went out inside the
   * trailing window, grouped by account. Targets whose account is not in this
   * tick's due set are deliberately absent: the every-6h gate is an ACCOUNT
   * property, and re-reading a post while skipping its account would put the
   * two halves of the same picture on different clocks.
   */
  private async dueTargets(
    workspaceId: string,
    accountIds: string[],
    since: Date,
  ): Promise<Map<string, Array<{ id: string; externalPostId: string }>>> {
    const out = new Map<string, Array<{ id: string; externalPostId: string }>>();
    if (accountIds.length === 0) return out;
    const targets = await this.prisma.socialPostTarget.findMany({
      where: {
        workspaceId,
        socialAccountId: { in: accountIds },
        status: 'PUBLISHED',
        externalPostId: { not: null },
        post: { publishedAt: { gte: since } },
      },
      orderBy: { post: { publishedAt: 'desc' } },
      take: SocialInsightsService.TARGET_LIMIT,
      select: { id: true, socialAccountId: true, externalPostId: true },
    });
    for (const t of targets) {
      const list = out.get(t.socialAccountId) ?? [];
      list.push({ id: t.id, externalPostId: t.externalPostId });
      out.set(t.socialAccountId, list);
    }
    return out;
  }

  /**
   * Read one account and its due posts. Returns what happened rather than
   * writing the bookkeeping itself, so the caller stamps exactly once per
   * account whatever path was taken.
   */
  private async pullAccount(
    workspaceId: string,
    account: DueAccount,
    targets: Array<{ id: string; externalPostId: string }>,
    today: Date,
  ): Promise<{ accountWritten: boolean; postsWritten: number; errors: number; error: string | null; authFailed: boolean }> {
    const outcome = { accountWritten: false, postsWritten: 0, errors: 0, error: null as string | null, authFailed: false };

    // Two different kinds of "skip", kept apart because they mean different
    // things to the owner. An unconfigured network is a PLATFORM gap (nobody
    // set META_APP_ID) and is worth recording; an unsupported one is a
    // permanent property of the provider and is reported through
    // coverage.unsupportedNetworks instead of as a per-account error. Both
    // still stamp insightsPulledAt via the caller, so a skipped account stops
    // occupying the front of the due queue.
    if (!networkSupportsInsights(account.network)) return outcome;
    if (!isNetworkConfigured(account.network)) {
      outcome.error = `${account.network} is not configured on this platform`;
      return outcome;
    }

    const acct = await fetchAccountInsights(account);
    if (acct.ok && acct.data && !acct.unsupported) {
      const written = await this.writeAccountMetric(workspaceId, account.id, today, acct.data);
      if (written) outcome.accountWritten = true;
      else {
        outcome.errors++;
        outcome.error = outcome.error ?? 'account metric write failed';
      }
    } else if (!acct.ok) {
      outcome.errors++;
      outcome.error = outcome.error ?? acct.error ?? 'account insights failed';
      if (acct.isAuthError) {
        outcome.authFailed = true;
        // The account read has just PROVEN this credential is dead. Every post
        // below would be fetched with the same token and fail the same way, so
        // walking the loop only burns the provider's rate limit on calls whose
        // answer we already have — and on a workspace with fifty published
        // posts it does it fifty times per account per sweep. The post loop has
        // the mirror-image guard for the same reason (it breaks on the first
        // auth failure); this is the earlier and cheaper place to stop.
        return outcome;
      }
    }

    for (const target of targets) {
      const res = await fetchPostInsights(account, target.externalPostId);
      if (res.ok && res.data && !res.unsupported) {
        try {
          await this.postMetrics.upsert(workspaceId, target.id, today, res.data);
          outcome.postsWritten++;
        } catch (e) {
          outcome.errors++;
          outcome.error = outcome.error ?? `post metric write failed: ${(e as Error)?.message ?? e}`;
        }
      } else if (!res.ok) {
        outcome.errors++;
        outcome.error = outcome.error ?? res.error ?? 'post insights failed';
        if (res.isAuthError) {
          outcome.authFailed = true;
          // A dead token fails identically for every remaining post on this
          // account. Stop hammering the provider with calls we know will fail.
          break;
        }
      }
    }

    return outcome;
  }

  /**
   * Upsert today's account snapshot: the provider's own numbers for one
   * (account, UTC day), and nothing else.
   *
   * WHY THERE IS NO `posts` COLUMN HERE ANY MORE. The table used to carry a
   * denormalized count of "targets that went PUBLISHED on this day", written
   * from a COUNT issued right here. It was only ever written for TODAY, and
   * only on the ticks where the account read succeeded, so it froze at whatever
   * the last successful sweep of that UTC day happened to see: a post published
   * at 22:00 with the day's last sweep at 18:00 left the row saying zero,
   * forever, and a day the sweep never reached had no row at all — a hole that
   * is not a zero. A stored aggregate that is never recomputed after its input
   * set changes is stale by construction.
   *
   * Recomputing the previous day on the first sweep of a new UTC day would
   * patch the common case and leave the rest: a sweep down over midnight, a
   * token that dies before the account read succeeds, a target that reaches
   * PUBLISHED late. The column had no reader to justify any of that — summary()
   * selects only (socialAccountId, date, followers) from this table and derives
   * every `posts` figure it reports straight from SocialPostTarget, which is
   * the system of record and can answer the question exactly, for any day, at
   * any time. So the copy is gone rather than repaired, and the sweep is one DB
   * round-trip per account lighter for it.
   */
  private async writeAccountMetric(
    workspaceId: string,
    socialAccountId: string,
    day: Date,
    data: AccountInsights,
  ): Promise<boolean> {
    try {
      const counts = {
        followers: clampCount(data.followers),
        profileViews: clampCount(data.profileViews),
        reach: clampCount(data.reach),
        impressions: clampCount(data.impressions),
      };
      const raw = (data.raw ?? undefined) as Prisma.InputJsonValue | undefined;
      await this.prisma.socialAccountMetric.upsert({
        where: { socialAccountId_date: { socialAccountId, date: day } },
        create: { workspaceId, socialAccountId, date: day, ...counts, ...(raw !== undefined ? { raw } : {}) },
        update: { ...counts, ...(raw !== undefined ? { raw } : {}), pulledAt: new Date() },
      });
      return true;
    } catch (e) {
      this.logger.warn(`account metric write failed (${socialAccountId}): ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /**
   * Record the attempt on the account.
   *
   * `lastError` is touched ONLY on a genuine auth failure, and this is the
   * single most important rule in this file. social.tools.ts computes
   * `needsReconnect = enabled !== true || expired || Boolean(lastError)`, so
   * ANY string in that column tells the owner their account is broken and must
   * be reconnected. A missing instagram_manage_insights scope, a rate limit, or
   * a five-minute Graph outage says nothing at all about the publishing
   * credential — the account still posts fine — and marking it needs-reconnect
   * would send the owner round an OAuth loop that cannot fix the problem, and
   * would do it to every workspace at once the day we ship this. Those failures
   * go to `insightsError`, which is reportable and inert. A real 190/401 does
   * write 'reauth_required', matching the convention publish and the token
   * refresher already use.
   *
   * The account is NOT disabled on an auth failure either (the refresher does
   * disable, on a different signal): disabling would silently stop publishing,
   * and a read permission problem must never take the write path down with it.
   */
  private stamp(workspaceId: string, id: string, error: string | null, authFailed: boolean) {
    return this.prisma.socialAccount
      .updateMany({
        where: { id, workspaceId },
        data: {
          insightsPulledAt: new Date(),
          insightsError: error ? error.slice(0, 500) : null,
          ...(authFailed ? { lastError: 'reauth_required' } : {}),
        },
      })
      .catch(() => undefined);
  }

  // ─────────────────────────────────────────────────────────────── Summary

  /**
   * The read model behind the organic charts. Everything here is scoped by
   * `workspaceId` on the query itself — there is no post-filter and no relation
   * hop that could widen it.
   *
   * ATTRIBUTION. Post metrics are cumulative snapshots (see the class doc), so
   * each target contributes exactly ONE figure: its latest snapshot inside the
   * window. That figure is attributed to the day the post was PUBLISHED, which
   * is why `posts` per day is the count of targets published that day and why
   * Σ byDay === totals exactly. A post published before `from` is not in the
   * window at all, even if it was measured inside it.
   *
   * ZERO-FILL IS THE CLIENT'S JOB. byDay contains ONLY days that actually have
   * a published target; a quiet Tuesday is simply absent from the array rather
   * than present as a row of zeros. That is deliberate — the server must not
   * have to guess the caller's timezone or its idea of a bucket — but it means
   * a chart MUST zero-fill the range itself before drawing, or a gap will be
   * rendered as a straight line between two distant points. followersByDay has
   * the same property, and there the correct fill is "carry the last known
   * value forward", not zero: a follower count is a level, and a day we did not
   * measure is not a day the account had no followers.
   */
  async summary(workspaceId: string, from: Date, to: Date): Promise<InsightsSummary> {
    const fromDay = SocialPostMetricService.utcDay(from);
    const toDay = SocialPostMetricService.utcDay(to);

    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId },
      select: {
        id: true,
        network: true,
        displayName: true,
        accountType: true,
        enabled: true,
        insightsPulledAt: true,
      },
    });

    const targets = await this.prisma.socialPostTarget.findMany({
      where: {
        workspaceId,
        status: 'PUBLISHED',
        post: { publishedAt: { gte: from, lte: to } },
      },
      orderBy: { post: { publishedAt: 'asc' } },
      take: SocialInsightsService.TARGET_ROW_LIMIT,
      select: {
        id: true,
        socialAccountId: true,
        network: true,
        post: { select: { publishedAt: true } },
      },
    });

    // Latest snapshot per target. Ordered date DESC and kept first-wins so that
    // hitting the row cap sheds the OLDEST rows — the ones we do not need —
    // rather than the newest, which are the whole answer.
    const latest = new Map<string, PostMetricRow>();
    if (targets.length > 0) {
      const rows = await this.prisma.socialPostMetric.findMany({
        where: {
          workspaceId,
          date: { gte: fromDay, lte: toDay },
          // Relation filter rather than a 20k-element `targetId: { in: [...] }`:
          // same rows, one bounded query, no giant parameter list.
          target: { workspaceId, status: 'PUBLISHED', post: { publishedAt: { gte: from, lte: to } } },
        },
        orderBy: { date: 'desc' },
        take: SocialInsightsService.POST_METRIC_ROW_LIMIT,
        select: {
          targetId: true,
          impressions: true,
          reach: true,
          engagements: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
          clicks: true,
          videoViews: true,
        },
      });
      for (const r of rows) if (!latest.has(r.targetId)) latest.set(r.targetId, r);
    }

    const totals = emptyTotals();
    const byDay = new Map<string, InsightsDay>();
    const byNetwork: Record<string, InsightsNetworkTotals> = {};
    const perAccount = new Map<string, InsightsAccountRow>();
    const accountsWithData = new Set<string>();

    for (const account of accounts) {
      perAccount.set(account.id, {
        socialAccountId: account.id,
        network: account.network,
        displayName: account.displayName,
        followers: 0,
        impressions: 0,
        reach: 0,
        engagements: 0,
        posts: 0,
      });
    }

    for (const t of targets) {
      const m = latest.get(t.id);
      if (m) accountsWithData.add(t.socialAccountId);
      const day = isoDay(t.post?.publishedAt);
      if (!day) continue;

      totals.impressions += m?.impressions ?? 0;
      totals.reach += m?.reach ?? 0;
      totals.engagements += m?.engagements ?? 0;
      totals.likes += m?.likes ?? 0;
      totals.comments += m?.comments ?? 0;
      totals.shares += m?.shares ?? 0;
      totals.saves += m?.saves ?? 0;
      totals.clicks += m?.clicks ?? 0;
      totals.videoViews += m?.videoViews ?? 0;
      totals.posts++;

      const d =
        byDay.get(day) ??
        { date: day, impressions: 0, reach: 0, engagements: 0, clicks: 0, videoViews: 0, posts: 0 };
      d.impressions += m?.impressions ?? 0;
      d.reach += m?.reach ?? 0;
      d.engagements += m?.engagements ?? 0;
      d.clicks += m?.clicks ?? 0;
      d.videoViews += m?.videoViews ?? 0;
      d.posts++;
      byDay.set(day, d);

      const n = (byNetwork[t.network] ??= { impressions: 0, reach: 0, engagements: 0, posts: 0 });
      n.impressions += m?.impressions ?? 0;
      n.reach += m?.reach ?? 0;
      n.engagements += m?.engagements ?? 0;
      n.posts++;

      // A target can outlive its account row only if the account was hard
      // deleted, which disconnectAccount refuses for accounts with history —
      // but the fallback keeps the aggregate honest rather than dropping rows.
      const a =
        perAccount.get(t.socialAccountId) ??
        {
          socialAccountId: t.socialAccountId,
          network: t.network,
          displayName: '(disconnected)',
          followers: 0,
          impressions: 0,
          reach: 0,
          engagements: 0,
          posts: 0,
        };
      a.impressions += m?.impressions ?? 0;
      a.reach += m?.reach ?? 0;
      a.engagements += m?.engagements ?? 0;
      a.posts++;
      perAccount.set(t.socialAccountId, a);
    }

    // Account-level rows: a follower LEVEL series, plus the latest level per
    // account for the table. Ascending so "last write wins" is the newest day.
    const accountRows = await this.prisma.socialAccountMetric.findMany({
      where: { workspaceId, date: { gte: fromDay, lte: toDay } },
      orderBy: { date: 'asc' },
      take: SocialInsightsService.ACCOUNT_METRIC_ROW_LIMIT,
      select: { socialAccountId: true, date: true, followers: true },
    });
    const followersByDay = new Map<string, InsightsFollowersDay>();
    for (const r of accountRows) {
      const day = isoDay(r.date);
      if (!day) continue;
      accountsWithData.add(r.socialAccountId);
      const bucket = followersByDay.get(day) ?? { date: day, byAccount: {} };
      bucket.byAccount[r.socialAccountId] = r.followers;
      followersByDay.set(day, bucket);
      const a = perAccount.get(r.socialAccountId);
      if (a) a.followers = r.followers;
    }

    const enabled = accounts.filter((a) => a.enabled);
    const lastPulled = accounts
      .map((a) => a.insightsPulledAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((x, y) => y.getTime() - x.getTime())[0];

    return {
      totals,
      byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byNetwork,
      byAccount: [...perAccount.values()].sort((a, b) => b.impressions - a.impressions),
      followersByDay: [...followersByDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
      coverage: {
        accounts: enabled.length,
        accountsWithData: [...accountsWithData].filter((id) => enabled.some((a) => a.id === id)).length,
        lastPulledAt: lastPulled ? lastPulled.toISOString() : null,
        unsupportedNetworks: unreadableNetworks(enabled),
      },
    };
  }
}

interface PostMetricRow {
  targetId: string;
  impressions: number;
  reach: number;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews: number;
}

function emptyTotals(): InsightsTotals {
  return {
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
  };
}

/** Coerce an untrusted provider value to a non-negative integer count. */
function clampCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** UTC 'YYYY-MM-DD' for a Date, or null when the value is not a usable date. */
function isoDay(d: Date | null | undefined): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Networks the workspace has connected but which we can NEVER read, whatever
 * the OAuth grant looks like — Pinterest and Google Business Profile today, and
 * LinkedIn when the only connected LinkedIn asset is a personal profile
 * (LinkedIn publishes no member statistics API at any tier).
 *
 * Deliberately NOT the same question as "is this network configured" or "did a
 * pull fail": both of those are fixable and get reported as errors. This list
 * is the one the UI needs to say "we cannot read this network" instead of
 * drawing a zero line, and a zero line is a claim that nobody saw the post.
 * A network appears only when NONE of its enabled accounts is readable, so a
 * workspace holding one LinkedIn company page and one personal profile is not
 * told LinkedIn is unreadable — the company page is.
 */
function unreadableNetworks(
  enabled: Array<{ network: string; accountType: string | null }>,
): string[] {
  const readableByNetwork = new Map<string, boolean>();
  for (const a of enabled) {
    const readable =
      networkSupportsInsights(a.network) && !(a.network === 'LINKEDIN' && a.accountType !== 'LI_ORG');
    readableByNetwork.set(a.network, (readableByNetwork.get(a.network) ?? false) || readable);
  }
  return [...readableByNetwork.entries()]
    .filter(([, readable]) => !readable)
    .map(([network]) => network)
    .sort();
}
