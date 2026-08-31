import 'reflect-metadata';
import { ResearchLeaseService, TAKEOVER_WINDOW_DAYS } from './research-lease.service';
import { RESEARCH_RUN_KIND } from './research-kinds';

const WS = 'ws-a';
const FOREIGN = 'ws-b';

/**
 * A fallback that quietly keeps the cost on the platform is the SAME trap as a
 * lane that silently stops, approached from the other side: the owner sees
 * research working, never learns their scheduled task is dead, and Jeeta pays
 * for every night forever.
 *
 * So a takeover is recorded on the job it happened to, with what it cost, and
 * read back by name for the panel.
 */
describe('ResearchLeaseService — recording a platform takeover', () => {
  function build(
    over: {
      payload?: Record<string, unknown>;
      usage?: Array<Record<string, unknown>>;
      usageThrows?: boolean;
    } = {},
  ) {
    const updates: any[] = [];
    const usageWheres: any[] = [];
    const prisma = {
      scheduledJob: {
        findFirst: jest.fn().mockResolvedValue({
          payload: over.payload ?? { profileId: 'p1' },
        }),
        updateMany: jest.fn(async (args: any) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
      aiUsageLog: {
        findMany: jest.fn(async (args: any) => {
          usageWheres.push(args.where);
          if (over.usageThrows) throw new Error('usage table unavailable');
          return over.usage ?? [];
        }),
      },
    };
    const svc = new ResearchLeaseService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma, updates, usageWheres };
  }

  const OPUS_TURN = {
    model: 'claude-opus-4-8',
    inputTokens: 17_000,
    outputTokens: 330,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    webSearches: 0,
  };

  it('stamps the job it took over, preserving everything already in the payload', async () => {
    const { svc, updates } = build({ payload: { profileId: 'p1', mcpAgentRunId: 'run-9' } });

    await svc.recordPlatformTakeover(WS, 'job-1', new Date(Date.now() - 60_000));

    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: 'job-1', workspaceId: WS });
    expect(updates[0].data.payload).toMatchObject({
      profileId: 'p1',
      mcpAgentRunId: 'run-9',
      platformTookOver: true,
    });
    expect(typeof updates[0].data.payload.platformTookOverAt).toBe('string');
  });

  it('prices the run from what it actually billed, server-tool calls included', async () => {
    const { svc, updates } = build({
      usage: [
        OPUS_TURN,
        // A native web search bills PER REQUEST. Leave it out and a
        // search-driven takeover reports only its cheap Haiku tokens.
        {
          model: 'claude-haiku-4-5',
          inputTokens: 500,
          outputTokens: 100,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          webSearches: 3,
        },
      ],
    });

    await svc.recordPlatformTakeover(WS, 'job-1', new Date(Date.now() - 60_000));

    const usd = updates[0].data.payload.platformTookOverUsd as number;
    // 17.000 in + 330 out on Opus = 0.085 + 0.00825; Haiku 500 in + 100 out =
    // 0.0005 + 0.0005; 3 web searches at $10/1000 = 0.03.
    expect(usd).toBeCloseTo(0.1243, 4);
  });

  /**
   * ERROR IS NOT ZERO. A takeover whose cost we could not read must record
   * `null`, so the panel can say "we ran it" without inventing a price.
   */
  it('records a null cost — never a zero — when the usage log cannot be read', async () => {
    const { svc, updates } = build({ usageThrows: true });

    await svc.recordPlatformTakeover(WS, 'job-1', new Date(Date.now() - 60_000));

    expect(updates[0].data.payload.platformTookOverUsd).toBeNull();
    expect(updates[0].data.payload.platformTookOver).toBe(true);
  });

  it('reads usage for THIS workspace, THIS run window, and only research actions', async () => {
    const since = new Date(Date.now() - 60_000);
    const { svc, usageWheres } = build();

    await svc.recordPlatformTakeover(WS, 'job-1', since);

    expect(usageWheres[0].workspaceId).toBe(WS);
    expect(usageWheres[0].createdAt.gte).toEqual(since);
    expect(usageWheres[0].action.in).toEqual(
      expect.arrayContaining(['research.turn', 'research.native_search', 'research.native_scrape']),
    );
  });

  /**
   * A takeover that FAILS and is retried is still one night the platform paid
   * for twice. Accumulate rather than overwrite, or the second attempt erases
   * the first attempt's bill.
   */
  it('accumulates cost and attempts across a retried takeover', async () => {
    const { svc, updates } = build({
      payload: {
        profileId: 'p1',
        platformTookOver: true,
        platformTookOverUsd: 0.2,
        platformTookOverRuns: 1,
      },
      usage: [OPUS_TURN],
    });

    await svc.recordPlatformTakeover(WS, 'job-1', new Date());

    expect(updates[0].data.payload.platformTookOverRuns).toBe(2);
    expect(updates[0].data.payload.platformTookOverUsd).toBeCloseTo(0.2 + 0.09325, 4);
  });

  /** Tenant isolation, failing on its own: the guard is on the write. */
  it('can only stamp a job in the caller workspace', async () => {
    const { svc, updates } = build();
    await svc.recordPlatformTakeover(WS, 'job-1', new Date());
    expect(updates[0].where.workspaceId).toBe(WS);
  });
});

