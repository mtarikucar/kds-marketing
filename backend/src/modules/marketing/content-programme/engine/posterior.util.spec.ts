import {
  EXPLOIT_MIN_SAMPLES, decayPosterior, nextPhase, posteriorMean, sharesFeasible, updatePosterior, weightsFrom,
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
    const { weights: w, feasible } = weightsFrom([arm('a', 3, 1, { maxShare: 1 }), arm('b', 1, 3, { maxShare: 1 }), arm('c', 9, 1, { active: false })]);
    expect(feasible).toBe(true);
    expect(Object.keys(w).sort()).toEqual(['a', 'b']);
    expect(w.a + w.b).toBeCloseTo(1, 9);
    expect(w.a).toBeCloseTo(0.75, 9);
    expect(w.b).toBeCloseTo(0.25, 9);
  });

  it('keeps every weight inside [minShare, maxShare] after normalisation and still sums to 1', () => {
    // One runaway arm would take 0.9 unclipped; the cap pins it at 0.4 and the
    // rest is shared by the others, none of which may fall under the floor.
    const arms = [arm('a', 90, 1), arm('b', 2, 8), arm('c', 1, 9), arm('d', 1, 30, { minShare: 0.15 })];
    const { weights: w, feasible } = weightsFrom(arms);
    expect(feasible).toBe(true);
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
    const { weights: w } = weightsFrom(arms);
    expect(w.a).toBeCloseTo(0.3, 9);
    expect(w.b).toBeCloseTo(0.35, 9);
    expect(w.c).toBeCloseTo(0.175, 9);
    expect(w.d).toBeCloseTo(0.175, 9);
  });

  it('returns an empty map with no active arms and a single unbounded arm gets everything', () => {
    expect(weightsFrom([])).toEqual({ weights: {}, feasible: true });
    expect(weightsFrom([arm('x', 1, 1, { active: false })])).toEqual({ weights: {}, feasible: true });
    expect(weightsFrom([arm('only', 1, 1, { maxShare: 1 })])).toEqual({ weights: { only: 1 }, feasible: true });
  });

  it('ignores the bounds and flags the result when the caps cannot reach 1 or the floors exceed it', () => {
    // Two arms capped at 0.4 can fill at most 0.8 of the calendar: no
    // assignment satisfies the bounds, so pinning both at 0.4 would chart a
    // "share" summing to 0.8. The plain normalised means are returned instead.
    const capped = weightsFrom([arm('a', 3, 1), arm('b', 1, 3)]);
    expect(capped.feasible).toBe(false);
    expect(capped.weights.a).toBeCloseTo(0.75, 9);
    expect(capped.weights.b).toBeCloseTo(0.25, 9);
    // Two floors of 0.7 would need 1.4 of the calendar.
    const floored = weightsFrom([arm('a', 1, 1, { minShare: 0.7, maxShare: 1 }), arm('b', 1, 1, { minShare: 0.7, maxShare: 1 })]);
    expect(floored).toEqual({ weights: { a: 0.5, b: 0.5 }, feasible: false });
    // Inactive arms do not count toward either sum.
    const withRetired = weightsFrom([arm('a', 3, 1, { maxShare: 0.6 }), arm('b', 1, 3, { maxShare: 0.4 }), arm('z', 1, 1, { maxShare: 0.1, minShare: 0.9, active: false })]);
    expect(withRetired.feasible).toBe(true);
    expect(withRetired.weights.a + withRetired.weights.b).toBeCloseTo(1, 9);
    // The seed set (10 × 0.05 floors, 9 × 0.4 + 0.25 caps) is feasible, and
    // ten floors of 0.1 sum to exactly 1 without a rounding scare.
    expect(sharesFeasible(Array.from({ length: 10 }, () => ({ minShare: 0.1, maxShare: 0.4, active: true })))).toEqual({ feasible: true, minSum: expect.closeTo(1, 9), maxSum: expect.closeTo(4, 9) });
    expect(sharesFeasible([{ minShare: 0.6, maxShare: 1, active: true }, { minShare: 0.55, maxShare: 1, active: true }])).toEqual(expect.objectContaining({ feasible: false, minSum: expect.closeTo(1.15, 9) }));
    expect(sharesFeasible([])).toEqual({ feasible: true, minSum: 0, maxSum: 0 });
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

  it('a leader with fewer than five measurements cannot open EXPLOIT, however wide its lead', () => {
    // a: Beta(3.2, 1.8) → mean 0.64 on 3 samples; b: Beta(25, 25) → mean 0.5, sd 0.07, upper80 ≈ 0.59.
    const fluke = { key: 'a', alpha: 3.2, beta: 1.8, active: true };
    const b = { key: 'b', alpha: 25, beta: 25, active: true };
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [fluke, b] })).toBe('LEARN');
    // The same lead on five samples is enough.
    const seasoned = { key: 'a', alpha: 4.2, beta: 2.8, active: true }; // mean 0.6, 5 samples
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [seasoned, b] })).toBe('EXPLOIT');
    expect(EXPLOIT_MIN_SAMPLES).toBe(5);
  });

  it('EXPLOIT holds until the incumbent is overtaken, so a leader with fewer samples cannot flap', () => {
    const b = { key: 'b', alpha: 25, beta: 25, active: true };
    // Once in EXPLOIT, a young leader whose own lower bound dips under the
    // runner-up STAYS the leader: the old symmetric exit flipped this back to
    // LEARN on the very next reweight.
    const young = { key: 'a', alpha: 4.2, beta: 2.8, active: true }; // mean 0.6, lower80 ≈ 0.38 < 0.5
    expect(nextPhase('LEARN', { seedWeeksElapsed: true, measuredPerType: {}, arms: [young, b] })).toBe('EXPLOIT');
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [young, b], leaderKey: 'a' })).toBe('EXPLOIT');
    // Decay toward the prior narrows the lead but does not remove it.
    const decayed = { key: 'a', alpha: 2.6, beta: 1.9, active: true }; // mean 0.578
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [decayed, b], leaderKey: 'a' })).toBe('EXPLOIT');
    // Overtaken: the incumbent's mean fell under the challenger's.
    const lost = { key: 'a', alpha: 5, beta: 6, active: true }; // mean 0.4545 < 0.5
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [lost, b], leaderKey: 'a' })).toBe('LEARN');
    // A dead heat is not a loss.
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [{ key: 'a', alpha: 25, beta: 25, active: true }, b], leaderKey: 'a' })).toBe('EXPLOIT');
    // Without a remembered leader the current top arm is the incumbent.
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [lost, b] })).toBe('EXPLOIT');
    // A leader that was retired is no incumbent: the top active arm stands in.
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [lost, b], leaderKey: 'gone' })).toBe('EXPLOIT');
  });

  it('never returns to SEED', () => {
    const b = { key: 'b', alpha: 10, beta: 10, active: true };
    const faded = { key: 'a', alpha: 6, beta: 5, active: true };
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: false, measuredPerType: {}, arms: [faded, b], leaderKey: 'a' })).not.toBe('SEED');
    expect(nextPhase('LEARN', { seedWeeksElapsed: false, measuredPerType: {}, arms: two })).toBe('LEARN');
    // A lone arm in EXPLOIT (the others retired) goes back to LEARN: nothing to exploit against.
    expect(nextPhase('EXPLOIT', { seedWeeksElapsed: true, measuredPerType: {}, arms: [faded], leaderKey: 'a' })).toBe('LEARN');
  });
});
