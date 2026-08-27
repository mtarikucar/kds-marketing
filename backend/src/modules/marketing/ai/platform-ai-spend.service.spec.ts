import { PlatformAiSpendService } from './platform-ai-spend.service';

/**
 * Every pre-existing guard asks whether the CUSTOMER has allowance left, and
 * every one of them answers "yes, forever" on an unlimited plan. So the number
 * that actually gets billed to us had no bound at all — which is exactly how a
 * vendor balance empties with no warning anywhere in the product.
 *
 * Reloading the module per test because the cap is read from the environment
 * at import time (it is deployment config, not per-call state).
 */
describe('PlatformAiSpendService', () => {
  const OPUS = 'claude-opus-4-8';

  function load(capUsd?: string) {
    jest.resetModules();
    if (capUsd === undefined) delete process.env.AI_PLATFORM_MONTHLY_USD_CAP;
    else process.env.AI_PLATFORM_MONTHLY_USD_CAP = capUsd;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./platform-ai-spend.service')
      .PlatformAiSpendService as typeof PlatformAiSpendService;
  }

  /** `n` USD of Opus spend, expressed as output tokens ($25/MTok). */
  const spendOf = (usd: number) => [
    {
      model: OPUS,
      _sum: {
        inputTokens: 0,
        outputTokens: (usd / 25) * 1_000_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    },
  ];

  /** One unlimited-plan workspace, which is the only thing the cap watches. */
  const prismaWith = (rows: unknown, groupBy = jest.fn().mockResolvedValue(rows)) => ({
    aiUsageLog: { groupBy },
    workspaceSubscription: {
      findMany: jest.fn().mockResolvedValue([{ workspaceId: 'ws-own', packageId: 'pkg-op' }]),
    },
    package: {
      findMany: jest.fn().mockResolvedValue([{ id: 'pkg-op', limits: { aiCreditsMonthly: -1 } }]),
    },
  });

  const svcWith = (Cls: typeof PlatformAiSpendService, rows: unknown) =>
    new Cls(prismaWith(rows) as any);

  it('sums the month across every workspace, cache tokens included', async () => {
    const Cls = load('250');
    const groupBy = jest.fn().mockResolvedValue(spendOf(40));
    const svc = new Cls(prismaWith(null, groupBy) as any);

    await expect(svc.monthToDateUsd(new Date('2026-08-18T00:00:00Z'))).resolves.toBe(40);
    const where = groupBy.mock.calls[0][0].where;
    // Scoped to unlimited plans. A metered tenant cannot overspend anyway, and
    // counting them would let a growing customer base trip a ceiling that then
    // halts OUR internal work.
    expect(where.workspaceId).toEqual({ in: ['ws-own'] });
    expect(where.createdAt.gte).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(groupBy.mock.calls[0][0]._sum).toHaveProperty('cacheReadTokens', true);
  });

  it('escalates OK → WARN → CRITICAL → EXCEEDED against the cap', async () => {
    const Cls = load('100');
    const at = async (usd: number) => (await svcWith(Cls, spendOf(usd)).status()).state;

    expect(await at(10)).toBe('OK');
    expect(await at(55)).toBe('WARN');
    expect(await at(85)).toBe('CRITICAL');
    expect(await at(120)).toBe('EXCEEDED');
  });

  it('stops UNATTENDED work at the cap and leaves interactive alone', async () => {
    const Cls = load('100');
    const over = svcWith(Cls, spendOf(150));

    expect((await over.status()).backgroundBlocked).toBe(true);
    await expect(over.mayRunBackground()).resolves.toBe(false);

    // The asymmetry is the point: a customer refused mid-click because of OUR
    // budget has been failed twice. Only the nightly lane stands down.
    const under = svcWith(Cls, spendOf(10));
    expect((await under.status()).backgroundBlocked).toBe(false);
    await expect(under.mayRunBackground()).resolves.toBe(true);
  });

  it('reports DISABLED rather than pretending to protect when no cap is set', async () => {
    const Cls = load('0');
    const s = await svcWith(Cls, spendOf(999)).status();

    expect(s.state).toBe('DISABLED');
    expect(s.ratio).toBeNull();
    expect(s.backgroundBlocked).toBe(false);
    // Still reports the spend — a disabled ceiling is not a reason to stop counting.
    expect(s.spentUsd).toBe(999);
  });

  it('ignores metered tenants entirely — their allowance already bounds them', async () => {
    const Cls = load('100');
    const groupBy = jest.fn().mockResolvedValue([]);
    const svc = new Cls({
      aiUsageLog: { groupBy },
      workspaceSubscription: {
        findMany: jest.fn().mockResolvedValue([{ workspaceId: 'ws-paying', packageId: 'pkg-scale' }]),
      },
      // SCALE: 6000 credits/month, a real number — reserve() throws at it.
      package: {
        findMany: jest.fn().mockResolvedValue([{ id: 'pkg-scale', limits: { aiCreditsMonthly: 6000 } }]),
      },
    } as any);

    await expect(svc.monthToDateUsd()).resolves.toBe(0);
    // Not even queried: there is nothing here for this ceiling to protect.
    expect(groupBy).not.toHaveBeenCalled();
    await expect(svc.mayRunBackground()).resolves.toBe(true);
  });

  it('fails OPEN when metering breaks — a hiccup must not halt everyone research', async () => {
    const Cls = load('100');
    const svc = new Cls(
      prismaWith(null, jest.fn().mockRejectedValue(new Error('db down'))) as any,
    );
    await expect(svc.mayRunBackground()).resolves.toBe(true);
  });

  it('reports the period it is talking about', async () => {
    const Cls = load('100');
    const s = await svcWith(Cls, spendOf(1)).status(new Date('2026-01-09T12:00:00Z'));
    expect(s.period).toBe('2026-01');
  });
});

/**
 * ONE workspace's monthly ceiling, in real money.
 *
 * The platform cap protects the aggregate; nothing protected us from a single
 * workspace. The per-workspace guard that existed asked about CREDITS, and an
 * unlimited plan answers "yes, forever" — so the only brake on one workspace's
 * nightly research was how many profiles it happened to have. Ten runs a night
 * at roughly $0.25 each is about $75 a month, from one workspace, silently.
 *
 * Measured live before writing this: a quiet day ran ~$0.45 and a busy stretch
 * ~$2.40/day for four days — 60% of the month in four days. The average was
 * never the problem; the peak was, and only a ceiling catches a peak.
 */
describe('PlatformAiSpendService — per-workspace budget', () => {
  const OPUS2 = 'claude-opus-4-8';
  const spend = (usd: number) => [
    {
      model: OPUS2,
      _sum: {
        inputTokens: 0,
        outputTokens: (usd / 25) * 1_000_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    },
  ];

  function load(cap?: string) {
    jest.resetModules();
    if (cap === undefined) delete process.env.AI_WORKSPACE_MONTHLY_USD_CAP;
    else process.env.AI_WORKSPACE_MONTHLY_USD_CAP = cap;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./platform-ai-spend.service')
      .PlatformAiSpendService as typeof PlatformAiSpendService;
  }

  const make = (Cls: typeof PlatformAiSpendService, usd: number, groupBy = jest.fn()) => {
    groupBy.mockResolvedValue(spend(usd));
    return { svc: new Cls({ aiUsageLog: { groupBy } } as never), groupBy };
  };

  it('scopes the sum to the one workspace, and does not filter by plan', async () => {
    const Cls = load('20');
    const { svc, groupBy } = make(Cls, 5);

    await expect(
      svc.workspaceMonthToDateUsd('ws-1', new Date('2026-08-18T00:00:00Z')),
    ).resolves.toBe(5);

    const where = groupBy.mock.calls[0][0].where;
    expect(where.workspaceId).toBe('ws-1');
    // A metered plan has its own credit ceiling; this one is about money, so it
    // must not silently exclude anybody.
    expect(where).not.toHaveProperty('workspaceId.in');
  });

  it('lets background work run while the workspace is under budget', async () => {
    const Cls = load('20');
    const { svc } = make(Cls, 19.99);

    await expect(svc.mayWorkspaceRunBackground('ws-1')).resolves.toBe(true);
  });

  it('stops unattended work once the workspace reaches its cap', async () => {
    const Cls = load('20');
    const { svc } = make(Cls, 20);

    await expect(svc.mayWorkspaceRunBackground('ws-1')).resolves.toBe(false);
  });

  it('defaults the cap to $20 with no env set', async () => {
    const Cls = load(undefined);
    const { svc } = make(Cls, 21);

    const s = await svc.workspaceStatus('ws-1');
    expect(s.capUsd).toBe(20);
    expect(s.overCap).toBe(true);
  });

  it('treats a zero or absent cap as "no ceiling" rather than "no budget"', async () => {
    const Cls = load('0');
    const { svc } = make(Cls, 999);

    // Misreading this would suspend every workspace's research at once.
    const s = await svc.workspaceStatus('ws-1');
    expect(s.overCap).toBe(false);
    await expect(svc.mayWorkspaceRunBackground('ws-1')).resolves.toBe(true);
  });

  it('fails OPEN when the meter itself errors', async () => {
    const Cls = load('20');
    const groupBy = jest.fn().mockRejectedValue(new Error('db down'));
    const svc = new Cls({ aiUsageLog: { groupBy } } as never);

    // A metering hiccup must not silently stop research for a workspace that is
    // well inside its budget.
    await expect(svc.mayWorkspaceRunBackground('ws-1')).resolves.toBe(true);
  });
});
