import { ConflictException } from '@nestjs/common';
import { SocialInsightsService } from './social-insights.service';
import * as insights from './network-insights';

// SWC does not honour jest.spyOn against a module namespace, so both seams are
// replaced with module-factory mocks. network-adapters is mocked as well to keep
// this spec off the publish path's heavy imports (Jimp, R2) — the only thing the
// service uses from it is the env gate.
jest.mock('./network-adapters', () => ({
  isNetworkConfigured: jest.fn(() => true),
}));
jest.mock('./network-insights', () => ({
  fetchPostInsights: jest.fn(),
  fetchAccountInsights: jest.fn(),
  networkSupportsInsights: jest.fn(() => true),
}));

const fetchPost = insights.fetchPostInsights as jest.Mock;
const fetchAccount = insights.fetchAccountInsights as jest.Mock;
const supports = insights.networkSupportsInsights as jest.Mock;

const WS = 'ws-1';

/** Minimal recording double of the Prisma delegates the service touches. */
function makePrisma(seed: {
  accounts?: any[];
  targets?: any[];
  postMetrics?: any[];
  accountMetrics?: any[];
  targetCount?: number;
} = {}) {
  const calls: Record<string, any[]> = {
    'socialAccount.findMany': [],
    'socialAccount.updateMany': [],
    'socialPostTarget.findMany': [],
    'socialPostTarget.count': [],
    'socialAccountMetric.upsert': [],
    'socialAccountMetric.findMany': [],
    'socialPostMetric.findMany': [],
  };
  const record = (key: string, arg: any, value: any) => {
    calls[key].push(arg);
    return Promise.resolve(value);
  };
  const prisma = {
    // The per-workspace pull lock lives inside an interactive transaction (see
    // pullWorkspaceExclusive). Here it is a pass-through that hands the body a
    // `tx` whose raw query reports the lock ACQUIRED — the contended case gets
    // its own double below, in the exclusivity tests.
    $transaction: jest.fn(async (body: any) =>
      body({ $queryRawUnsafe: jest.fn(async () => [{ locked: true }]) }),
    ),
    socialAccount: {
      findMany: jest.fn((a: any) => record('socialAccount.findMany', a, seed.accounts ?? [])),
      updateMany: jest.fn((a: any) => record('socialAccount.updateMany', a, { count: 1 })),
    },
    socialPostTarget: {
      findMany: jest.fn((a: any) => record('socialPostTarget.findMany', a, seed.targets ?? [])),
      count: jest.fn((a: any) => record('socialPostTarget.count', a, seed.targetCount ?? 0)),
    },
    socialAccountMetric: {
      upsert: jest.fn((a: any) => record('socialAccountMetric.upsert', a, {})),
      findMany: jest.fn((a: any) => record('socialAccountMetric.findMany', a, seed.accountMetrics ?? [])),
    },
    socialPostMetric: {
      findMany: jest.fn((a: any) => record('socialPostMetric.findMany', a, seed.postMetrics ?? [])),
    },
  } as any;
  return { prisma, calls };
}

/** Stub of SocialPostMetricService — the upsert contract is proven in its own spec. */
function makeMetrics() {
  const upsert = jest.fn().mockResolvedValue(undefined);
  return { svc: { upsert } as any, upsert };
}

const account = (over: Partial<Record<string, any>> = {}) => ({
  id: 'a1',
  workspaceId: WS,
  network: 'INSTAGRAM',
  externalId: 'IG1',
  accessToken: 'sealed',
  accountType: 'IG_BUSINESS',
  ...over,
});

const target = (over: Partial<Record<string, any>> = {}) => ({
  id: 't1',
  socialAccountId: 'a1',
  externalPostId: 'P1',
  network: 'INSTAGRAM',
  ...over,
});

const metricRow = (over: Partial<Record<string, any>> = {}) => ({
  targetId: 't1',
  impressions: 0,
  reach: 0,
  engagements: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  clicks: 0,
  videoViews: 0,
  ...over,
});

beforeEach(() => {
  fetchPost.mockReset();
  fetchAccount.mockReset();
  supports.mockReset().mockReturnValue(true);
});

