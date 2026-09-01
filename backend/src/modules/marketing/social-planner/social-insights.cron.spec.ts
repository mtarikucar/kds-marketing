import { SocialInsightsCron, isAnyInsightsNetworkConfigured } from './social-insights.cron';
import { SocialInsightsService } from './social-insights.service';

// The lock is a Postgres primitive; here it is a pass-through so the body under
// test actually runs. Its own coordination behaviour is covered by
// advisory-lock's spec, not re-proved in every cron.
jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_prisma: any, _job: string, run: () => Promise<void>) => run()),
}));

function makePrisma(due: Array<{ id: string; workspaceId: string }>) {
  const findMany = jest.fn().mockResolvedValue(due);
  return { prisma: { socialAccount: { findMany } } as any, findMany };
}

function makeInsights() {
  const pull = jest.fn().mockResolvedValue({ posts: 2, accounts: 1, errors: 0, processed: 1, skipped: false });
  return { svc: { pullWorkspaceExclusive: pull } as any, pull };
}

/** A due account row, the shape the cron now selects. */
const dueRow = (id: string, workspaceId: string) => ({ id, workspaceId });

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
    const { svc, pull } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    expect(findMany).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });

  it('is inert without the secret box — every sealed token would fail to open', async () => {
    delete process.env.MARKETING_SECRET_KEY;
    const { prisma, findMany } = makePrisma([dueRow('a1', 'w1')]);
    const { svc } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reads DUE accounts oldest-first, capped, selecting only the two ids', async () => {
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
    // The ACCOUNT id is what makes `take` mean anything — see the allowlist
    // test below. Still no row data: no token, no externalId, nothing readable.
    expect(args.select).toEqual({ id: true, workspaceId: true });

    const dueBefore: Date = args.where.OR[1].insightsPulledAt.lt;
    const ageMs = Date.now() - dueBefore.getTime();
    expect(Math.round(ageMs / 3_600_000)).toBe(SocialInsightsService.PULL_INTERVAL_MS / 3_600_000);
  });

  it('sweeps each workspace once, in due order, and does nothing when nothing is due', async () => {
    const { prisma } = makePrisma([
      dueRow('a1', 'w2'),
      dueRow('a2', 'w1'),
      dueRow('a3', 'w2'),
      dueRow('a4', 'w3'),
    ]);
    const { svc, pull } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    expect(pull.mock.calls.map((c) => c[0])).toEqual(['w2', 'w1', 'w3']);
    // No `force`: the every-6h gate is re-applied per account inside the puller,
    // so a workspace with one due account does not re-read all twelve.
    expect(pull.mock.calls[0][1].force).toBeUndefined();
  });

  it('hands each workspace ONLY the due accounts it read, so a tick cannot exceed BATCH', async () => {
    // THE BUG THIS PINS. The sweep used to select workspaceId alone, de-dupe it
    // to a workspace list, and let pullWorkspace re-derive its own due set with
    // its own take: 100. A batch of due rows spread across N workspaces
    // therefore authorised N × 100 account reads — 20,000 at BATCH=200 — while
    // the class doc claimed the bound was 200. Passing the ids forward makes
    // the batch size the real bound: three due rows, three accounts touched.
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w2'), dueRow('a3', 'w1')]);
    const { svc, pull } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    const allowlists = pull.mock.calls.map((c) => [c[0], c[1].accountIds]);
    expect(allowlists).toEqual([
      // Due order is preserved in both directions: w1 first because it holds
      // the oldest row, and a1 before a3 inside it.
      ['w1', ['a1', 'a3']],
      ['w2', ['a2']],
    ]);
    const touched = allowlists.reduce((n, [, ids]) => n + (ids as string[]).length, 0);
    expect(touched).toBe(3);
  });

  it('takes the per-workspace lock, so the cron and a manual refresh cannot both pull one workspace', async () => {
    const { prisma } = makePrisma([dueRow('a1', 'w1')]);
    const { svc, pull } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    // The tick's own advisory lock is global (one replica sweeps); it says
    // nothing about a manager pressing Refresh on w1 at the same moment. The
    // per-workspace lock is what makes that impossible, and it needs a bounded
    // timeout because it is held inside a transaction.
    expect(pull.mock.calls[0][1].lockTimeoutMs).toBeGreaterThan(0);
  });

  it('skips a workspace a manual refresh is already pulling, and keeps sweeping the rest', async () => {
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w2')]);
    const { svc, pull } = makeInsights();
    pull
      .mockResolvedValueOnce({ posts: 0, accounts: 0, errors: 0, processed: 0, skipped: true })
      .mockResolvedValueOnce({ posts: 3, accounts: 1, errors: 0, processed: 1, skipped: false });

    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();

    // Nothing is lost by the skip: w1's accounts were never stamped, so they
    // are still due — and the manual pull holding the lock stamps them anyway.
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('does not sweep at all when no account is due', async () => {
    const { prisma } = makePrisma([]);
    const { svc, pull } = makeInsights();
    await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();
    expect(pull).not.toHaveBeenCalled();
  });

  it('one failing workspace never aborts the tick', async () => {
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w2')]);
    const { svc, pull } = makeInsights();
    pull
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ posts: 1, accounts: 1, errors: 0, processed: 1, skipped: false });

    await expect(new SocialInsightsCron(prisma, svc).pullDueWorkspaces()).resolves.toBeUndefined();
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('logs the accounts it PROCESSED and the remainder, not the size of the batch it chose', async () => {
    // The overstatement this pins. The line printed `due.length` — the batch the
    // query selected — beside the counts of work completed, so a tick that read
    // one account of the three it picked still announced "3 due account(s)".
    // Three separate things can leave a due row untouched (a busy workspace, the
    // wall-clock budget, and the puller's own per-workspace ACCOUNT_LIMIT
    // shedding a workspace's surplus), and the last of them was invisible from
    // here entirely. Summing what each workspace reports back covers all three.
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w1'), dueRow('a3', 'w1')]);
    const { svc, pull } = makeInsights();
    // One workspace handed three ids and reporting one read — the shape a cap
    // (or any partial sweep) produces.
    pull.mockResolvedValue({ posts: 0, accounts: 1, errors: 0, processed: 1, skipped: false });

    const cron = new SocialInsightsCron(prisma, svc);
    const log = jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
    await cron.pullDueWorkspaces();

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('1 of 3 due account(s) processed');
    // Named as a remainder rather than left to be inferred from a short count:
    // the two it missed were never stamped, so they are still due and lead the
    // next tick.
    expect(line).toContain('2 account(s) roll to the next tick');
  });

  it('says nothing about a remainder when the tick reached every due account', async () => {
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w2')]);
    const { svc, pull } = makeInsights();
    pull.mockResolvedValue({ posts: 0, accounts: 1, errors: 0, processed: 1, skipped: false });

    const cron = new SocialInsightsCron(prisma, svc);
    const log = jest.spyOn((cron as any).logger, 'log').mockImplementation(() => undefined);
    await cron.pullDueWorkspaces();

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('2 of 2 due account(s) processed');
    expect(line).not.toContain('roll to the next tick');
  });

  it('stops at the wall-clock budget instead of overrunning into the next tick', async () => {
    // WHY A WALL CLOCK AND NOT JUST THE LOCK. withAdvisoryLock holds
    // pg_try_advisory_xact_lock inside a transaction with a 55-minute body
    // timeout; when the body overruns, Prisma rolls back — RELEASING the lock —
    // while the body keeps running on the normal pool. The next hourly tick then
    // finds the lock free and starts a second concurrent sweep. Only finishing
    // in time prevents that.
    const { prisma } = makePrisma([dueRow('a1', 'w1'), dueRow('a2', 'w2'), dueRow('a3', 'w3')]);
    const { svc, pull } = makeInsights();

    // Each workspace "takes" half an hour of wall clock. Time is faked rather
    // than spent: the assertion is about the budget check, not about waiting.
    const start = Date.now();
    let elapsed = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => start + elapsed);
    pull.mockImplementation(async () => {
      elapsed += 30 * 60_000;
      return { posts: 0, accounts: 0, errors: 0, processed: 1, skipped: false };
    });

    try {
      await new SocialInsightsCron(prisma, svc).pullDueWorkspaces();
    } finally {
      now.mockRestore();
    }

    // One workspace fits inside the 20-minute budget; the loop then breaks
    // rather than running for another hour. The two it dropped were never
    // stamped, so they stay due and lead the next tick's queue.
    expect(pull).toHaveBeenCalledTimes(1);
  });
});
