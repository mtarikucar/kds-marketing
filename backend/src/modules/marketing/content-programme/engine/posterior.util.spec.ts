import {
  decayPosterior, nextPhase, posteriorMean, updatePosterior, weightsFrom,
} from './posterior.util';

const arm = (key: string, alpha: number, beta: number, over: Partial<{ minShare: number; maxShare: number; active: boolean }> = {}) =>
  ({ key, alpha, beta, minShare: 0.05, maxShare: 0.4, active: true, ...over });

describe('posterior.util — Beta posterior arithmetic', () => {
  it('updatePosterior moves alpha by the reward and beta by its complement, clipping the reward to [0, 1]', () => {
    expect(updatePosterior({ alpha: 1, beta: 1 }, 0.75)).toEqual({ alpha: 1.75, beta: 1.25 });
    expect(updatePosterior({ alpha: 2, beta: 3 }, 0)).toEqual({ alpha: 2, beta: 4 });
    // Out-of-range rewards never leak into the posterior.
    expect(updatePosterior({ alpha: 1, beta: 1 }, 7)).toEqual({ alpha: 2, beta: 1 });
    expect(updatePosterior({ alpha: 1, beta: 1 }, -3)).toEqual({ alpha: 1, beta: 2 });
    // A non-finite reward is a broken measurement, not a zero: nothing is learned from it.
    expect(updatePosterior({ alpha: 1, beta: 1 }, Number.NaN)).toEqual({ alpha: 1, beta: 1 });
  });

  it('decayPosterior halves the evidence above the prior at one half-life and keeps the prior itself', () => {
    const p = { alpha: 9, beta: 5 }; // evidence: 8 on alpha, 4 on beta
    expect(decayPosterior(p, 30, 30)).toEqual({ alpha: 5, beta: 3 });
    expect(decayPosterior(p, 60, 30)).toEqual({ alpha: 3, beta: 2 });
    expect(decayPosterior(p, 0, 30)).toEqual(p);
    // A prior has no evidence to lose.
    expect(decayPosterior({ alpha: 1, beta: 1 }, 400, 30)).toEqual({ alpha: 1, beta: 1 });
    // A disabled half-life (≤ 0) or a negative elapse leaves the posterior alone.
    expect(decayPosterior(p, 30, 0)).toEqual(p);
    expect(decayPosterior(p, -5, 30)).toEqual(p);
  });

  it('posteriorMean is alpha / (alpha + beta)', () => {
    expect(posteriorMean({ alpha: 1, beta: 1 })).toBe(0.5);
    expect(posteriorMean({ alpha: 3, beta: 1 })).toBe(0.75);
    expect(posteriorMean({ alpha: 0, beta: 0 })).toBe(0.5);
  });
});

