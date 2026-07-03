/**
 * Stage-2 budget allocator (Budget Autopilot, Faz 7): Thompson-sampling bandit.
 *
 * Pure and dependency-free (no NestJS / Prisma / I/O) so the money-moving logic
 * is exhaustively unit-tested before it ever touches a real ad account. Like the
 * Stage-1 marginal allocator it is NOT a per-auction bidder — it distributes a
 * fixed budget POOL across channels — but instead of a deterministic marginal
 * proxy it treats each channel as a bandit ARM over ROAS and samples from a
 * posterior. This naturally balances exploit (back the proven winner) with
 * explore (occasionally bet on an uncertain / cold-start arm), which is the whole
 * point of a bandit once conversion volume starts to accrue.
 *
 * Posterior model (Gamma over the ROAS mean, Gamma–Poisson style):
 *   - Each channel's observed ROAS = revenue / spend.
 *   - Evidence n (pseudo-observations) comes from conversions when available,
 *     otherwise a fraction of spend. More evidence ⇒ higher Gamma shape ⇒ a
 *     TIGHTER posterior (coefficient of variation = 1/√shape).
 *   - Cold-start channels (spend 0, no evidence) fall back to an OPTIMISTIC prior
 *     mean with shape 1 (a wide posterior), so their sampled draws are frequently
 *     high and they win exploration budget.
 *   - We draw ONE sample per channel per run and allocate the pool proportional to
 *     the sampled ROAS, then apply the same hard guardrails as Stage-1.
 *
 * Guardrails (identical, non-negotiable):
 *   - hold back `explorationPct` (default 20) as a reserve; pool = total − reserve,
 *   - no channel moves more than `maxStepPct` (default 20) from its current budget,
 *   - per-channel min/max budgets are respected,
 *   - the sum of proposals NEVER exceeds the pool (scale down proportionally),
 *   - money is rounded to 2 decimals; noop when nothing moves by ≥ 0.01.
 *
 * The RNG is injectable so the bandit is deterministic under test: pass a seeded
 * `rng` (e.g. `mulberry32(seed)`) and the outputs are exactly reproducible.
 */

export interface ChannelPerf {
  channel: string;
  campaignRef?: string;
  /** Current period/daily budget assigned to this channel. */
  currentBudget: number;
  /** Spend in the measurement window. */
  spend: number;
  /** First-party revenue attributed in the window (NOT platform-reported). */
  revenue: number;
  /** Optional conversions/leads — the strongest evidence signal when present. */
  conversions?: number;
  minBudget?: number;
  maxBudget?: number;
}

export interface AllocatorParams {
  /** Total growth budget (hard cap). */
  totalBudget: number;
  /** 0-100 held back for learning/exploration. */
  explorationPct?: number;
  /** Max % change to any one channel in a single run (default 20). */
  maxStepPct?: number;
  /** ROAS floor — sampled value below this does not earn pool share. */
  targetRoas?: number;
}

export interface ChannelAllocation {
  channel: string;
  campaignRef: string;
  before: number;
  after: number;
  deltaPct: number;
  avgRoas: number;
  marginalRoas: number;
  reason: string;
}

