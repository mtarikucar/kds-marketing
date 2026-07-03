/**
 * Stage-3 budget allocator (Budget Autopilot, Faz 7): "MMM-lite" reallocation.
 *
 * Where the Stage-1 marginal-allocator proxies saturation by a channel's current
 * share of the pool, this stage actually FITS a per-channel diminishing-returns
 * response curve and water-fills the pool by equalising the fitted MARGINAL
 * return across funded channels. It is the classic Marketing-Mix-Modelling idea,
 * shrunk to a closed form that is cheap, deterministic and dependency-free so the
 * money-moving logic can be exhaustively unit-tested before it touches a real ad
 * account. It is NOT a per-auction bidder (Meta Advantage+ / Google Smart Bidding
 * own the auction) — it distributes a fixed pool ACROSS channels toward the point
 * where the next dollar buys the same marginal revenue everywhere, honouring the
 * same guardrails the design mandates and that Stage-1 enforces:
 *   - an exploration reserve is held back for learning,
 *   - no channel moves more than `maxStepPct` in one run (larger jumps reset the
 *     platform learning phase),
 *   - per-channel floors/ceilings are respected,
 *   - the sum of proposals never exceeds the pool (the growth budget is a hard cap),
 *   - only channels at/above the ROAS floor are funded from the proven pool.
 *
 * RESPONSE CURVE. We model revenue(spend) ≈ k · √spend — a concave, saturating
 * form (a special case of the Hill/power response curve with exponent ½). It is
 * chosen because:
 *   1. it is concave and strictly increasing, so marginal return
 *          dr/ds = k / (2·√s)
 *      is positive and strictly DECREASING in spend — i.e. genuine diminishing
 *      returns / saturation, the whole point of MMM,
 *   2. the single shape parameter k is identified from ONE observed (spend, revenue)
 *      point:  k = revenue / √spend  — exactly the data we have per channel, and
 *   3. equalising the marginal return across channels has a clean closed form
 *      (aₙ ∝ kₙ²), which we solve by a deterministic bisection on the common
 *      marginal "water level" λ, so there is no RNG and no iteration-order bias.
 *
 * WATER-FILLING. For a common marginal level λ, the unconstrained optimum spend of
 * a channel is sᵢ(λ) = kᵢ² / (4·λ²). Lowering λ raises every channel's desired
 * spend monotonically, so we bisect λ (never below the ROAS floor `targetRoas`)
 * until the clamped desired spends sum to the available pool. Clamping to each
 * channel's [floor, ceiling] and ±maxStep band happens inside the sum, so the
 * guardrails shape the water level itself. If even at the ROAS floor the channels
 * do not want the whole pool, we stop there (never spend into sub-target marginal).
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
  /** Optional conversions/leads (for CAC-based reasoning / logging). */
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
  /** ROAS floor — channels below this are not funded from the proven pool. */
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

/** avgRoas = revenue/spend (0 when there is no spend yet). */
function avgRoas(p: ChannelPerf): number {
  return p.spend > 0 ? p.revenue / p.spend : 0;
}

/**
 * Fit k for revenue ≈ k·√spend from the channel's single observed point.
 * k = revenue / √spend. Zero when the channel has no usable data.
 */
function fitK(p: ChannelPerf): number {
  return p.spend > 0 && p.revenue > 0 ? p.revenue / Math.sqrt(p.spend) : 0;
}

/** Fitted marginal return dr/ds = k / (2·√s) at a proposed spend s. */
function marginalAt(k: number, s: number): number {
  return s > 0 ? k / (2 * Math.sqrt(s)) : 0;
}

interface Row {
  p: ChannelPerf;
  k: number;
  aroas: number;
  lo: number;
  hi: number;
  fundable: boolean;
  /** Held (non-funded) budget when the channel is not eligible for growth. */
  hold: number;
  after: number;
}

