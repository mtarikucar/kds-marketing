/**
 * Beta posteriors for the content programme's type bandit.
 *
 * Every content type carries one Beta(alpha, beta) per network (and one for
 * the "ALL" blend). A measured slot's reward r ∈ [0, 1] is a soft Bernoulli
 * observation: alpha += r, beta += 1 − r. The posterior mean is the type's
 * learned "hit rate" against the account's own baseline (0.5 = at baseline).
 *
 * Pure functions, no I/O: the learning service feeds them and writes the
 * result; the tests pin every rule with exact numbers.
 */

export interface Posterior {
  alpha: number;
  beta: number;
}

export type Phase = 'SEED' | 'LEARN' | 'EXPLOIT';

/** z for a one-sided 80% credible bound (Φ⁻¹(0.9)). */
const Z_80 = 1.28;
/** Measured slots each ACTIVE type needs before SEED may end early. */
const SEED_MIN_MEASURED = 3;
/** Measured slots the leader needs before its lead may end LEARN — a
 *  two-sample fluke has a wide sd of its own that the entry test ignores. */
export const EXPLOIT_MIN_SAMPLES = 5;
/** Slack on the share sums so 0.1 × 10 = 1.0000000000000002 stays feasible. */
const SHARE_EPS = 1e-9;
/** Bound on the re-clip loop in weightsFrom — each round pins ≥ 1 arm, so a
 *  programme with fewer arms than this converges before the cap is hit. */
const MAX_CLIP_ROUNDS = 10;

/** Fold one reward in. The reward is clipped so a bad metric can never push
 *  a posterior parameter below its previous value; a non-finite reward is a
 *  broken measurement and teaches nothing. */
export function updatePosterior(p: Posterior, reward: number): Posterior {
  if (!Number.isFinite(reward)) return { alpha: p.alpha, beta: p.beta };
  const r = Math.min(1, Math.max(0, reward));
  return { alpha: p.alpha + r, beta: p.beta + (1 - r) };
}

/**
 * Exponential forgetting toward the Beta(1, 1) prior: the evidence above the
 * prior halves every `halfLifeDays`, on BOTH parameters, so an old winner has
 * to keep winning. A half-life ≤ 0 disables decay.
 */
export function decayPosterior(p: Posterior, elapsedDays: number, halfLifeDays: number): Posterior {
  if (!(halfLifeDays > 0) || !(elapsedDays > 0)) return { alpha: p.alpha, beta: p.beta };
  const keep = Math.pow(0.5, elapsedDays / halfLifeDays);
  return { alpha: 1 + (p.alpha - 1) * keep, beta: 1 + (p.beta - 1) * keep };
}

export function posteriorMean(p: Posterior): number {
  const n = p.alpha + p.beta;
  return n > 0 ? p.alpha / n : 0.5;
}

/** Standard deviation of Beta(alpha, beta). */
export function posteriorSd(p: Posterior): number {
  const n = p.alpha + p.beta;
  if (n <= 0) return 0;
  return Math.sqrt((p.alpha * p.beta) / (n * n * (n + 1)));
}

export interface WeightsResult {
  weights: Record<string, number>;
  /** False when the active bounds cannot all hold at once (Σ minShare > 1 or
   *  Σ maxShare < 1); the weights are then the plain normalised means. */
  feasible: boolean;
}

/** Whether every active type's floor and cap can hold at once. */
export function sharesFeasible(arms: Array<{ minShare: number; maxShare: number; active: boolean }>): {
  feasible: boolean; minSum: number; maxSum: number;
} {
  const active = arms.filter((a) => a.active);
  const minSum = active.reduce((s, a) => s + a.minShare, 0);
  const maxSum = active.reduce((s, a) => s + a.maxShare, 0);
  return { feasible: active.length === 0 || (minSum <= 1 + SHARE_EPS && maxSum >= 1 - SHARE_EPS), minSum, maxSum };
}

/**
 * Calendar share per active type: posterior means normalised to 1, then
 * held inside each type's [minShare, maxShare]. Clipping and normalising
 * fight each other (pin one arm at its cap and the mass it gives up can push
 * the next arm over ITS cap), so the loop pins the violators of each round
 * at their bound and re-shares the remaining mass among the free arms until
 * a round violates nothing. Inactive arms get no key at all.
 *
 * WHY the feasibility check first: when the floors sum past 1 or the caps
 * cannot reach 1 no assignment satisfies the bounds, and pinning every arm
 * would return weights summing to 0.8 or 1.4 — charted as "calendar share"
 * they would be a lie. The bounds are ignored instead (plain normalised
 * means) and `feasible: false` tells the caller to say so.
 */