describe('SocialInsightsService.pullWorkspace', () => {
  it('snapshots the account and every due post, upserting on a UTC day (idempotent)', async () => {
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target(), target({ id: 't2', externalPostId: 'P2' })],
      targetCount: 2,
    });
    const { svc: metrics, upsert } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 500, reach: 40, raw: { x: 1 } } });
    fetchPost.mockResolvedValue({ ok: true, data: { impressions: 10, likes: 2 } });

    const svc = new SocialInsightsService(prisma, metrics);
    const r = await svc.pullWorkspace(WS);

    expect(r).toEqual({ posts: 2, accounts: 1, errors: 0 });

    const up = calls['socialAccountMetric.upsert'][0];
    expect(up.where.socialAccountId_date.socialAccountId).toBe('a1');
    // UTC midnight — the @db.Date column's own resolution, so the upsert key
    // cannot be split by a time-of-day component.
    expect(up.where.socialAccountId_date.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(up.create).toMatchObject({ workspaceId: WS, followers: 500, reach: 40 });
    expect(up.update).toMatchObject({ followers: 500 });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0]).toBe(WS);
    expect(upsert.mock.calls[0][1]).toBe('t1');
  });

  it('stores the provider numbers only — never a denormalized post count', async () => {
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target(), target({ id: 't2', externalPostId: 'P2' })],
      targetCount: 2,
    });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 500 } });
    fetchPost.mockResolvedValue({ ok: true, data: { impressions: 10 } });

    await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);

    // A `posts` copy on the account row could only ever be written for TODAY,
    // and only on the ticks where the provider answered — it would freeze at
    // whatever the last successful sweep of the day saw and never be corrected.
    // summary() derives the figure from SocialPostTarget, which knows it
    // exactly for every day, so nothing writes it and nothing counts for it.
    const up = calls['socialAccountMetric.upsert'][0];
    expect(up.create).not.toHaveProperty('posts');
    expect(up.update).not.toHaveProperty('posts');
    expect(prisma.socialPostTarget.count).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pull writes the same keys, never a second row', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [target()] });
    const { svc: metrics, upsert } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 10 } });
    fetchPost.mockResolvedValue({ ok: true, data: { impressions: 1 } });

    const svc = new SocialInsightsService(prisma, metrics);
    await svc.pullWorkspace(WS, { force: true });
    await svc.pullWorkspace(WS, { force: true });

    const [first, second] = calls['socialAccountMetric.upsert'];
    expect(second.where).toEqual(first.where);
    // Both writes are upserts (no create-only path exists), and the post metric
    // service is keyed on (targetId, date) by the same rule.
    expect(upsert.mock.calls[0][2]).toEqual(upsert.mock.calls[1][2]);
  });

  it('applies the 6h staleness gate, and force removes it', async () => {
    const { prisma, calls } = makePrisma({ accounts: [] });
    const { svc: metrics } = makeMetrics();
    const svc = new SocialInsightsService(prisma, metrics);

    await svc.pullWorkspace(WS);
    expect(calls['socialAccount.findMany'][0].where.OR).toEqual([
      { insightsPulledAt: null },
      { insightsPulledAt: { lt: expect.any(Date) } },
    ]);

    await svc.pullWorkspace(WS, { force: true });
    expect(calls['socialAccount.findMany'][1].where.OR).toBeUndefined();
    expect(calls['socialAccount.findMany'][1].where).toMatchObject({ workspaceId: WS, enabled: true });
  });

  it('never throws when a provider read blows up, and keeps sweeping the next account', async () => {
    const { prisma, calls } = makePrisma({
      accounts: [account({ id: 'bad' }), account({ id: 'good' })],
      targets: [],
    });
    const { svc: metrics } = makeMetrics();
    fetchAccount
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: true, data: { followers: 7 } });

    const svc = new SocialInsightsService(prisma, metrics);
    const r = await svc.pullWorkspace(WS);

    expect(r.errors).toBe(1);
    expect(r.accounts).toBe(1);
    // Both accounts were stamped: the broken one rotates to the back of the
    // due queue instead of wedging at the nulls-first front.
    expect(calls['socialAccount.updateMany'].map((c) => c.where.id)).toEqual(['bad', 'good']);
    expect(calls['socialAccount.updateMany'][0].data.insightsError).toContain('socket hang up');
  });

  it('never throws when the due-account read itself fails', async () => {
    const { prisma } = makePrisma();
    prisma.socialAccount.findMany.mockRejectedValue(new Error('db down'));
    const svc = new SocialInsightsService(prisma, makeMetrics().svc);
    await expect(svc.pullWorkspace(WS)).resolves.toEqual({ posts: 0, accounts: 0, errors: 0 });
  });

  it('never throws when the due-TARGET read fails, and still stamps every account', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account({ id: 'a1' }), account({ id: 'a2' })] });
    prisma.socialPostTarget.findMany.mockRejectedValue(new Error('db down'));
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 3 } });

    const svc = new SocialInsightsService(prisma, metrics);
    // The contract is that this method never throws. An unguarded await on the
    // target read breaks it — and takes the stamping with it, leaving every
    // account in the batch pinned at the nulls-first head of the due queue
    // where it starves the healthy accounts behind it on every later tick.
    const r = await svc.pullWorkspace(WS);

    expect(r).toEqual({ posts: 0, accounts: 2, errors: 1 });
    expect(calls['socialAccount.updateMany'].map((c) => c.where.id)).toEqual(['a1', 'a2']);
    for (const stamp of calls['socialAccount.updateMany']) {
      expect(stamp.data.insightsPulledAt).toBeInstanceOf(Date);
    }
  });

  it('stamps reauth_required on an auth failure — and ONLY on an auth failure', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: false, error: 'token expired', isAuthError: true });

    const svc = new SocialInsightsService(prisma, metrics);
    const r = await svc.pullWorkspace(WS);

    expect(r.errors).toBe(1);
    const data = calls['socialAccount.updateMany'][0].data;
    expect(data.lastError).toBe('reauth_required');
    expect(data.insightsError).toContain('token expired');
    expect(calls['socialAccount.updateMany'][0].where).toEqual({ id: 'a1', workspaceId: WS });
  });

  it('a missing-scope failure NEVER touches lastError (it would falsely demand a reconnect)', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({
      ok: false,
      error: '(#10) requires instagram_manage_insights',
      isAuthError: false,
    });

    await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);

    const data = calls['socialAccount.updateMany'][0].data;
    expect(data).not.toHaveProperty('lastError');
    expect(data.insightsError).toContain('instagram_manage_insights');
    expect(data.insightsPulledAt).toBeInstanceOf(Date);
  });

  it('a clean pull clears a stale insightsError', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
    await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);
    expect(calls['socialAccount.updateMany'][0].data.insightsError).toBeNull();
  });

  it('does not enter the post loop at all once the ACCOUNT read proved the token dead', async () => {
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target({ id: 't1' }), target({ id: 't2' }), target({ id: 't3' })],
    });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: false, error: 'token expired', isAuthError: true });

    const r = await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);

    // Every post below would be fetched with the same dead credential and fail
    // the same way; the only thing walking the loop buys is three more calls
    // against the provider's rate limit.
    expect(fetchPost).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 1 });
    // The account is still stamped — one error, one reauth flag, not four.
    expect(calls['socialAccount.updateMany'][0].data.lastError).toBe('reauth_required');
  });

  it('stops calling a network for the remaining posts once its token is dead', async () => {
    const { prisma } = makePrisma({
      accounts: [account()],
      targets: [target({ id: 't1' }), target({ id: 't2' }), target({ id: 't3' })],
    });
    const { svc: metrics } = makeMetrics();
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
    fetchPost.mockResolvedValue({ ok: false, error: 'invalid token', isAuthError: true });

    await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);
    expect(fetchPost).toHaveBeenCalledTimes(1);
  });

  it('skips an unsupported network entirely — no provider call, no error, but still stamped', async () => {
    supports.mockReturnValue(false);
    const { prisma, calls } = makePrisma({ accounts: [account({ network: 'PINTEREST' })], targets: [] });
    const { svc: metrics } = makeMetrics();

    const r = await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);

    expect(fetchAccount).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 0 });
    expect(calls['socialAccount.updateMany'][0].data.insightsPulledAt).toBeInstanceOf(Date);
  });

  it('counts a metric-write failure as an error rather than losing it silently', async () => {
    const { prisma } = makePrisma({ accounts: [account()], targets: [target()] });
    prisma.socialAccountMetric.upsert.mockRejectedValue(new Error('deadlock detected'));
    const { svc: metrics, upsert } = makeMetrics();
    upsert.mockRejectedValue(new Error('deadlock detected'));
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
    fetchPost.mockResolvedValue({ ok: true, data: { impressions: 1 } });

    const r = await new SocialInsightsService(prisma, metrics).pullWorkspace(WS);
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 2 });
  });

  it('touches ONLY the allowlisted accounts when the sweep names them', async () => {
    // The cron picks a global BATCH of due account rows and hands each
    // workspace its share. Without the allowlist this method re-derives its own
    // due set with its own take: 100, so BATCH=200 rows spread over 200
    // workspaces authorise 20,000 account reads instead of 200.
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });

    await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS, {
      accountIds: ['a1', 'a7'],
    });

    const args = calls['socialAccount.findMany'][0];
    expect(args.where.id).toEqual({ in: ['a1', 'a7'] });
    // The take follows the allowlist rather than the class-wide cap: two ids
    // can never cost a hundred rows.
    expect(args.take).toBe(2);
    // And the staleness gate is still applied on top — the ids were chosen by an
    // earlier query and another replica may have swept them in between.
    expect(args.where.OR).toEqual([
      { insightsPulledAt: null },
      { insightsPulledAt: { lt: expect.any(Date) } },
    ]);
  });

  it('an EMPTY allowlist reads nothing at all — it is not the absence of an allowlist', async () => {
    // `{ id: { in: [] } }` and `{}` are opposite instructions, and spreading an
    // empty fragment would silently widen the read to the whole workspace — the
    // same shape as the Prisma undefined-where trap.
    const { prisma } = makePrisma({ accounts: [account()] });
    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS, {
      accountIds: [],
    });
    expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 0 });
  });

  it('caps the target read at the caller’s limit, newest posts first', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });

    const svc = new SocialInsightsService(prisma, makeMetrics().svc);
    await svc.pullWorkspace(WS);
    expect(calls['socialPostTarget.findMany'][0].take).toBe(500);

    // The interactive path buys a much shorter body: a human is holding an HTTP
    // request open, and five hundred serial provider calls is not a request, it
    // is a timeout.
    await svc.pullWorkspace(WS, { force: true, targetLimit: 25 });
    expect(calls['socialPostTarget.findMany'][1].take).toBe(25);
    // Newest-first, so the cap sheds the OLDEST posts — the settled ones.
    expect(calls['socialPostTarget.findMany'][1].orderBy).toEqual({ post: { publishedAt: 'desc' } });
  });

  it('does not enter the post loop once the account read proved the SCOPE is missing', async () => {
    // The guaranteed day-one state: none of instagram_manage_insights,
    // read_insights, r_organization_social or user.info.stats is in the OAuth
    // config, so the first sweep after deploy meets this on every Meta,
    // LinkedIn and TikTok account at once. Walking the loop anyway spends one
    // denied provider call per published post, per account, per hour, to
    // re-establish a fact the first call already gave us.
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target({ id: 't1' }), target({ id: 't2' }), target({ id: 't3' })],
    });
    fetchAccount.mockResolvedValue({
      ok: false,
      error: '(#10) Requires instagram_manage_insights permission',
      isAuthError: false,
      permissionDenied: true,
    });

    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS);

    expect(fetchPost).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 1 });
    // …and it is still NOT a reconnect. The account publishes perfectly well;
    // the app was simply never granted the read scope, and no OAuth loop the
    // owner can walk will grant a scope nobody asked for.
    const data = calls['socialAccount.updateMany'][0].data;
    expect(data).not.toHaveProperty('lastError');
    expect(data.insightsError).toContain('instagram_manage_insights');
  });

  it('keeps the follower count it DID get when only the scoped edge was denied', async () => {
    // The Meta account read is two calls: a cheap profile fetch and a scoped
    // insights edge. A denial of the second still returns followers, so the
    // result is ok:true carrying permissionDenied — the number is stored, and
    // only the post loop (gated by the same grant) is skipped.
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target({ id: 't1' }), target({ id: 't2' })],
    });
    fetchAccount.mockResolvedValue({
      ok: true,
      data: { followers: 4200 },
      permissionDenied: true,
      error: 'FB page insights: (#200) Requires read_insights permission',
    });

    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS);

    expect(calls['socialAccountMetric.upsert'][0].create).toMatchObject({ followers: 4200 });
    expect(fetchPost).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 1, errors: 0 });
    // A successful read is not an error, but the missing half still needs a
    // reason on the row or the coverage note has nothing to say.
    const data = calls['socialAccount.updateMany'][0].data;
    expect(data.insightsError).toContain('read_insights');
    expect(data).not.toHaveProperty('lastError');
  });

  it('stops the post loop at the first scope refusal, without demanding a reconnect', async () => {
    // The mirror case: the account read succeeded outright and only the post
    // edge is gated (X's tweet.read, TikTok's video.list).
    const { prisma, calls } = makePrisma({
      accounts: [account()],
      targets: [target({ id: 't1' }), target({ id: 't2' }), target({ id: 't3' })],
    });
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
    fetchPost.mockResolvedValue({
      ok: false,
      error: 'TikTok video query: scope_not_authorized',
      isAuthError: false,
      permissionDenied: true,
    });

    await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS);

    expect(fetchPost).toHaveBeenCalledTimes(1);
    expect(calls['socialAccount.updateMany'][0].data).not.toHaveProperty('lastError');
  });

  it('only reads PUBLISHED targets with an externalPostId, inside the 30-day window', async () => {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
    await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspace(WS);
    const where = calls['socialPostTarget.findMany'][0].where;
    expect(where).toMatchObject({
      workspaceId: WS,
      status: 'PUBLISHED',
      externalPostId: { not: null },
      socialAccountId: { in: ['a1'] },
    });
    const since: Date = where.post.publishedAt.gte;
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(SocialInsightsService.POST_WINDOW_DAYS);
  });
});