export function allocate(perf: ChannelPerf[], params: AllocatorParams): AllocationPlan {
  const totalBudget = Math.max(0, params.totalBudget);
  const explorationPct = clamp(params.explorationPct ?? 20, 0, 90);
  const maxStep = clamp(params.maxStepPct ?? 20, 0, 100) / 100;
  const targetRoas = Math.max(0, params.targetRoas ?? 0);
  const reserve = round2((totalBudget * explorationPct) / 100);
  const pool = round2(totalBudget - reserve);

  const rows: Row[] = perf.map((p) => {
    const minB = p.minBudget ?? 0;
    const maxB = p.maxBudget ?? Number.POSITIVE_INFINITY;
    // The ±maxStep band protects the platform learning phase. A brand-new channel
    // (currentBudget 0) is not step-limited on the upside — it may grow to its ceiling.
    const stepLo = p.currentBudget > 0 ? p.currentBudget * (1 - maxStep) : 0;
    const stepHi = p.currentBudget > 0 ? p.currentBudget * (1 + maxStep) : maxB;
    const lo = Math.max(minB, stepLo);
    const hi = Math.max(lo, Math.min(maxB, stepHi));
    const aroas = avgRoas(p);
    // Fund only channels with proven data whose AVERAGE ROAS clears the floor;
    // the water level additionally caps how far we ride down their marginal curve.
    const fundable = p.spend > 0 && p.revenue > 0 && aroas >= targetRoas;
    return {
      p,
      k: fitK(p),
      aroas,
      lo,
      hi,
      fundable,
      hold: clamp(p.currentBudget, minB, maxB),
      after: 0,
    };
  });

  const funded = rows.filter((r) => r.fundable);
  const heldSum = rows.filter((r) => !r.fundable).reduce((s, r) => s + r.hold, 0);
  const availablePool = pool - heldSum;

  // --- Water-fill the funded channels by equalising marginal return. ---
  // desired spend at water level λ, clamped into the channel's [lo, hi] band.
  const desired = (r: Row, lambda: number) => clamp((r.k * r.k) / (4 * lambda * lambda), r.lo, r.hi);
  const sumAt = (lambda: number) => funded.reduce((s, r) => s + desired(r, lambda), 0);

  if (funded.length > 0) {
    const lambdaFloor = Math.max(targetRoas, 1e-9);
    const LAMBDA_HIGH = 1e9; // λ→∞ ⇒ desired→lo (minimum spend)
    if (availablePool <= 0 || sumAt(LAMBDA_HIGH) >= availablePool) {
      // Floors already meet/exceed what's available: give each its minimum band.
      for (const r of funded) r.after = r.lo;
    } else if (sumAt(lambdaFloor) <= availablePool) {
      // Even at the ROAS floor the channels don't want the whole pool — stop there
      // (never spend into sub-target marginal territory). Underfill is intentional.
      for (const r of funded) r.after = desired(r, lambdaFloor);
    } else {
      // Bisect λ ∈ [lambdaFloor, LAMBDA_HIGH]: sumAt is monotonically decreasing in λ.
      let loL = lambdaFloor;
      let hiL = LAMBDA_HIGH;
      for (let i = 0; i < 200; i++) {
        const mid = (loL + hiL) / 2;
        if (sumAt(mid) > availablePool) loL = mid;
        else hiL = mid;
      }
      for (const r of funded) r.after = desired(r, hiL);
    }
  }
  for (const r of rows) if (!r.fundable) r.after = r.hold;

  // --- Hard cap: if floor/step clamping pushed the sum over the pool, scale the
  // proposals down proportionally so we never exceed the growth budget. ---
  let sum = rows.reduce((s, r) => s + r.after, 0);
  if (sum > pool && sum > 0) {
    const factor = pool / sum;
    for (const r of rows) r.after = r.after * factor;
  }

  const allocations: ChannelAllocation[] = rows.map((r) => {
    const after = round2(r.after);
    const before = round2(r.p.currentBudget);
    let reason: string;
    if (Math.abs(after - before) < 0.01) reason = 'mmm-hold';
    else if (after > before) reason = 'mmm-scale';
    else reason = 'mmm-saturated';
    return {
      channel: r.p.channel,
      campaignRef: r.p.campaignRef ?? '',
      before,
      after,
      deltaPct: r.p.currentBudget > 0 ? round2(((after - r.p.currentBudget) / r.p.currentBudget) * 100) : 0,
      avgRoas: round2(r.aroas),
      // Fitted marginal return at the PROPOSED spend (equalised across funded channels).
      marginalRoas: round2(marginalAt(r.k, after)),
      reason,
    };
  });

  const noop = allocations.every((a) => Math.abs(a.after - a.before) < 0.01);
  return { pool, reserve, totalBudget, allocations, noop };
}