describe('ResearchLeaseService — reading takeovers back for the panel', () => {
  function build(rows: Array<Record<string, unknown>>) {
    const wheres: any[] = [];
    const prisma = {
      scheduledJob: {
        findMany: jest.fn(async (args: any) => {
          wheres.push(args.where);
          return rows;
        }),
      },
    };
    const svc = new ResearchLeaseService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma, wheres };
  }

  const took = (usd: number | null, at: string) => ({
    completedAt: new Date(at),
    payload: {
      profileId: 'p1',
      platformTookOver: true,
      platformTookOverAt: at,
      platformTookOverUsd: usd,
      platformTookOverRuns: 1,
    },
  });

  it('counts the nights, totals the cost and names the most recent one', async () => {
    const { svc } = build([
      took(0.26, '2026-08-31T09:00:00.000Z'),
      took(0.12, '2026-08-30T09:00:00.000Z'),
    ]);

    const res = await svc.recentPlatformTakeovers(WS);

    expect(res).toEqual({
      count: 2,
      lastAt: '2026-08-31T09:00:00.000Z',
      costUsd: 0.38,
      costUnknown: 0,
    });
  });

  it('reports zero takeovers as zero, with no cost and no date', async () => {
    const { svc } = build([]);
    expect(await svc.recentPlatformTakeovers(WS)).toEqual({
      count: 0,
      lastAt: null,
      costUsd: null,
      costUnknown: 0,
    });
  });

  /**
   * A night whose cost could not be measured is COUNTED but not priced, and the
   * panel is told how many so it can say "at least" instead of a number that
   * silently understates the bill.
   */
  it('keeps an unpriced takeover in the count and flags it separately', async () => {
    const { svc } = build([took(null, '2026-08-31T09:00:00.000Z'), took(0.26, '2026-08-30T09:00:00.000Z')]);

    expect(await svc.recentPlatformTakeovers(WS)).toEqual({
      count: 2,
      lastAt: '2026-08-31T09:00:00.000Z'
,
      costUsd: 0.26,
      costUnknown: 1,
    });
  });

  it('scopes the read to this workspace, the research kind and the window', async () => {
    const { svc, wheres } = build([]);
    const before = Date.now();

    await svc.recentPlatformTakeovers(WS);

    expect(wheres[0].workspaceId).toBe(WS);
    expect(wheres[0].kind).toBe(RESEARCH_RUN_KIND);
    expect(wheres[0].payload).toEqual({ path: ['platformTookOver'], equals: true });
    const cutoff = wheres[0].completedAt.gte as Date;
    const windowMs = TAKEOVER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(windowMs - 5_000);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(windowMs + 5_000);
  });

  it('ignores a row whose payload does not actually carry the marker', async () => {
    // Defence in depth against the JSON filter above being loosened: a job the
    // MCP lane drained normally must never be counted as a takeover.
    const { svc } = build([
      { completedAt: new Date(), payload: { profileId: 'p1', mcpAgentRunId: 'run-1' } },
    ]);
    expect((await svc.recentPlatformTakeovers(WS)).count).toBe(0);
  });

  it('never reads another workspace rows', async () => {
    const { svc, wheres } = build([]);
    await svc.recentPlatformTakeovers(FOREIGN);
    expect(wheres[0].workspaceId).toBe(FOREIGN);
  });
});

/**
 * The takeover report has to reach the panel through the SAME object the queue
 * counts do, and it has to obey the same rule: a read that fails rejects, so
 * the home timeline names the source in `unread` rather than drawing a zero.
 */
describe('ResearchLeaseService — queueStatus carries the takeovers', () => {
  function build(over: { takeoverThrows?: boolean } = {}) {
    const prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ researchExecution: 'MCP' }) },
      scheduledJob: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(async () => {
          if (over.takeoverThrows) throw new Error('scheduled_jobs unavailable');
          return [
            {
              completedAt: new Date('2026-08-31T09:00:00.000Z'),
              payload: {
                platformTookOver: true,
                platformTookOverAt: '2026-08-31T09:00:00.000Z',
                platformTookOverUsd: 0.26,
                platformTookOverRuns: 1,
              },
            },
          ];
        }),
      },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
    };
    const svc = new ResearchLeaseService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { svc, prisma };
  }

  it('reports the takeovers alongside the queue counts', async () => {
    const { svc } = build();
    const res = await svc.queueStatus(WS);
    expect(res.takenOver).toEqual({
      count: 1,
      lastAt: '2026-08-31T09:00:00.000Z',
      costUsd: 0.26,
      costUnknown: 0,
    });
  });

  it('rejects rather than reporting zero takeovers when the read fails', async () => {
    const { svc } = build({ takeoverThrows: true });
    await expect(svc.queueStatus(WS)).rejects.toThrow(/unavailable/);
  });
});
