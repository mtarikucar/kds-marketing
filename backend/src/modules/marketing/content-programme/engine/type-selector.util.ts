/**
 * Which content type the next calendar slot gets.
 *
 * A bandit over the programme's active types. SEED walks them round-robin so
 * every type gets first evidence; LEARN/EXPLOIT sample Thompson-style from
 * each type's Beta posterior, with three guard rails the owner can audit in
 * the returned `reason`: an under-floor type is filled first, a type at its
 * window cap is skipped, and the previous slot's type is not repeated
 * (unless it is the only choice). The rng is injected so a test can replay
 * the exact draw.
 *
 * Floors and caps are counted in SLOTS, not compared as fractions:
 *
 *   needed(type) = floor(windowSize × minShare)   under the floor while count < needed
 *   cap(type)    = ceil(windowSize × maxShare)    at the cap once count ≥ cap
 *
 * WHY: compared as `share < minShare`, ten types at a 0.05 floor each need
 * one slot in ANY window of ten or fewer, so every pick is a floor pick and
 * the posteriors never touch the calendar. Flooring the slot count means a
 * window too small to hold 1/minShare slots forces nothing, and a window
 * of 2/minShare promises each type two slots — the bandit gets the rest.
 *
 * The caller passes a TRAILING window: the 30 most recent slots by
 * scheduledFor, upcoming ones included (the planner / learning service own
 * that query). With the seed floors (0.05) that window forces one slot per
 * type; a window under 20 slots forces none, and the owner's floors only
 * bite once the calendar is long enough to honour them.
 */

export interface TypeArm {
  typeId: string;
  key: string;
  minShare: number;
  maxShare: number;
  alpha: number;
  beta: number;
  samples: number;
  active: boolean;
}

export type SelectionMode = 'seed' | 'floor' | 'explore' | 'thompson';

export interface SelectTypeInput {
  arms: TypeArm[];
  phase: 'SEED' | 'LEARN' | 'EXPLOIT';
  explorationRate: number;
  /** Slots per type already in the trailing window (by key). */
  windowCounts: Record<string, number>;
  /** Slots in the trailing window (see the header: 30 most recent, upcoming
   *  included). Below 1/minShare no floor can force a pick; ≤ 0 disables
   *  floors and caps altogether. */
  windowSize: number;
  previousKey?: string | null;
  seedCursor?: number;
  rng: () => number;
}

export interface SelectTypeResult {
  key: string;
  typeId: string;
  mode: SelectionMode;
  reason: string;
}

const fmt = (x: number): string => x.toFixed(2);

/** Box–Muller standard normal on the injected uniform rng. */
function standardNormal(rng: () => number): number {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12; // guard log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape k, scale 1) by Marsaglia–Tsang rejection; k < 1 through the
 * usual boost. The loop is bounded only to stay total under a pathological
 * rng — for k ≥ 1 acceptance is ~98% per round.
 */
function sampleGamma(k: number, rng: () => number): number {
  if (k <= 0) return 0;
  if (k < 1) {
    const u = rng();
    return sampleGamma(1 + k, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // ≈ mean; only reachable with a broken rng
}

/** Beta(a, b) as X / (X + Y) of two Gammas, clipped away from the exact ends. */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(Math.max(alpha, 1e-9), rng);
  const y = sampleGamma(Math.max(beta, 1e-9), rng);
  const s = x + y;
  if (!(s > 0)) return 0.5;
  return Math.min(1 - 1e-12, Math.max(1e-12, x / s));
}

const pick = (arm: TypeArm, mode: SelectionMode, reason: string): SelectTypeResult =>
  ({ key: arm.key, typeId: arm.typeId, mode, reason });

export function selectType(input: SelectTypeInput): SelectTypeResult {
  const active = input.arms.filter((a) => a.active);
  if (active.length === 0) throw new Error('No active content type to select from');
  const previousKey = input.previousKey ?? null;
  const windowSize = input.windowSize > 0 ? input.windowSize : 0;
  const count = (a: TypeArm): number => input.windowCounts[a.key] ?? 0;
  const share = (a: TypeArm): number => (windowSize > 0 ? count(a) / windowSize : 0);
  /** Slots the floor promises this type in the window; 0 when the window is too short to hold one. */
  const needed = (a: TypeArm): number => Math.floor(windowSize * a.minShare + 1e-9);
  /** Slots the cap allows; ceil so a cap is only hit once the type would exceed it. */
  const cap = (a: TypeArm): number => Math.ceil(windowSize * a.maxShare - 1e-9);
  /** Drop the previous slot's type, but never down to nothing. */
  const notPrevious = (arms: TypeArm[]): TypeArm[] => {
    const rest = arms.filter((a) => a.key !== previousKey);
    return rest.length > 0 ? rest : arms;
  };

  if (input.phase === 'SEED') {
    const n = active.length;
    const cursor = Math.max(0, Math.floor(input.seedCursor ?? 0));
    let idx = cursor % n;
    if (n > 1 && active[idx].key === previousKey) idx = (idx + 1) % n;
    return pick(active[idx], 'seed', `seed round-robin: ${active[idx].key} (cursor ${cursor} of ${n})`);
  }

  // 1. Floors: a type the window has starved gets the slot regardless of its
  //    posterior — the owner's minShare is a promise, not a hint. The one
  //    missing the most slots goes first (ties: the one furthest below its
  //    share). A window too short for a single floor slot starves nobody.
  const deficit = (a: TypeArm): number => needed(a) - count(a);
  const starved = notPrevious(active).filter((a) => deficit(a) > 0);
  if (starved.length > 0) {
    const worst = starved.reduce((w, a) => {
      const d = deficit(a) - deficit(w);
      return d > 0 || (d === 0 && a.minShare - share(a) > w.minShare - share(w)) ? a : w;
    });
    return pick(worst, 'floor',
      `floor: ${worst.key} ${fmt(share(worst))} < min ${fmt(worst.minShare)} (${count(worst)} of ${needed(worst)} slots in ${windowSize})`);
  }

  // Candidates for both sampling modes: under the cap and not the previous
  // slot. If the cap excludes everyone, ignore the cap rather than stall.
  const underCap = windowSize > 0 ? active.filter((a) => count(a) < cap(a)) : active;
  const candidates = notPrevious(underCap.length > 0 ? underCap : active);

  // 2. Exploration: with probability explorationRate, the least-sampled types
  //    get a look — kept in EXPLOIT too, so a type never freezes at its prior.
  const coin = input.rng();
  if (coin < input.explorationRate) {
    const fewest = Math.min(...candidates.map((a) => a.samples));
    const pool = candidates.filter((a) => a.samples === fewest);
    const chosen = pool[Math.min(pool.length - 1, Math.floor(input.rng() * pool.length))];
    return pick(chosen, 'explore', `explore: ${chosen.key} (n=${fewest}, fewest of ${candidates.length})`);
  }

  // 3. Thompson: one draw per candidate from its Beta, highest wins.
  const draws = candidates.map((a) => ({ arm: a, draw: sampleBeta(a.alpha, a.beta, input.rng) }));
  draws.sort((x, y) => y.draw - x.draw);
  const [best, second] = draws;
  const reason = second
    ? `thompson: ${best.arm.key} ${fmt(best.draw)} > ${second.arm.key} ${fmt(second.draw)} (n=${best.arm.samples})`
    : `thompson: ${best.arm.key} ${fmt(best.draw)} (n=${best.arm.samples}, sole candidate)`;
  return pick(best.arm, 'thompson', reason);
}