describe('posterior.util — weightsFrom', () => {
  it('normalises the means of the active arms to 1 and ignores inactive arms entirely', () => {
    const w = weightsFrom([arm('a', 3, 1, { maxShare: 1 }), arm('b', 1, 3, { maxShare: 1 }), arm('c', 9, 1, { active: false })]);
    expect(Object.keys(w).sort()).toEqual(['a', 'b']);
    expect(w.a + w.b).toBeCloseTo(1, 9);
    expect(w.a).toBeCloseTo(0.75, 9);
    expect(w.b).toBeCloseTo(0.25, 9);
  });

  it('keeps every weight inside [minShare, maxShare] after normalisation and still sums to 1', () => {
    // One runaway arm would take 0.9 unclipped; the cap pins it at 0.4 and the
    // rest is shared by the others, none of which may fall under the floor.
    const arms = [arm('a', 90, 1), arm('b', 2, 8), arm('c', 1, 9), arm('d', 1, 30, { minShare: 0.15 })];
    const w = weightsFrom(arms);
    expect(Object.values(w).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(w.a).toBeCloseTo(0.4, 9);
    expect(w.d).toBeCloseTo(0.15, 9);
    for (const a of arms) {
      expect(w[a.key]).toBeGreaterThanOrEqual(a.minShare - 1e-9);
      expect(w[a.key]).toBeLessThanOrEqual(a.maxShare + 1e-9);
    }
    // b and c share the remaining 0.45 in proportion to their means (0.2 vs 0.1).
    expect(w.b / w.c).toBeCloseTo(2, 6);
  });

  it('re-clips iteratively: pinning one arm may push a second over its cap, which is then pinned too', () => {
    // Round 1: a (0.99 / 1.53 = 0.647) breaks its 0.3 cap while b sits at 0.327,
    // under its 0.35 cap. Pinning a hands b 0.648 of the remaining 0.7 — now b
    // breaks too. A single clip-and-normalise pass would leave a at 0.46.
    const arms = [
      arm('a', 99, 1, { maxShare: 0.3, minShare: 0 }),
      arm('b', 1, 1, { maxShare: 0.35, minShare: 0 }),
      arm('c', 1, 49, { minShare: 0 }),
      arm('d', 1, 49, { minShare: 0 }),
    ];
    const w = weightsFrom(arms);
    expect(w.a).toBeCloseTo(0.3, 9);
    expect(w.b).toBeCloseTo(0.35, 9);
    expect(w.c).toBeCloseTo(0.175, 9);
    expect(w.d).toBeCloseTo(0.175, 9);
  });

  it('returns an empty map with no active arms and a single unbounded arm gets everything', () => {
    expect(weightsFrom([])).toEqual({});
    expect(weightsFrom([arm('x', 1, 1, { active: false })])).toEqual({});
    expect(weightsFrom([arm('only', 1, 1, { maxShare: 1 })])).toEqual({ only: 1 });
  });

  it('honours the caps over the sum when the caps themselves cannot reach 1 (every arm pinned at its max)', () => {
    // Two arms capped at 0.4 can fill at most 0.8 of the calendar. Inflating
    // them past their cap would be a silent lie about the owner's bounds.
    const w = weightsFrom([arm('a', 3, 1), arm('b', 1, 3)]);
    expect(w).toEqual({ a: 0.4, b: 0.4 });
  });
});

describe('posterior.util — nextPhase', () => {
  const two = [{ key: 'a', alpha: 1, beta: 1, active: true }, { key: 'b', alpha: 1, beta: 1, active: true }];

  it('SEED → LEARN once the seed weeks elapse, or once every ACTIVE arm has three measurements', () => {
    expect(nextPhase('SEED', { seedWeeksElapsed: false, measuredPerType: {}, arms: two })).toBe('SEED');
    expect(nextPhase('SEED', { seedWeeksElapsed: true, measuredPerType: {}, arms: two })).toBe('LEARN');
    expect(nextPhase('SEED', { seedWeeksElapsed: false, measuredPerType: { a: 3, b: 2 }, arms: two })).toBe('SEED');
    expect(nextPhase('SEED', { seedWeeksElapsed: false, measuredPerType: { a: 3, b: 3 }, arms: two })).toBe('LEARN');
    // An inactive arm does not hold the programme in SEED.
    const withInactive = [...two, { key: 'z', alpha: 1, beta: 1, active: false }];
    expect(nextPhase('SEED', { seedWeeksElapsed: false, measuredPerType: { a: 3, b: 3 }, arms: withInactive })).toBe('LEARN');
    // No arms at all is not "every arm satisfied".
    expect(nextPhase('SEED', { seedWeeksElapsed: false, measuredPerType: {}, arms: [] })).toBe('SEED');
  });

  it('LEARN → EXPLOIT only when the leader\'s mean clears the runner-up\'s 80% upper credible bound', () => {
    // b: Beta(10, 10) → mean 0.5, sd ≈ 0.109, upper80 ≈ 0.64.
    const b = { key: 'b', alpha: 10, beta: 10, active: true };
    const under = { key: 'a', alpha: 19, beta: 11, active: true }; // mean 0.633 < 0.64
    const over = { key: 'a', alpha: 20, beta: 10, active: true }; // mean 0.667 > 0.64
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [under, b] })).toBe('LEARN');
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [over, b] })).toBe('EXPLOIT');
    // The runner-up is the second-best ACTIVE arm, whatever the array order.
    const loud = { key: 'z', alpha: 90, beta: 1, active: false };
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [b, loud, over] })).toBe('EXPLOIT');
    // A lone arm has nothing to beat: it keeps learning.
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [over] })).toBe('LEARN');
  });

  it('never returns to SEED and EXPLOIT falls back to LEARN when the lead stops being credible', () => {
    const b = { key: 'b', alpha: 10, beta: 10, active: true };
    const clear = { key: 'a', alpha: 40, beta: 10, active: true }; // mean 0.8, lower80 ≈ 0.73 > 0.5
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [clear, b] })).toBe('EXPLOIT');
    // Leader decayed toward the runner-up: its lower bound is now under b's mean.
    const faded = { key: 'a', alpha: 6, beta: 5, active: true }; // mean 0.545, lower80 ≈ 0.36 < 0.5
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [faded, b] })).toBe('LEARN');
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: false, measuredPerType: {}, arms: [faded, b] })).not.toBe('SEED');
    expect(nextPhase('LEARN', { seedWeeksElapsed: false, measuredPerType: {}, arms: two })).toBe('LEARN');
  });
});
