import { AiUsageStatsService } from './ai-usage-stats.service';
import { usdFor, priceFor } from './ai-model-prices';

/**
 * The point of this service is to make one claim checkable: that what we CHARGE
 * for an action (ai-credit-costs.ts, derived from max_tokens ceilings) bears
 * some relation to what the vendor BILLS for it. So the arithmetic has to be
 * right, and an unknown model must never be reported as cheap.
 */
describe('ai-model-prices', () => {
  it('prices each family from its model id, version-independently', () => {
    expect(priceFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(priceFor('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
    expect(priceFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
  });

  it('prices an unrecognised model at the most expensive tier', () => {
    // Under-reporting the bill is the one failure that would make this whole
    // surface worse than useless.
    expect(priceFor('claude-something-new')).toEqual({ input: 5, output: 25 });
    expect(priceFor('')).toEqual({ input: 5, output: 25 });
  });

  it('computes dollars from measured tokens', () => {
    // 1M in + 1M out on Opus = $5 + $25.
    expect(usdFor('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30);
    expect(usdFor('claude-haiku-4-5', { inputTokens: 200_000, outputTokens: 10_000 })).toBeCloseTo(
      0.25,
      6,
    );
  });

  it('prices cache writes at a premium and cache reads at a tenth', () => {
    // Anthropic reports these OUTSIDE input_tokens. Ignoring them would make a
    // cached loop look ~free and hide the write premium entirely — the report
    // would err optimistic, which is the one direction it must not err.
    expect(usdFor('claude-opus-4-8', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(6.25);
    expect(usdFor('claude-opus-4-8', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.5);
  });

  it('shows caching as a large saving, not a total one', () => {
    // 12.000 tokens of tool schema over 8 turns: uncached vs written once and
    // read seven times. The saving is real but bounded.
    const uncached = usdFor('claude-opus-4-8', { inputTokens: 96_000, outputTokens: 0 });
    const cached = usdFor('claude-opus-4-8', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 12_000,
      cacheReadTokens: 84_000,
    });
    expect(uncached).toBeCloseTo(0.48, 4);
    expect(cached).toBeCloseTo(0.117, 3);
    expect(cached / uncached).toBeGreaterThan(0.2);
  });
});

describe('AiUsageStatsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: AiUsageStatsService;

  beforeEach(() => {
    prisma = { aiUsageLog: { groupBy: jest.fn(), findMany: jest.fn() } };
    svc = new AiUsageStatsService(prisma);
  });

  it('ranks actions by real cost and flags the ones sold under cost', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      // 10 command turns, Opus, schema-heavy input. Charged 5 credits each
      // = 50 credits = $0.50 at the anchor.
      {
        action: 'command.turn',
        model: 'claude-opus-4-8',
        _count: { _all: 10 },
        _sum: { inputTokens: 500_000, outputTokens: 5_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      },
      {
        action: 'conversation.reply',
        model: 'claude-haiku-4-5',
        _count: { _all: 40 },
        _sum: { inputTokens: 40_000, outputTokens: 8_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      },
    ]);

    const out = await svc.breakdown(WS, 30);

    // $2.50 input + $0.125 output = $2.625 for the command turns.
    expect(out.rows[0].action).toBe('command.turn');
    expect(out.rows[0].usd).toBeCloseTo(2.625, 3);
    expect(out.rows[0].credits).toBe(50);
    // Costs 5.25x what it bills — the number that says "fix this one".
    expect(out.rows[0].costRatio).toBeCloseTo(5.25, 2);
    // Cheaper action sorts below regardless of call count.
    expect(out.rows[1].action).toBe('conversation.reply');
    expect(out.total.usd).toBeCloseTo(2.71, 2);
  });

  it('reports the input/output ratio — the tell that caching is the lever', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      {
        action: 'command.turn',
        model: 'claude-opus-4-8',
        _count: { _all: 1 },
        _sum: { inputTokens: 100_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      },
    ]);
    const out = await svc.breakdown(WS, 30);
    expect(out.total.inputOutputRatio).toBe(100);
  });

  it('counts cached input in the ratio, so caching does not fake a lean loop', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      {
        action: 'command.turn',
        model: 'claude-opus-4-8',
        _count: { _all: 1 },
        // After caching, almost all input volume moves into the cache fields.
        // Reading only inputTokens would report a 1:1 loop and hide the very
        // schema weight the ratio exists to expose.
        _sum: { inputTokens: 1_000, outputTokens: 1_000, cacheWriteTokens: 12_000, cacheReadTokens: 84_000 },
      },
    ]);
    const out = await svc.breakdown(WS, 30);
    expect(out.total.inputOutputRatio).toBe(97);
  });

  it('leaves costRatio null for an action with no price entry', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      {
        action: 'some.retired.action',
        model: 'claude-opus-4-8',
        _count: { _all: 2 },
        _sum: { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 },
      },
    ]);
    const out = await svc.breakdown(WS, 30);
    // Guessing a ratio from a missing price would invent a finding.
    expect(out.rows[0].costRatio).toBeNull();
  });

  it('scopes to one workspace, and omits the filter for the platform view', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([]);

    await svc.breakdown(WS, 7);
    expect(prisma.aiUsageLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );

    await svc.breakdown(undefined, 7);
    expect(prisma.aiUsageLog.groupBy.mock.calls[1][0].where).not.toHaveProperty('workspaceId');
    expect((await svc.breakdown(undefined, 7)).scope).toBe('platform');
  });

  it('clamps the window rather than trusting the caller', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([]);
    const before = Date.now();
    await svc.breakdown(WS, 99999);
    const gte: Date = prisma.aiUsageLog.groupBy.mock.calls[0][0].where.createdAt.gte;
    // 365 days, not 99999.
    expect(before - gte.getTime()).toBeLessThanOrEqual(366 * 86_400_000);
    expect(before - gte.getTime()).toBeGreaterThan(364 * 86_400_000);
  });

  it('buckets the daily curve newest-first so a spike is the first row', async () => {
    prisma.aiUsageLog.findMany.mockResolvedValue([
      { createdAt: new Date('2026-08-10T09:00:00Z'), model: 'claude-opus-4-8', inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { createdAt: new Date('2026-08-12T09:00:00Z'), model: 'claude-opus-4-8', inputTokens: 200_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { createdAt: new Date('2026-08-12T21:00:00Z'), model: 'claude-opus-4-8', inputTokens: 200_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    ]);
    const days = await svc.daily(WS, 30);
    expect(days[0]).toEqual({ day: '2026-08-12', calls: 2, usd: 2 });
    expect(days[1]).toEqual({ day: '2026-08-10', calls: 1, usd: 5 });
  });
});