export interface AllocationPlan {
  pool: number;
  reserve: number;
  totalBudget: number;
  allocations: ChannelAllocation[];
  /** True when no channel's proposed budget differs materially from current. */
  noop: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// --- Tuning constants (pure, no config surface — Stage-2 defaults) -----------
/** Prior weight in pseudo-observations (a wide, shape-1 posterior on cold start). */
const PRIOR_STRENGTH = 1;
/** Each unit of spend contributes this many pseudo-observations when conversions
 *  are absent, so a channel with real spend has a tighter posterior than a fresh
 *  one but conversions (when present) dominate as the higher-quality signal. */
const SPEND_EVIDENCE_WEIGHT = 0.1;
/** Cold-start optimism multiplier applied to the fleet mean ROAS. */
const OPTIMISM = 1.2;

/**
 * A tiny, pure, seedable PRNG (mulberry32). Deterministic given a seed, so the
 * bandit's sampling is exactly reproducible in tests. Returns a fn in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, drawing from the injected uniform rng. */
function standardNormal(rng: () => number): number {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12; // guard log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample from Gamma(shape k, scale θ) using Marsaglia–Tsang (rejection). Mean is
 * k·θ, variance k·θ², so coefficient of variation = 1/√k (more evidence ⇒ tighter).
 * Handles k < 1 via the standard boosting trick.
 */
function gammaSample(k: number, theta: number, rng: () => number): number {
  if (k < 1) {
    const u = rng();
    return gammaSample(1 + k, theta, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded loop: rejection is fast for k ≥ 1; the cap only guards a pathological
  // rng and keeps the function total.
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * theta;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * theta;
  }
  return d * theta; // fallback ≈ mean
}

/** avgRoas = revenue/spend (0 when there is no spend yet). */
function avgRoas(p: ChannelPerf): number {
  return p.spend > 0 ? p.revenue / p.spend : 0;
}

/** Pseudo-observation count: conversions dominate; else a fraction of spend. */
function evidence(p: ChannelPerf): number {
  if (p.conversions != null && p.conversions > 0) return p.conversions;
  return p.spend > 0 ? p.spend * SPEND_EVIDENCE_WEIGHT : 0;
}

/**
 * Stage-2 Thompson-sampling allocator. `rng` is injectable/seedable (defaults to
 * Math.random) so tests can pass a deterministic mulberry32 and assert exactly.
 */
export function allocateBandit(
  perf: ChannelPerf[],
  params: AllocatorParams,
  rng: () => number = Math.random,
): AllocationPlan {
  const totalBudget = Math.max(0, params.totalBudget);
  const explorationPct = clamp(params.explorationPct ?? 20, 0, 90);
  const maxStep = clamp(params.maxStepPct ?? 20, 0, 100) / 100;
  const targetRoas = Math.max(0, params.targetRoas ?? 0);
  const reserve = round2((totalBudget * explorationPct) / 100);
  const pool = round2(totalBudget - reserve);

  // Optimistic cold-start prior = fleet-average observed ROAS (× optimism), with
  // a floor so an all-cold fleet still explores upward.
  const observed = perf.map(avgRoas).filter((r) => r > 0);
  const fleetMean = observed.length ? observed.reduce((s, r) => s + r, 0) / observed.length : 1;
  const priorMean = Math.max(1, targetRoas, fleetMean) * OPTIMISM;

  const rows = perf.map((p) => {
    const aroas = avgRoas(p);
    const observedRoas = aroas; // ROAS mean under observation
    const n = evidence(p);
    const postN = PRIOR_STRENGTH + n;
    // Blend the optimistic prior with observation, weighted by evidence.
    const postMean = (priorMean * PRIOR_STRENGTH + observedRoas * n) / postN;
    const shape = postN; // more evidence ⇒ tighter posterior
    const scale = shape > 0 ? postMean / shape : 0;
    const sample = Math.max(0, gammaSample(shape, scale, rng));
    // Sampled ROAS is the bandit's "marginalRoas" for reporting.
    const score = Math.max(0, sample - targetRoas);
    return { p, aroas, sample, score };
  });

  const scoreSum = rows.reduce((s, r) => s + r.score, 0);

  const allocations: ChannelAllocation[] = rows.map((r) => {
    const { p } = r;
    const lo = p.minBudget ?? 0;
    const hi = p.maxBudget ?? Number.POSITIVE_INFINITY;
    let after: number;
    let reason: string;
    if (scoreSum <= 0) {
      // No arm drew above the ROAS floor: hold current budgets, clamped.
      after = clamp(p.currentBudget, lo, hi);
      reason = 'bandit-hold';
    } else {
      const target = pool * (r.score / scoreSum);
      // Limit the move to ±maxStep around the current budget (protect learning).
      const stepLo = p.currentBudget * (1 - maxStep);
      const stepHi = p.currentBudget === 0 ? target : p.currentBudget * (1 + maxStep);
      after = clamp(target, stepLo, stepHi);
      after = clamp(after, lo, hi);
      // Explore when there is little/no evidence (cold start) or the arm drew
      // above its own observed mean (a speculative optimistic draw); else exploit.
      const coldStart = p.spend <= 0;
      reason = coldStart || r.sample > r.aroas ? 'bandit-explore' : 'bandit-exploit';
    }
    return {
      channel: p.channel,
      campaignRef: p.campaignRef ?? '',
      before: round2(p.currentBudget),
      after: round2(after),
      deltaPct: p.currentBudget > 0 ? round2(((after - p.currentBudget) / p.currentBudget) * 100) : 0,
      avgRoas: round2(r.aroas),
      marginalRoas: round2(r.sample),
      reason,
    };
  });

  // Enforce the hard cap: if step/floor clamping pushed the sum over the pool,
  // scale the proposals down proportionally so we never exceed the budget.
  const sum = allocations.reduce((s, a) => s + a.after, 0);
  if (sum > pool && sum > 0) {
    const factor = pool / sum;
    for (const a of allocations) {
      a.after = round2(a.after * factor);
      a.deltaPct = a.before > 0 ? round2(((a.after - a.before) / a.before) * 100) : 0;
    }
  }

  const noop = allocations.every((a) => Math.abs(a.after - a.before) < 0.01);
  return { pool, reserve, totalBudget, allocations, noop };
}
