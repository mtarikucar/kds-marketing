import { allocateBandit, mulberry32, ChannelPerf } from './bandit-allocator.util';

describe('bandit-allocator (Stage-2 Thompson sampling)', () => {
  it('holds back the exploration reserve and never proposes more than the pool', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 400, spend: 400, revenue: 2000, conversions: 40 },
      { channel: 'GOOGLE', currentBudget: 400, spend: 400, revenue: 1800, conversions: 36 },
      { channel: 'TIKTOK', currentBudget: 400, spend: 400, revenue: 1600, conversions: 32 },
    ];
    // Run across many seeds: the reserve/pool math and the hard cap must ALWAYS hold.
    for (let seed = 1; seed <= 200; seed++) {
      const plan = allocateBandit(perf, { totalBudget: 1000, explorationPct: 30, maxStepPct: 100 }, mulberry32(seed));
      expect(plan.reserve).toBe(300);
      expect(plan.pool).toBe(700);
      const sum = plan.allocations.reduce((s, a) => s + a.after, 0);
      expect(sum).toBeLessThanOrEqual(plan.pool + 0.01);
    }
  });

  it('is deterministic under a seeded rng (exactly reproducible)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 400, conversions: 20 },
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 150, conversions: 10 },
    ];
    const a = allocateBandit(perf, { totalBudget: 400, explorationPct: 20, maxStepPct: 50 }, mulberry32(42));
    const b = allocateBandit(perf, { totalBudget: 400, explorationPct: 20, maxStepPct: 50 }, mulberry32(42));
    expect(a).toEqual(b);
  });

  it('gives a cold-start channel exploration budget (labelled bandit-explore)', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 300, conversions: 30 },
      { channel: 'NEW', currentBudget: 20, spend: 0, revenue: 0 }, // cold start
    ];
    // Average across seeds so the assertion is about the bandit, not one draw.
    let gained = 0;
    const seeds = 60;
    for (let seed = 1; seed <= seeds; seed++) {
      const plan = allocateBandit(perf, { totalBudget: 500, explorationPct: 20, maxStepPct: 100 }, mulberry32(seed));
      const cold = plan.allocations.find((a) => a.channel === 'NEW')!;
      expect(cold.reason).toBe('bandit-explore');
      if (cold.after > cold.before) gained++;
    }
    // The cold arm gets funded above its starting budget in the vast majority of runs.
    expect(gained).toBeGreaterThan(seeds * 0.8);
  });

  it('backs a clearly-superior channel more, on average across seeds', () => {
    const perf: ChannelPerf[] = [
      { channel: 'STAR', currentBudget: 100, spend: 100, revenue: 600, conversions: 60 }, // ROAS 6
      { channel: 'DUD', currentBudget: 100, spend: 100, revenue: 120, conversions: 12 }, // ROAS 1.2
    ];
    let starTotal = 0;
    let dudTotal = 0;
    const seeds = 100;
    for (let seed = 1; seed <= seeds; seed++) {
      const plan = allocateBandit(perf, { totalBudget: 200, explorationPct: 0, maxStepPct: 50 }, mulberry32(seed));
      starTotal += plan.allocations.find((a) => a.channel === 'STAR')!.after;
      dudTotal += plan.allocations.find((a) => a.channel === 'DUD')!.after;
    }
    expect(starTotal).toBeGreaterThan(dudTotal);
  });

  it('respects maxStepPct and per-channel min/max clamps on every seed', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 900, conversions: 90, maxBudget: 110 },
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 300, conversions: 30, minBudget: 90 },
    ];
    for (let seed = 1; seed <= 150; seed++) {
      const plan = allocateBandit(perf, { totalBudget: 1000, explorationPct: 0, maxStepPct: 20 }, mulberry32(seed));
      const meta = plan.allocations.find((a) => a.channel === 'META')!;
      const google = plan.allocations.find((a) => a.channel === 'GOOGLE')!;
      // maxStep: neither may move more than ±20% of its current budget...
      expect(meta.after).toBeLessThanOrEqual(120 + 0.01);
      expect(meta.after).toBeGreaterThanOrEqual(80 - 0.01);
      expect(google.after).toBeLessThanOrEqual(120 + 0.01);
      // ...and the per-channel ceiling/floor bind further.
      expect(meta.after).toBeLessThanOrEqual(110 + 0.01);
      expect(google.after).toBeGreaterThanOrEqual(90 - 0.01);
    }
  });

  it('is a noop on empty input', () => {
    const plan = allocateBandit([], { totalBudget: 1000 }, mulberry32(1));
    expect(plan.allocations).toEqual([]);
    expect(plan.noop).toBe(true);
  });

  it('holds (bandit-hold) when nothing clears the ROAS floor', () => {
    const perf: ChannelPerf[] = [
      { channel: 'META', currentBudget: 100, spend: 100, revenue: 50, conversions: 5 }, // ROAS 0.5
      { channel: 'GOOGLE', currentBudget: 100, spend: 100, revenue: 60, conversions: 6 }, // ROAS 0.6
    ];
    // A target far above any plausible sample means no arm earns pool share.
    const plan = allocateBandit(perf, { totalBudget: 400, explorationPct: 0, targetRoas: 1000 }, mulberry32(7));
    expect(plan.allocations.every((a) => a.reason === 'bandit-hold')).toBe(true);
    expect(plan.allocations.every((a) => a.after === a.before)).toBe(true);
    expect(plan.noop).toBe(true);
  });
});
