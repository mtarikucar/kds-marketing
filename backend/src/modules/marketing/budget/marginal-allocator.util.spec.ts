import { allocate, ChannelPerf } from './marginal-allocator.util';

describe('marginal-allocator', () => {
  it('holds back the exploration reserve from the pool', () => {
    const plan = allocate([{ channel: 'META', currentBudget: 100, spend: 100, revenue: 300 }], {
      totalBudget: 1000,
      explorationPct: 30,
    });
    expect(plan.reserve).toBe(300);
    expect(plan.pool).toBe(700);
  });

  it('never proposes more than the pool (growth budget is a hard cap)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 400, spend: 400, revenue: 2000 },
      { channel: 'GOOGLE', currentBudget: 400, spend: 400, revenue: 1800 },
      { channel: 'TIKTOK', currentBudget: 400, spend: 400, revenue: 1600 },
    ];
    const plan = allocate(perf, { totalBudget: 1000, explorationPct: 20, maxStepPct: 100 });
    const sum = plan.allocations.reduce((s, a) => s + a.after, 0);
    expect(sum).toBeLessThanOrEqual(plan.pool + 0.01);
  });

  it('limits any single channel move to ±maxStepPct of its current budget', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 1000 }, // very high ROAS
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 50 }, // poor ROAS
    ];
    const plan = allocate(perf, { totalBudget: 500, explorationPct: 0, maxStepPct: 20 });
    const meta = plan.allocations.find((a) => a.channel === 'META')!;
    // even though META is the star, it can rise at most +20% in one run
    expect(meta.after).toBeLessThanOrEqual(120 + 0.01);
    expect(meta.deltaPct).toBeLessThanOrEqual(20 + 0.01);
  });

  it('respects per-channel floors and ceilings', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 900, maxBudget: 110 },
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 300, minBudget: 90 },
    ];
    const plan = allocate(perf, { totalBudget: 1000, explorationPct: 0, maxStepPct: 100 });
    expect(plan.allocations.find((a) => a.channel === 'META')!.after).toBeLessThanOrEqual(110);
    expect(plan.allocations.find((a) => a.channel === 'GOOGLE')!.after).toBeGreaterThanOrEqual(90);
  });

  it('holds current budgets when nothing clears the ROAS floor', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 80 }, // ROAS 0.8
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 90 }, // ROAS 0.9
    ];
    const plan = allocate(perf, { totalBudget: 1000, explorationPct: 0, targetRoas: 1.5 });
    expect(plan.allocations.every((a) => a.reason === 'below-target-hold')).toBe(true);
    expect(plan.allocations.every((a) => a.after === a.before)).toBe(true);
  });

  it('holds on cold start (no spend/revenue anywhere)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 50, spend: 0, revenue: 0 },
      { channel: 'GOOGLE', currentBudget: 50, spend: 0, revenue: 0 },
    ];
    const plan = allocate(perf, { totalBudget: 200 });
    expect(plan.noop).toBe(true);
    expect(plan.allocations.every((a) => a.reason === 'cold-start-hold')).toBe(true);
  });

  it('shifts the marginal dollar toward the higher-ROAS channel when the pool is constrained', () => {
    // Pool == current total, so the two channels genuinely compete for the same
    // dollars (not enough headroom for both to hit their step cap).
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 400 }, // ROAS 4
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 150 }, // ROAS 1.5
    ];
    const plan = allocate(perf, { totalBudget: 200, explorationPct: 0, maxStepPct: 50 });
    const meta = plan.allocations.find((a) => a.channel === 'META')!;
    const google = plan.allocations.find((a) => a.channel === 'GOOGLE')!;
    expect(meta.after).toBeGreaterThan(google.after); // star keeps the bigger slice
    expect(meta.after).toBeGreaterThan(meta.before); // and scales up
    expect(google.after).toBeLessThan(google.before); // laggard is trimmed
  });
});
