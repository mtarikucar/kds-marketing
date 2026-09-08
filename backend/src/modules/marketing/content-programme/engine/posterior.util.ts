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

/**
 * Calendar share per active type: posterior means normalised to 1, then
 * held inside each type's [minShare, maxShare]. Clipping and normalising
 * fight each other (pin one arm at its cap and the mass it gives up can push
 * the next arm over ITS cap), so the loop pins the violators of each round
 * at their bound and re-shares the remaining mass among the free arms until
 * a round violates nothing. Inactive arms get no key at all.
 */
export function weightsFrom(
  arms: Array<{ key: string; alpha: number; beta: number; minShare: number; maxShare: number; active: boolean }>,
): Record<string, number> {
  const active = arms.filter((a) => a.active);
  const out: Record<string, number> = {};
  if (active.length === 0) return out;

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
  return out;
}

/**
 * Phase machine. SEED ends when the seed weeks elapse or every active type
 * has enough measured slots; LEARN becomes EXPLOIT when the leader's mean
 * clears the runner-up's 80% upper credible bound; EXPLOIT drops back to
 * LEARN when the leader's 80% LOWER bound falls under the runner-up's mean
 * (its advantage stopped being credible — decay or a bad run). Nothing ever
 * returns to SEED: the seed round-robin exists only to gather first evidence.
 */
export function nextPhase(
  current: Phase,
  ctx: {
    seedWeeksElapsed: boolean;
    measuredPerType: Record<string, number>;
    arms: Array<{ key: string; alpha: number; beta: number; active: boolean }>;
  },
): Phase {
  const active = ctx.arms.filter((a) => a.active);
  if (current === 'SEED') {
    const seeded = active.length > 0 && active.every((a) => (ctx.measuredPerType[a.key] ?? 0) >= SEED_MIN_MEASURED);
    return ctx.seedWeeksElapsed || seeded ? 'LEARN' : 'SEED';
  }
  const ranked = active
    .map((a) => ({ mean: posteriorMean(a), sd: posteriorSd(a) }))
    .sort((x, y) => y.mean - x.mean);
  if (ranked.length < 2) return 'LEARN';
  const [best, second] = ranked;
  if (current === 'LEARN') {
    return best.mean > second.mean + Z_80 * second.sd ? 'EXPLOIT' : 'LEARN';
  }
  return best.mean - Z_80 * best.sd < second.mean ? 'LEARN' : 'EXPLOIT';
}
