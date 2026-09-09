import { sampleBeta, selectType, TypeArm } from './type-selector.util';

/** Tiny seedable PRNG so every draw below is exactly reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const arm = (key: string, over: Partial<TypeArm> = {}): TypeArm => ({
  typeId: `id-${key}`, key, minShare: 0.05, maxShare: 0.4, alpha: 1, beta: 1, samples: 0, active: true, ...over,
});
const ARMS = [arm('hook-story'), arm('how-to'), arm('pov-ugc'), arm('product-demo', { active: false })];
const learn = (over: Partial<Parameters<typeof selectType>[0]> = {}) => ({
  arms: ARMS, phase: 'LEARN' as const, explorationRate: 0, windowCounts: {}, windowSize: 10, previousKey: null, rng: mulberry32(1), ...over,
});

describe('type-selector — SEED', () => {
  it('round-robins over the ACTIVE arms by the seed cursor and never repeats the previous slot', () => {
    const at = (cursor: number, previousKey: string | null = null) =>
      selectType(learn({ phase: 'SEED', seedCursor: cursor, previousKey }));
    expect(at(0)).toEqual({ key: 'hook-story', typeId: 'id-hook-story', mode: 'seed', reason: expect.stringContaining('seed round-robin') });
    expect(at(1).key).toBe('how-to');
    expect(at(2).key).toBe('pov-ugc');
    expect(at(3).key).toBe('hook-story'); // wraps over 3 active arms, skipping the inactive one
    expect(at(1, 'how-to').key).toBe('pov-ugc');
    expect(at(2, 'pov-ugc').key).toBe('hook-story');
    expect(at(0).reason).toMatch(/hook-story/);
  });

  it('a single active arm is allowed to repeat itself', () => {
    const one = [arm('only'), arm('off', { active: false })];
    expect(selectType(learn({ arms: one, phase: 'SEED', seedCursor: 4, previousKey: 'only' })).key).toBe('only');
    expect(selectType(learn({ arms: one, previousKey: 'only', windowCounts: { only: 10 } })).key).toBe('only');
  });

  it('refuses to pick with no active arm at all', () => {
    expect(() => selectType(learn({ arms: [arm('x', { active: false })] }))).toThrow(/no active content type/i);
  });
});

describe('type-selector — floors', () => {
  it('fills an arm under its minShare before anything else, lowest share first, and names the numbers', () => {
    const arms = [arm('a', { alpha: 50, beta: 1 }), arm('b', { minShare: 0.2 }), arm('c', { minShare: 0.3 })];
    const r = selectType(learn({ arms, windowCounts: { a: 8, b: 1, c: 1 }, windowSize: 10 }));
    // b is at 0.10 of 0.20 (half its floor); c is at 0.10 of 0.30 — c is further from its floor.
    expect(r.mode).toBe('floor');
    expect(r.key).toBe('c');
    expect(r.reason).toMatch(/floor: c 0\.10 < min 0\.30 \(1 of 3 slots in 10\)/);
    // Once c is at its floor, b is the one still under.
    expect(selectType(learn({ arms, windowCounts: { a: 6, b: 1, c: 3 }, windowSize: 10 })).key).toBe('b');
  });

  it('does not repeat the previous slot even to fill a floor, and skips floors that are satisfied', () => {
    const arms = [arm('a', { alpha: 50, beta: 1 }), arm('b', { minShare: 0.2 }), arm('c', { minShare: 0.2 })];
    const r = selectType(learn({ arms, windowCounts: { a: 8, b: 1, c: 1 }, windowSize: 10, previousKey: 'b' }));
    expect(r.key).toBe('c');
    const full = selectType(learn({ arms, windowCounts: { a: 3, b: 2, c: 2 }, windowSize: 10 }));
    expect(full.mode).not.toBe('floor');
    expect(full.key).toBe('a');
  });

  it('an empty window (windowSize 0) forces no floor and applies no cap: the bandit simply samples', () => {
    const r = selectType(learn({ windowCounts: {}, windowSize: 0 }));
    expect(r.mode).toBe('thompson');
    const capped = selectType(learn({ windowCounts: { 'hook-story': 50, 'how-to': 50, 'pov-ugc': 50 }, windowSize: 0 }));
    expect(capped.mode).toBe('thompson');
  });

  it('counts floors in slots — floor(windowSize × minShare) — so the seed floors force nothing in a 10-slot window', () => {
    // Ten seed types at 0.05: needed = floor(10 × 0.05) = 0. Compared as a
    // fraction every type would be "under" 0.05 with an empty window and all
    // ten slots would be floor picks; counted in slots the bandit runs.
    const ten = Array.from({ length: 10 }, (_, i) => arm(`t${i}`, { minShare: 0.05, maxShare: 0.4, alpha: i === 0 ? 40 : 5, beta: i === 0 ? 5 : 40, samples: 45 }));
    const modes: Record<string, number> = {};
    const picks: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const r = selectType(learn({ arms: ten, windowCounts: {}, windowSize: 10, rng: mulberry32(seed) }));
      modes[r.mode] = (modes[r.mode] ?? 0) + 1;
      picks[r.key] = (picks[r.key] ?? 0) + 1;
    }
    expect(modes.floor).toBeUndefined();
    expect(modes.thompson).toBe(200);
    expect(picks.t0).toBeGreaterThan(150);
    // Any count satisfies a floor of 0 slots.
    expect(selectType(learn({ arms: ten, windowCounts: { t3: 1 }, windowSize: 10 })).mode).toBe('thompson');
  });

  it('in a 40-slot window every seed type is forced up to floor(40 × 0.05) = 2 slots, then released', () => {
    const ten = Array.from({ length: 10 }, (_, i) => arm(`t${i}`, { minShare: 0.05, maxShare: 0.4, alpha: i === 0 ? 40 : 5, beta: i === 0 ? 5 : 40, samples: 45 }));
    const full: Record<string, number> = Object.fromEntries(ten.map((a) => [a.key, 2]));
    // t7 holds one of its two promised slots: it is the only starved type.
    const r = selectType(learn({ arms: ten, windowCounts: { ...full, t7: 1 }, windowSize: 40 }));
    expect(r).toEqual(expect.objectContaining({ key: 't7', mode: 'floor' }));
    expect(r.reason).toMatch(/floor: t7 0\.03 < min 0\.05 \(1 of 2 slots in 40\)/);
    // Two slots each: every floor is met and the posterior decides.
    for (let seed = 1; seed <= 50; seed++) {
      expect(selectType(learn({ arms: ten, windowCounts: full, windowSize: 40, rng: mulberry32(seed) })).mode).toBe('thompson');
    }
    // Filling an empty 40-slot window from scratch: the first twenty picks
    // are all floors (two per type), and no type is asked for a third.
    const counts: Record<string, number> = {};
    let prev: string | null = null;
    for (let i = 0; i < 20; i++) {
      const pick = selectType(learn({ arms: ten, windowCounts: counts, windowSize: 40, previousKey: prev, rng: mulberry32(i + 1) }));
      expect(pick.mode).toBe('floor');
      counts[pick.key] = (counts[pick.key] ?? 0) + 1;
      prev = pick.key;
    }
    expect(Object.values(counts)).toEqual(Array(10).fill(2));
    expect(selectType(learn({ arms: ten, windowCounts: counts, windowSize: 40, previousKey: prev })).mode).toBe('thompson');
  });

  it('the type missing the most promised slots is filled first, and the floor line names the slot count', () => {
    // b needs floor(20 × 0.2) = 4, has 2 (missing 2); c needs floor(20 × 0.3) = 6, has 5 (missing 1).
    const arms = [arm('a', { alpha: 50, beta: 1 }), arm('b', { minShare: 0.2 }), arm('c', { minShare: 0.3 })];
    const r = selectType(learn({ arms, windowCounts: { a: 12, b: 2, c: 5 }, windowSize: 20 }));
    expect(r.key).toBe('b');
    expect(r.reason).toBe('floor: b 0.10 < min 0.20 (2 of 4 slots in 20)');
  });
});

describe('type-selector — exploration', () => {
  const satisfied = { 'hook-story': 3, 'how-to': 3, 'pov-ugc': 3 };
  it('with probability explorationRate picks uniformly among the least-sampled arms', () => {
    const arms = [arm('hook-story', { samples: 9 }), arm('how-to', { samples: 2 }), arm('pov-ugc', { samples: 2 })];
    const picks: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const r = selectType(learn({ arms, explorationRate: 1, windowCounts: satisfied, rng: mulberry32(seed) }));
      expect(r.mode).toBe('explore');
      expect(r.reason).toMatch(/explore: (how-to|pov-ugc) \(n=2, fewest of 3\)/);
      picks[r.key] = (picks[r.key] ?? 0) + 1;
    }
    expect(picks['hook-story']).toBeUndefined();
    expect(picks['how-to']).toBeGreaterThan(60);
    expect(picks['pov-ugc']).toBeGreaterThan(60);
  });

  it('explores at roughly the configured rate and never when the rate is 0', () => {
    let explored = 0;
    for (let seed = 1; seed <= 400; seed++) {
      if (selectType(learn({ explorationRate: 0.25, windowCounts: satisfied, rng: mulberry32(seed) })).mode === 'explore') explored++;
    }
    expect(explored).toBeGreaterThan(60);
    expect(explored).toBeLessThan(140);
    for (let seed = 1; seed <= 50; seed++) {
      expect(selectType(learn({ explorationRate: 0, windowCounts: satisfied, rng: mulberry32(seed) })).mode).toBe('thompson');
    }
  });

  it('exploration also respects the previous slot and the window cap', () => {
    const arms = [arm('a', { samples: 0 }), arm('b', { samples: 0 }), arm('c', { samples: 9 })];
    for (let seed = 1; seed <= 40; seed++) {
      const r = selectType(learn({ arms, explorationRate: 1, windowCounts: { a: 4, b: 3, c: 3 }, windowSize: 10, previousKey: 'b', rng: mulberry32(seed) }));
      // a sits at the 0.4 cap, b was last: only c is left even though it has the most samples.
      expect(r.key).toBe('c');
    }
  });
});

describe('type-selector — Thompson sampling', () => {
  const satisfied = { 'hook-story': 3, 'how-to': 3, 'pov-ugc': 3 };

  it('is exactly reproducible under a seeded rng', () => {
    const a = selectType(learn({ windowCounts: satisfied, rng: mulberry32(7) }));
    const b = selectType(learn({ windowCounts: satisfied, rng: mulberry32(7) }));
    expect(a).toEqual(b);
    expect(a.mode).toBe('thompson');
  });

  it('prefers the arm with the better posterior most of the time, but not always', () => {
    const arms = [arm('hook-story', { alpha: 30, beta: 10, samples: 40 }), arm('how-to', { alpha: 10, beta: 30, samples: 40 }), arm('pov-ugc', { alpha: 24, beta: 16, samples: 40 })];
    const picks: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const r = selectType(learn({ arms, windowCounts: satisfied, rng: mulberry32(seed) }));
      picks[r.key] = (picks[r.key] ?? 0) + 1;
    }
    expect(picks['hook-story']).toBeGreaterThan(200);
    expect(picks['how-to'] ?? 0).toBeLessThan(20);
    expect((picks['pov-ugc'] ?? 0) + (picks['how-to'] ?? 0)).toBeGreaterThan(0);
  });

  it('names the winner, the runner-up and the sample count in the reason', () => {
    const arms = [arm('hook-story', { alpha: 30, beta: 10, samples: 7 }), arm('how-to', { alpha: 10, beta: 30, samples: 5 })];
    const r = selectType(learn({ arms, windowCounts: { 'hook-story': 3, 'how-to': 3 }, rng: mulberry32(3) }));
    expect(r.reason).toMatch(/^thompson: (hook-story|how-to) \d\.\d\d > (hook-story|how-to) \d\.\d\d \(n=[57]\)$/);
    const [, winner, second] = r.reason.match(/thompson: (\S+) \S+ > (\S+)/)!;
    expect(winner).toBe(r.key);
    expect(second).not.toBe(r.key);
  });

  it('skips arms at or over their window cap and the previous slot, unless nothing else is left', () => {
    const arms = [arm('a', { alpha: 90, beta: 1, samples: 9 }), arm('b', { alpha: 1, beta: 90, samples: 9 }), arm('c', { alpha: 1, beta: 90, samples: 9 })];
    for (let seed = 1; seed <= 30; seed++) {
      // a is the obvious winner but sits exactly at its cap (ceil(10 × 0.4) = 4 slots); c was the previous slot.
      const r = selectType(learn({ arms, windowCounts: { a: 4, b: 3, c: 3 }, windowSize: 10, previousKey: 'c', rng: mulberry32(seed) }));
      expect(r.key).toBe('b');
      expect(r.mode).toBe('thompson');
    }
    // Everyone capped except the previous slot: the previous slot is the only candidate and may repeat.
    const only = selectType(learn({ arms, windowCounts: { a: 4, b: 4, c: 2 }, windowSize: 10, previousKey: 'c' }));
    expect(only.key).toBe('c');
    // Everyone capped, previous included: fall back to the arms that are not the previous slot.
    const capped = selectType(learn({ arms, windowCounts: { a: 4, b: 4, c: 4 }, windowSize: 10, previousKey: 'c' }));
    expect(['a', 'b']).toContain(capped.key);
  });

  it('EXPLOIT samples the same way as LEARN (exploration is kept, never zeroed)', () => {
    let explored = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = selectType(learn({ phase: 'EXPLOIT', explorationRate: 0.3, windowCounts: satisfied, rng: mulberry32(seed) }));
      if (r.mode === 'explore') explored++;
      else expect(r.mode).toBe('thompson');
    }
    expect(explored).toBeGreaterThan(30);
  });
});

describe('type-selector — sampleBeta', () => {
  it('draws in (0, 1) with the right mean, and Beta(1, 1) is close to uniform', () => {
    const rng = mulberry32(99);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = sampleBeta(8, 2, rng);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / n).toBeCloseTo(0.8, 1);
    let u = 0;
    for (let i = 0; i < n; i++) u += sampleBeta(1, 1, rng);
    expect(u / n).toBeCloseTo(0.5, 1);
  });

  it('handles shape parameters under 1 without NaN', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const x = sampleBeta(0.3, 0.7, rng);
      expect(Number.isFinite(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});
