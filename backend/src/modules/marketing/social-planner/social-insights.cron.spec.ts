import { SocialInsightsCron, isAnyInsightsNetworkConfigured } from './social-insights.cron';
import { SocialInsightsService } from './social-insights.service';

// The lock is a Postgres primitive; here it is a pass-through so the body under
// test actually runs. Its own coordination behaviour is covered by
// advisory-lock's spec, not re-proved in every cron.
jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_prisma: any, _job: string, run: () => Promise<void>) => run()),
}));

function makePrisma(due: Array<{ workspaceId: string }>) {
  const findMany = jest.fn().mockResolvedValue(due);
  return { prisma: { socialAccount: { findMany } } as any, findMany };
}

function makeInsights() {
  const pullWorkspace = jest.fn().mockResolvedValue({ posts: 2, accounts: 1, errors: 0 });
  return { svc: { pullWorkspace } as any, pullWorkspace };
}

/** Every credential pair that could make an insights network "configured".
 *  The suite may run with a real .env loaded, so the inert test has to clear
 *  ALL of them — leaving one behind would silently prove nothing. */
const NETWORK_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
];
const ENV_KEYS = ['MARKETING_SECRET_KEY', ...NETWORK_ENV_KEYS];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of NETWORK_ENV_KEYS) delete process.env[k];
  process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('SocialInsightsCron', () => {
  it('is inert when no insights-capable network has platform credentials', async () => {
    for (const k of NETWORK_ENV_KEYS) delete process.env[k];
    expect(isAnyInsightsNetworkConfigured()).toBe(false);

    const { prisma, findMany } = makePrisma([]);
    const { svc, pullWorkspace } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    expect(findMany).not.toHaveBeenCalled();
    expect(pullWorkspace).not.toHaveBeenCalled();
  });

  it('is inert without the secret box — every sealed token would fail to open', async () => {
    delete process.env.MARKETING_SECRET_KEY;
    const { prisma, findMany } = makePrisma([{ workspaceId: 'w1' }]);
    const { svc } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reads DUE accounts oldest-first, capped, selecting only the workspace id', async () => {
    const { prisma, findMany } = makePrisma([]);
    await new SocialInsightsCron(prisma, makeInsights().svc).pullDueWorkspaces();

    const args = findMany.mock.calls[0][0];
    expect(args.where.enabled).toBe(true);
    expect(args.where.OR).toEqual([
      { insightsPulledAt: null },
      { insightsPulledAt: { lt: expect.any(Date) } },
    ]);
    // Oldest-first with nulls first: a never-pulled account goes to the head of
    // the queue, and because every attempt stamps insightsPulledAt, a failing
    // account cannot hold that position and starve the rest.
    expect(args.orderBy).toEqual({ insightsPulledAt: { sort: 'asc', nulls: 'first' } });
    expect(args.take).toBe(200);
    expect(args.select).toEqual({ workspaceId: true });

    const dueBefore: Date = args.where.OR[1].insightsPulledAt.lt;
    const ageMs = Date.now() - dueBefore.getTime();
    expect(Math.round(ageMs / 3_600_000)).toBe(SocialInsightsService.PULL_INTERVAL_MS / 3_600_000);
  });

  it('sweeps each workspace once, in due order, and does nothing when nothing is due', async () => {
    const { prisma } = makePrisma([
      { workspaceId: 'w2' },
      { workspaceId: 'w1' },
      { workspaceId: 'w2' },
      { workspaceId: 'w3' },
    ]);
    const { svc, pullWorkspace } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    expect(pullWorkspace.mock.calls.map((c) => c[0])).toEqual(['w2', 'w1', 'w3']);
    // No `force`: the every-6h gate is re-applied per account inside the puller,
    // so a workspace with one due account does not re-read all twelve.
    expect(pullWorkspace.mock.calls[0][1]).toBeUndefined();
  });

  it('does not sweep at all when no account is due', async () => {
    const { prisma } = makePrisma([]);
    const { svc, pullWorkspace } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();
    expect(pullWorkspace).not.toHaveBeenCalled();
  });

  it('one failing workspace never aborts the tick', async () => {
    const { prisma } = makePrisma([{ workspaceId: 'w1' }, { workspaceId: 'w2' }]);
    const { svc, pullWorkspace } = makeInsights();
    pullWorkspace
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ posts: 1, accounts: 1, errors: 0 });

    await expect(new SocialInsightsCron(prisma, svc).pullDueWorkspaces()).resolves.toBeUndefined();
    expect(pullWorkspace).toHaveBeenCalledTimes(2);
  });
});