describe('SocialInsightsService — exclusive pulls', () => {
  /** A prisma double whose advisory-lock SELECT answers `locked`. */
  function lockingPrisma(locked: boolean) {
    const { prisma, calls } = makePrisma({ accounts: [account()], targets: [] });
    const queryRawUnsafe = jest.fn(async () => [{ locked }]);
    const transaction = jest.fn(async (body: any, opts: any) => {
      (transaction as any).opts = opts;
      return body({ $queryRawUnsafe: queryRawUnsafe });
    });
    prisma.$transaction = transaction;
    return { prisma, calls, queryRawUnsafe, transaction };
  }

  beforeEach(() => {
    fetchAccount.mockResolvedValue({ ok: true, data: { followers: 1 } });
  });

  it('runs the pull under a per-workspace TRY lock, never a waiting one', async () => {
    const { prisma, queryRawUnsafe, transaction } = lockingPrisma(true);
    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspaceExclusive(WS, {
      lockTimeoutMs: 60_000,
    });

    const sql = String(queryRawUnsafe.mock.calls[0][0]);
    // TRY, not wait: an HTTP request must not queue behind a sweep that may run
    // for minutes, and the cron has better things to do than block.
    expect(sql).toContain('pg_try_advisory_xact_lock');
    // Per WORKSPACE — a global lock here would make one workspace's refresh
    // block every other workspace's.
    expect(sql).toContain(WS);
    // XACT inside an interactive transaction, so the lock cannot leak onto an
    // idle pooled connection, and BOUNDED, because it is held for the body.
    expect(transaction.mock.calls[0][1].timeout).toBe(60_000);
    expect(r).toMatchObject({ skipped: false, accounts: 1 });
  });

  it('does nothing at all when another pull already holds the lock', async () => {
    const { prisma } = lockingPrisma(false);
    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspaceExclusive(WS, {
      lockTimeoutMs: 60_000,
    });

    // Two concurrent pulls of one workspace write identical rows and burn twice
    // the provider's rate limit; the second is pure waste.
    expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    expect(fetchAccount).not.toHaveBeenCalled();
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 0, skipped: true });
  });

  it('pullNow answers 409 rather than a cheerful zero when a pull is already running', async () => {
    const { prisma } = lockingPrisma(false);
    const svc = new SocialInsightsService(prisma, makeMetrics().svc);

    // A zeroed 200 would read as "we looked and there was nothing", which is a
    // different and false fact from "we did not look".
    await expect(svc.pullNow(WS)).rejects.toThrow(ConflictException);
  });

  it('pullNow forces past the staleness gate but with the small interactive target cap', async () => {
    const { prisma, calls } = lockingPrisma(true);
    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullNow(WS);

    // force: a human who has just published something is not the unattended
    // sweep the every-6h gate exists to throttle.
    expect(calls['socialAccount.findMany'][0].where.OR).toBeUndefined();
    // …but the body must stay short: at ~1s per provider round-trip the cron's
    // 500-target cap is an eight-minute HTTP request.
    expect(calls['socialPostTarget.findMany'][0].take).toBe(50);
    // The response shape the client knows — no internal `skipped` leaking out.
    expect(r).toEqual({ posts: 0, accounts: 1, errors: 0 });
  });

  it('never throws when the lock transaction itself fails — it counts and moves on', async () => {
    const { prisma } = lockingPrisma(true);
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('transaction timed out'));

    // The sweep calls this once per workspace; a pool timeout on one of them
    // must not take out the forty queued behind it.
    const r = await new SocialInsightsService(prisma, makeMetrics().svc).pullWorkspaceExclusive(WS, {
      lockTimeoutMs: 60_000,
    });
    expect(r).toEqual({ posts: 0, accounts: 0, errors: 1, skipped: false });
  });
});

