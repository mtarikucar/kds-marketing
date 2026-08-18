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

  const svcWith = (Cls: typeof PlatformAiSpendService, rows: unknown) =>
    new Cls({ aiUsageLog: { groupBy: jest.fn().mockResolvedValue(rows) } } as any);

  it('sums the month across every workspace, cache tokens included', async () => {
    const Cls = load('250');
    const groupBy = jest.fn().mockResolvedValue(spendOf(40));
    const svc = new Cls({ aiUsageLog: { groupBy } } as any);

    await expect(svc.monthToDateUsd(new Date('2026-08-18T00:00:00Z'))).resolves.toBe(40);
    // No workspace filter: this is the operator's question, not a tenant's.
    const where = groupBy.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('workspaceId');
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

  it('fails OPEN when metering breaks — a hiccup must not halt everyone research', async () => {
    const Cls = load('100');
    const svc = new Cls({
      aiUsageLog: { groupBy: jest.fn().mockRejectedValue(new Error('db down')) },
    } as any);
    await expect(svc.mayRunBackground()).resolves.toBe(true);
  });

  it('reports the period it is talking about', async () => {
    const Cls = load('100');
    const s = await svcWith(Cls, spendOf(1)).status(new Date('2026-01-09T12:00:00Z'));
    expect(s.period).toBe('2026-01');
  });
});
