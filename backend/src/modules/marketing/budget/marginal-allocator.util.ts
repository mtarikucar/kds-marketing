/**
 * Stage-1 budget allocator (Budget Autopilot, Faz 7): marginal-ROAS reallocation.
 *
 * Pure and dependency-free so the money-moving logic is exhaustively unit-tested
 * before it ever touches a real ad account. This is deliberately NOT a
 * per-auction bidder (Meta Advantage+ / Google Smart Bidding own the auction) —
 * it distributes a fixed budget pool ACROSS channels toward the strongest next
 * dollar, honoring the guardrails the design mandates:
 *   - an exploration reserve is held back for learning,
 *   - no channel moves more than `maxStepPct` in one run (larger jumps reset the
 *     platform learning phase),
 *   - per-channel floors/ceilings are respected,
 *   - the sum of proposals never exceeds the pool (the growth budget is a hard cap),
 *   - only channels at/above the ROAS floor are funded.
 *
 * The key modelled insight: a dollar is worth taking from a high-AVERAGE-ROAS but
 * saturated channel and giving to an unsaturated one, because the next dollar's
 * MARGINAL return is stronger there. Saturation is proxied by a channel's current
 * share of the pool. Stage-2 (Thompson-sampling bandit) and Stage-3 (MMM-lite)
 * refine this once conversion volume accrues.
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
 * marginalRoas ≈ avgRoas × (1 − saturation), where saturation is the channel's
 * current share of the pool (a channel already taking a big slice is more
 * saturated, so its next dollar is worth less). Capped so a dominant channel is
 * never fully zeroed by the proxy alone.
 */
function marginalRoas(p: ChannelPerf, pool: number): number {
  const saturation = pool > 0 ? clamp(p.currentBudget / pool, 0, 0.9) : 0;
  return avgRoas(p) * (1 - saturation);
}

export function allocate(perf: ChannelPerf[], params: AllocatorParams): AllocationPlan {
  const totalBudget = Math.max(0, params.totalBudget);
  const explorationPct = clamp(params.explorationPct ?? 20, 0, 90);
  const maxStep = clamp(params.maxStepPct ?? 20, 0, 100) / 100;
  const targetRoas = Math.max(0, params.targetRoas ?? 0);
  const reserve = round2((totalBudget * explorationPct) / 100);
  const pool = round2(totalBudget - reserve);

  const rows = perf.map((p) => {
    const mroas = marginalRoas(p, pool);
    const score = Math.max(0, mroas - targetRoas);
    return { p, mroas, aroas: avgRoas(p), score };
  });

  const scoreSum = rows.reduce((s, r) => s + r.score, 0);

  const allocations: ChannelAllocation[] = rows.map((r) => {
    const { p } = r;
    const lo = p.minBudget ?? 0;
    const hi = p.maxBudget ?? Number.POSITIVE_INFINITY;
    let after: number;
    let reason: string;
    if (scoreSum <= 0) {
      // No channel clears the ROAS floor (or no data): hold current, clamped.
      after = clamp(p.currentBudget, lo, hi);
      reason = p.spend > 0 ? 'below-target-hold' : 'cold-start-hold';
    } else {
      const target = pool * (r.score / scoreSum);
      // Limit the move to ±maxStep around the current budget (protect learning).
      const stepLo = p.currentBudget * (1 - maxStep);
      const stepHi = p.currentBudget === 0 ? target : p.currentBudget * (1 + maxStep);
      after = clamp(target, stepLo, stepHi);
      after = clamp(after, lo, hi);
      reason = r.mroas >= r.aroas ? 'scale-marginal' : 'trim-saturated';
    }
    return {
      channel: p.channel,
      campaignRef: p.campaignRef ?? '',
      before: round2(p.currentBudget),
      after: round2(after),
      deltaPct: p.currentBudget > 0 ? round2(((after - p.currentBudget) / p.currentBudget) * 100) : 0,
      avgRoas: round2(r.aroas),
      marginalRoas: round2(r.mroas),
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