describe('SocialInsightsService.summary', () => {
  const from = new Date('2026-06-01T00:00:00.000Z');
  const to = new Date('2026-06-30T23:59:59.000Z');

  it('attributes each target to its PUBLISH day, so the byDay series sums to totals', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: 'IG_BUSINESS', enabled: true, insightsPulledAt: new Date('2026-06-30T06:00:00.000Z') },
        { id: 'a2', network: 'FACEBOOK', displayName: 'FB', accountType: 'PAGE', enabled: true, insightsPulledAt: null },
      ],
      targets: [
        { id: 't1', socialAccountId: 'a1', network: 'INSTAGRAM', post: { publishedAt: new Date('2026-06-02T09:00:00.000Z') } },
        { id: 't2', socialAccountId: 'a2', network: 'FACEBOOK', post: { publishedAt: new Date('2026-06-02T20:00:00.000Z') } },
        { id: 't3', socialAccountId: 'a1', network: 'INSTAGRAM', post: { publishedAt: new Date('2026-06-05T09:00:00.000Z') } },
      ],
      postMetrics: [
        metricRow({ targetId: 't1', impressions: 100, reach: 90, engagements: 10, clicks: 3, likes: 7 }),
        metricRow({ targetId: 't2', impressions: 200, reach: 150, engagements: 20, clicks: 5, videoViews: 60 }),
        metricRow({ targetId: 't3', impressions: 40, reach: 35, engagements: 4, saves: 2 }),
      ],
      accountMetrics: [],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    expect(s.totals).toMatchObject({ impressions: 340, reach: 275, engagements: 34, clicks: 8, videoViews: 60, posts: 3, likes: 7, saves: 2 });
    // Only days that actually have a published target appear — the client
    // zero-fills the rest of the range.
    expect(s.byDay.map((d) => d.date)).toEqual(['2026-06-02', '2026-06-05']);
    expect(s.byDay[0]).toMatchObject({ impressions: 300, reach: 240, engagements: 30, clicks: 8, videoViews: 60, posts: 2 });
    expect(s.byDay[1]).toMatchObject({ impressions: 40, posts: 1 });
    // Σ byDay === totals, exactly.
    expect(s.byDay.reduce((n, d) => n + d.impressions, 0)).toBe(s.totals.impressions);
    expect(s.byDay.reduce((n, d) => n + d.posts, 0)).toBe(s.totals.posts);
  });

  it('groups by network and by account', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: null },
        { id: 'a2', network: 'FACEBOOK', displayName: 'FB Page', accountType: 'PAGE', enabled: true, insightsPulledAt: null },
      ],
      targets: [
        { id: 't1', socialAccountId: 'a1', network: 'INSTAGRAM', post: { publishedAt: new Date('2026-06-02T09:00:00.000Z') } },
        { id: 't2', socialAccountId: 'a2', network: 'FACEBOOK', post: { publishedAt: new Date('2026-06-03T09:00:00.000Z') } },
      ],
      postMetrics: [
        metricRow({ targetId: 't1', impressions: 10, reach: 9, engagements: 1 }),
        metricRow({ targetId: 't2', impressions: 90, reach: 80, engagements: 9 }),
      ],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    expect(s.byNetwork).toEqual({
      INSTAGRAM: { impressions: 10, reach: 9, engagements: 1, posts: 1 },
      FACEBOOK: { impressions: 90, reach: 80, engagements: 9, posts: 1 },
    });
    // Sorted by impressions desc so the table leads with what worked.
    expect(s.byAccount.map((a) => a.socialAccountId)).toEqual(['a2', 'a1']);
    expect(s.byAccount[0]).toMatchObject({ network: 'FACEBOOK', displayName: 'FB Page', impressions: 90, posts: 1 });
  });

  it('uses the LATEST snapshot per target, never the sum of its cumulative rows', async () => {
    const { prisma } = makePrisma({
      accounts: [{ id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: null }],
      targets: [{ id: 't1', socialAccountId: 'a1', network: 'INSTAGRAM', post: { publishedAt: new Date('2026-06-02T09:00:00.000Z') } }],
      // The service orders date DESC, so the first row for a target is the
      // newest. Three cumulative snapshots of ONE post: 300, not 600.
      postMetrics: [
        metricRow({ targetId: 't1', impressions: 300 }),
        metricRow({ targetId: 't1', impressions: 200 }),
        metricRow({ targetId: 't1', impressions: 100 }),
      ],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);
    expect(s.totals.impressions).toBe(300);
    expect(s.totals.posts).toBe(1);
    expect(prisma.socialPostMetric.findMany.mock.calls[0][0].orderBy).toEqual({ date: 'desc' });
  });

  it('counts a published target with no metrics yet as a post with zero reach', async () => {
    const { prisma } = makePrisma({
      accounts: [{ id: 'a1', network: 'TIKTOK', displayName: 'TT', accountType: null, enabled: true, insightsPulledAt: null }],
      targets: [{ id: 't1', socialAccountId: 'a1', network: 'TIKTOK', post: { publishedAt: new Date('2026-06-02T09:00:00.000Z') } }],
      postMetrics: [],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);
    expect(s.totals).toMatchObject({ posts: 1, impressions: 0 });
    expect(s.byDay[0]).toMatchObject({ date: '2026-06-02', posts: 1, impressions: 0 });
    // …and it must NOT be counted as coverage: nothing was read for it.
    expect(s.coverage.accountsWithData).toBe(0);
  });

  it('reports followers as a LEVEL: latest in the window, plus a per-day series', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: null },
        { id: 'a2', network: 'TIKTOK', displayName: 'TT', accountType: null, enabled: true, insightsPulledAt: null },
      ],
      targets: [],
      accountMetrics: [
        { socialAccountId: 'a1', date: new Date('2026-06-01T00:00:00.000Z'), followers: 100 },
        { socialAccountId: 'a2', date: new Date('2026-06-01T00:00:00.000Z'), followers: 50 },
        { socialAccountId: 'a1', date: new Date('2026-06-02T00:00:00.000Z'), followers: 110 },
      ],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    expect(s.followersByDay).toEqual([
      { date: '2026-06-01', byAccount: { a1: 100, a2: 50 } },
      { date: '2026-06-02', byAccount: { a1: 110 } },
    ]);
    const a1 = s.byAccount.find((a) => a.socialAccountId === 'a1');
    // 110, not 210: a follower count is a level and is never summed.
    expect(a1.followers).toBe(110);
    expect(s.coverage.accountsWithData).toBe(2);
  });

  it('coverage tells the truth about what cannot be read', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: new Date('2026-06-30T05:00:00.000Z') },
        { id: 'a2', network: 'PINTEREST', displayName: 'Pins', accountType: null, enabled: true, insightsPulledAt: new Date('2026-06-30T07:30:00.000Z') },
        { id: 'a3', network: 'LINKEDIN', displayName: 'Me', accountType: 'LI_PERSON', enabled: true, insightsPulledAt: null },
        { id: 'a4', network: 'GMB', displayName: 'Shop', accountType: null, enabled: false, insightsPulledAt: null },
      ],
      targets: [],
      accountMetrics: [{ socialAccountId: 'a1', date: new Date('2026-06-10T00:00:00.000Z'), followers: 5 }],
    });
    // The real predicate, not the blanket-true stub: this test is ABOUT it.
    supports.mockImplementation((n: string) =>
      ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'LINKEDIN', 'TIKTOK', 'TWITTER'].includes(n),
    );

    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    expect(s.coverage.accounts).toBe(3); // the disabled GMB account is not counted
    expect(s.coverage.accountsWithData).toBe(1);
    // Pinterest has no API at all; a LinkedIn PERSONAL profile never will have
    // one. The disabled GMB account is not listed — it is not connected.
    expect(s.coverage.unsupportedNetworks).toEqual(['LINKEDIN', 'PINTEREST']);
    expect(s.coverage.lastPulledAt).toBe('2026-06-30T07:30:00.000Z');
  });

  it('reports WHY an account contributed nothing, in the provider’s own words', async () => {
    // insightsError was written by every sweep and read by nothing: summary()
    // did not select it and coverage returned only counts. So the one screen
    // built to say "we could not read this network" had no access to the reason
    // the sweep had already saved, and a permanently-denied scope was
    // indistinguishable from an account that simply had a quiet month.
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: new Date('2026-06-30T06:00:00.000Z'), insightsError: '(#10) Requires instagram_manage_insights permission' },
        { id: 'a2', network: 'TWITTER', displayName: 'X', accountType: null, enabled: true, insightsPulledAt: new Date('2026-06-30T06:00:00.000Z'), insightsError: null },
        // Disabled, and failing. Not counted: an account nobody asked us to read
        // is not a coverage problem, it is the setting working.
        { id: 'a3', network: 'TIKTOK', displayName: 'TT', accountType: null, enabled: false, insightsPulledAt: null, insightsError: 'scope_not_authorized' },
      ],
      targets: [],
    });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    const a1 = s.byAccount.find((a) => a.socialAccountId === 'a1');
    expect(a1.insightsError).toContain('instagram_manage_insights');
    // Null rather than absent for a healthy account: the field is the answer to
    // "why is this empty", and "no reason, it just is" is a real answer.
    expect(s.byAccount.find((a) => a.socialAccountId === 'a2').insightsError).toBeNull();
    expect(s.coverage.accountsWithErrors).toBe(1);
  });

  it('counts errors separately from unsupported networks — one is fixable, the other is not', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'INSTAGRAM', displayName: 'IG', accountType: null, enabled: true, insightsPulledAt: null, insightsError: 'rate limited' },
        { id: 'a2', network: 'PINTEREST', displayName: 'Pins', accountType: null, enabled: true, insightsPulledAt: null, insightsError: null },
      ],
      targets: [],
    });
    supports.mockImplementation((n: string) =>
      ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'LINKEDIN', 'TIKTOK', 'TWITTER'].includes(n),
    );
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);

    // Pinterest has no insights API at all — nothing to retry, nothing to ask
    // for. Instagram was refused this time and may well answer next time. A UI
    // that folded them together would tell the owner nothing can be done about
    // a problem that can.
    expect(s.coverage.unsupportedNetworks).toEqual(['PINTEREST']);
    expect(s.coverage.accountsWithErrors).toBe(1);
  });

  it('a LinkedIn company page keeps LINKEDIN off the unreadable list', async () => {
    const { prisma } = makePrisma({
      accounts: [
        { id: 'a1', network: 'LINKEDIN', displayName: 'Me', accountType: 'LI_PERSON', enabled: true, insightsPulledAt: null },
        { id: 'a2', network: 'LINKEDIN', displayName: 'Co', accountType: 'LI_ORG', enabled: true, insightsPulledAt: null },
      ],
      targets: [],
    });
    supports.mockReturnValue(true);
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);
    expect(s.coverage.unsupportedNetworks).toEqual([]);
  });

  it('an empty workspace returns a well-formed zero summary, never null holes', async () => {
    const { prisma } = makePrisma({ accounts: [], targets: [], accountMetrics: [] });
    const s = await new SocialInsightsService(prisma, makeMetrics().svc).summary(WS, from, to);
    expect(s.totals).toEqual({
      impressions: 0, reach: 0, engagements: 0, likes: 0, comments: 0,
      shares: 0, saves: 0, clicks: 0, videoViews: 0, posts: 0,
    });
    expect(s.byDay).toEqual([]);
    expect(s.byNetwork).toEqual({});
    expect(s.byAccount).toEqual([]);
    expect(s.followersByDay).toEqual([]);
    expect(s.coverage).toEqual({
      accounts: 0,
      accountsWithData: 0,
      accountsWithErrors: 0,
      lastPulledAt: null,
      unsupportedNetworks: [],
    });
    // No targets → no point asking for their metrics at all.
    expect(prisma.socialPostMetric.findMany).not.toHaveBeenCalled();
  });
});
