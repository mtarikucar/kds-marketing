/**
 * Budget pacing controller (Budget Autopilot, Faz 7) — a small PID that keeps
 * cumulative spend tracking the ideal straight-line curve across the period, so
 * the autopilot neither front-loads the budget early nor starves it late.
 * Pure + dependency-free so the money-pacing math is fully unit-tested.
 *
 *   ideal(t)   = totalBudget × elapsedFraction
 *   error      = ideal − spentToDate           (positive ⇒ underspending)
 *   integral  += error                          (accumulated bias)
 *   dailyCap   = evenRemaining + Kp·error + Ki·integral   (clamped ≥0, ≤remaining)
 *
 * When behind pace the cap rises to catch up; when ahead it falls to slow down.
 * The recommendation is always clamped so it can never exceed what's left of the
 * hard-cap budget.
 */

export interface PacerInput {
  totalBudget: number;
  spentToDate: number;
  /** 0..1 fraction of the period elapsed. */
  elapsedFraction: number;
  /** Whole days left in the period (≥0). */
  remainingDays: number;
  prevIntegral?: number;
  prevError?: number;
  kp?: number;
  ki?: number;
}

export interface PacerOutput {
  idealToDate: number;
  error: number;
  integral: number;
  recommendedDailyCap: number;
  paceRatio: number;
  status: 'ON_PACE' | 'UNDERSPENDING' | 'OVERSPENDING';
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function pace(input: PacerInput): PacerOutput {
  const total = Math.max(0, input.totalBudget);
  const spent = Math.max(0, input.spentToDate);
  const frac = clamp(input.elapsedFraction, 0, 1);
  const kp = input.kp ?? 0.5;
  const ki = input.ki ?? 0.1;

  const idealToDate = round2(total * frac);
  const error = round2(idealToDate - spent);
  const integral = round2((input.prevIntegral ?? 0) + error);

  const remaining = Math.max(0, total - spent);
  // Even spread of what's left over the days left (min 1 day so we don't divide
  // by zero on the last day — the whole remainder is then available today).
  const evenRemaining = remaining / Math.max(1, input.remainingDays);
  const recommendedDailyCap = round2(clamp(evenRemaining + kp * error + ki * integral, 0, remaining));

  const paceRatio = idealToDate > 0 ? round2(spent / idealToDate) : spent > 0 ? Infinity : 1;
  const status: PacerOutput['status'] =
    paceRatio < 0.9 ? 'UNDERSPENDING' : paceRatio > 1.1 ? 'OVERSPENDING' : 'ON_PACE';

  return { idealToDate, error, integral, recommendedDailyCap, paceRatio, status };
}

/**
 * Period helper: fraction elapsed and whole days remaining for a YYYY-MM budget
 * period at instant `now` (UTC). Before the month → 0 elapsed; after → 1.
 */
export function monthProgress(periodKey: string, now: Date): { elapsedFraction: number; remainingDays: number; daysInMonth: number } {
  const [y, m] = periodKey.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1); // first instant of next month
  const daysInMonth = Math.round((end - start) / 86_400_000);
  const t = now.getTime();
  const elapsedFraction = clamp((t - start) / (end - start), 0, 1);
  const remainingDays = Math.max(0, Math.ceil((end - t) / 86_400_000));
  return { elapsedFraction: round2(elapsedFraction), remainingDays, daysInMonth };
}