export function weightsFrom(
  arms: Array<{ key: string; alpha: number; beta: number; minShare: number; maxShare: number; active: boolean }>,
): WeightsResult {
  const active = arms.filter((a) => a.active);
  const out: Record<string, number> = {};
  if (active.length === 0) return { weights: out, feasible: true };

  const { feasible } = sharesFeasible(active);
  if (!feasible) {
    const sum = active.reduce((s, a) => s + posteriorMean(a), 0);
    for (const a of active) out[a.key] = sum > 0 ? posteriorMean(a) / sum : 1 / active.length;
    return { weights: out, feasible: false };
  }

  const pinned = new Map<string, number>();
  let free = active.slice();
  for (let round = 0; round < MAX_CLIP_ROUNDS && free.length > 0; round++) {
    let remaining = 1;
    for (const v of pinned.values()) remaining -= v;
    remaining = Math.max(0, remaining);
    const freeSum = free.reduce((s, a) => s + posteriorMean(a), 0);
    const violators: typeof free = [];
    for (const a of free) {
      const w = freeSum > 0 ? (remaining * posteriorMean(a)) / freeSum : remaining / free.length;
      out[a.key] = w;
      if (w < a.minShare - 1e-12 || w > a.maxShare + 1e-12) violators.push(a);
    }
    if (violators.length === 0) break;
    for (const v of violators) {
      const w = Math.min(v.maxShare, Math.max(v.minShare, out[v.key]));
      pinned.set(v.key, w);
      out[v.key] = w;
    }
    free = free.filter((a) => !pinned.has(a.key));
  }
  return { weights: out, feasible: true };
}

/**
 * Phase machine. SEED ends when the seed weeks elapse or every active type
 * has enough measured slots. LEARN becomes EXPLOIT when the leader's mean
 * clears the runner-up's 80% upper credible bound AND the leader has at
 * least EXPLOIT_MIN_SAMPLES measurements. EXPLOIT drops back to LEARN only
 * when the incumbent leader is actually overtaken (its mean falls under
 * another arm's mean). Nothing ever returns to SEED: the seed round-robin
 * exists only to gather first evidence.
 *
 * WHY the asymmetry: a symmetric test (leave when the leader's own lower
 * bound falls under the runner-up) flapped every reweight whenever the
 * leader had fewer samples than the runner-up — both conditions held at
 * once, and each flip logged a PHASE event. Entry is strict, exit is "the
 * lead is gone": that is the hysteresis.
 *
 * `leaderKey` is the arm that led at the previous reweight (the learning
 * service reads it from the previous stat rows); without it the current
 * top arm is taken as the incumbent, which can never have lost.
 */
export function nextPhase(
  current: Phase,
  ctx: {
    seedWeeksElapsed: boolean;
    measuredPerType: Record<string, number>;
    arms: Array<{ key: string; alpha: number; beta: number; active: boolean }>;
    leaderKey?: string | null;
  },
): Phase {
  const active = ctx.arms.filter((a) => a.active);
  if (current === 'SEED') {
    const seeded = active.length > 0 && active.every((a) => (ctx.measuredPerType[a.key] ?? 0) >= SEED_MIN_MEASURED);
    return ctx.seedWeeksElapsed || seeded ? 'LEARN' : 'SEED';
  }
  const ranked = active
    .map((a) => ({ key: a.key, mean: posteriorMean(a), sd: posteriorSd(a), samples: a.alpha + a.beta - 2 }))
    .sort((x, y) => y.mean - x.mean);
  if (ranked.length < 2) return 'LEARN';
  const [best, second] = ranked;
  if (current === 'LEARN') {
    const credible = best.mean > second.mean + Z_80 * second.sd;
    return credible && best.samples >= EXPLOIT_MIN_SAMPLES ? 'EXPLOIT' : 'LEARN';
  }
  const incumbent = (ctx.leaderKey && ranked.find((r) => r.key === ctx.leaderKey)) || best;
  const challenger = ranked.find((r) => r.key !== incumbent.key) ?? second;
  return incumbent.mean < challenger.mean ? 'LEARN' : 'EXPLOIT';
}
