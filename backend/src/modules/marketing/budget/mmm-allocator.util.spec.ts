import { allocate, ChannelPerf } from './mmm-allocator.util';

describe('mmm-allocator (Stage-3 MMM-lite)', () => {
  it('holds back the exploration reserve and never proposes more than the pool (hard cap)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 400, spend: 400, revenue: 2000 },
      { channel: 'GOOGLE', currentBudget: 400, spend: 400, revenue: 1800 },
      { channel: 'TIKTOK', currentBudget: 400, spend: 400, revenue: 1600 },
    ];
    const plan = allocate(perf, { totalBudget: 1000, explorationPct: 30, maxStepPct: 100 });
    expect(plan.reserve).toBe(300);
    expect(plan.pool).toBe(700);
    const sum = plan.allocations.reduce((s, a) => s + a.after, 0);
    expect(sum).toBeLessThanOrEqual(plan.pool + 0.01);
  });

  it('equalizes the fitted marginal return across two funded channels (water level)', () => {
    // k = revenue/√spend  ⇒ META k=40, GOOGLE k=20. Water-filling makes the next
    // dollar buy the same marginal revenue in both, so marginalRoas must match.
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 400 },
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 200 },
    ];
    const plan = allocate(perf, { totalBudget: 200, explorationPct: 0, maxStepPct: 100 });
    const meta = plan.allocations.find((a) => a.channel === 'META')!;
    const google = plan.allocations.find((a) => a.channel === 'GOOGLE')!;
    // both funded (moved off their before), and marginal returns equalized
    expect(meta.after).toBeGreaterThan(meta.before);
    expect(google.after).toBeLessThan(google.before);
    expect(Math.abs(meta.marginalRoas - google.marginalRoas)).toBeLessThan(0.05);
    // pool is fully used
    expect(meta.after + google.after).toBeCloseTo(plan.pool, 1);
  });

  it('concavity: a saturated high-spend channel yields budget to an unsaturated one', () => {
    // META: spend 300 → marginal k/(2√s) = 34.64/(2·17.32) = 1.0 (saturated, big budget).
    // GOOGLE: spend 100 → marginal 40/(2·10) = 2.0 (unsaturated, small budget, stronger next dollar).
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 300, spend: 300, revenue: 600 },
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 400 },
    ];
    const plan = allocate(perf, { totalBudget: 400, explorationPct: 0, maxStepPct: 100 });
    const meta = plan.allocations.find((a) => a.channel === 'META')!;
    const google = plan.allocations.find((a) => a.channel === 'GOOGLE')!;
    expect(google.after).toBeGreaterThan(google.before); // unsaturated channel gains
    expect(meta.after).toBeLessThan(meta.before); // saturated channel yields
    expect(google.reason).toBe('mmm-scale');
    expect(meta.reason).toBe('mmm-saturated');
  });

  it('respects the ±maxStep band and per-channel floors/ceilings', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 1000 }, // star, but +maxStep-capped
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 300, minBudget: 90 },
      { channel: 'TIKTOK', currentBudget: 100, spend: 100, revenue: 800, maxBudget: 105 },
    ];
    const plan = allocate(perf, { totalBudget: 500, explorationPct: 0, maxStepPct: 20 });
    const meta = plan.allocations.find((a) => a.channel === 'META')!;
    const google = plan.allocations.find((a) => a.channel === 'GOOGLE')!;
    const tiktok = plan.allocations.find((a) => a.channel === 'TIKTOK')!;
    // even the star may rise at most +20% in one run
    expect(meta.after).toBeLessThanOrEqual(120 + 0.01);
    expect(meta.deltaPct).toBeLessThanOrEqual(20 + 0.01);
    // floor and ceiling honored
    expect(google.after).toBeGreaterThanOrEqual(90);
    expect(tiktok.after).toBeLessThanOrEqual(105 + 0.01);
  });

  it('holds on cold start (no spend/revenue anywhere)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 50, spend: 0, revenue: 0 },
      { channel: 'GOOGLE', currentBudget: 50, spend: 0, revenue: 0 },
    ];
    const plan = allocate(perf, { totalBudget: 200 });
    expect(plan.noop).toBe(true);
    expect(plan.allocations.every((a) => a.reason === 'mmm-hold')).toBe(true);
    expect(plan.allocations.every((a) => a.after === a.before)).toBe(true);
  });

  it('holds current budgets when nothing clears the ROAS floor (noop)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 80 }, // ROAS 0.8
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 90 }, // ROAS 0.9
    ];
    const plan = allocate(perf, { totalBudget: 1000, explorationPct: 0, targetRoas: 1.5 });
    expect(plan.noop).toBe(true);
    expect(plan.allocations.every((a) => a.reason === 'mmm-hold')).toBe(true);
    expect(plan.allocations.every((a) => a.after === a.before)).toBe(true);
  });
});
