import { monthProgress, pace } from './pacer.util';

describe('pace (PID budget pacer)', () => {
  it('is on pace when spend tracks the ideal curve', () => {
    const r = pace({ totalBudget: 3000, spentToDate: 1500, elapsedFraction: 0.5, remainingDays: 15 });
    expect(r.idealToDate).toBe(1500);
    expect(r.status).toBe('ON_PACE');
    expect(r.paceRatio).toBe(1);
    // even remaining ≈ 1500/15 = 100, error 0 → cap ≈ 100
    expect(r.recommendedDailyCap).toBeCloseTo(100, 0);
  });

  it('raises the daily cap when underspending (behind pace)', () => {
    const behind = pace({ totalBudget: 3000, spentToDate: 500, elapsedFraction: 0.5, remainingDays: 15 });
    expect(behind.status).toBe('UNDERSPENDING');
    expect(behind.error).toBe(1000); // ideal 1500 - spent 500
    const even = 2500 / 15; // ≈166.7
    expect(behind.recommendedDailyCap).toBeGreaterThan(even); // PID pushes it up
  });

  it('lowers the daily cap when overspending (ahead of pace)', () => {
    const ahead = pace({ totalBudget: 3000, spentToDate: 2500, elapsedFraction: 0.5, remainingDays: 15 });
    expect(ahead.status).toBe('OVERSPENDING');
    expect(ahead.error).toBe(-1000);
    const even = 500 / 15; // ≈33.3
    expect(ahead.recommendedDailyCap).toBeLessThan(even); // PID pulls it down
  });

  it('never recommends more than the remaining budget (hard cap)', () => {
    const r = pace({ totalBudget: 1000, spentToDate: 900, elapsedFraction: 0.1, remainingDays: 1, kp: 5, ki: 5 });
    expect(r.recommendedDailyCap).toBeLessThanOrEqual(100); // remaining = 1000-900
    expect(r.recommendedDailyCap).toBeGreaterThanOrEqual(0);
  });

  it('accumulates the integral across ticks', () => {
    const t1 = pace({ totalBudget: 3000, spentToDate: 500, elapsedFraction: 0.5, remainingDays: 15 });
    const t2 = pace({ totalBudget: 3000, spentToDate: 700, elapsedFraction: 0.6, remainingDays: 12, prevIntegral: t1.integral });
    expect(t2.integral).toBe(t1.integral + t2.error);
  });

  it('handles the final day (remainingDays 0) without dividing by zero', () => {
    const r = pace({ totalBudget: 1000, spentToDate: 400, elapsedFraction: 0.99, remainingDays: 0 });
    expect(Number.isFinite(r.recommendedDailyCap)).toBe(true);
    expect(r.recommendedDailyCap).toBeLessThanOrEqual(600);
  });
});

describe('monthProgress', () => {
  it('computes elapsed fraction and remaining days mid-month', () => {
    const p = monthProgress('2026-07', new Date('2026-07-16T00:00:00Z'));
    expect(p.daysInMonth).toBe(31);
    expect(p.elapsedFraction).toBeCloseTo(15 / 31, 2);
    expect(p.remainingDays).toBe(16);
  });

  it('clamps to 0 before the month and 1 after', () => {
    expect(monthProgress('2026-07', new Date('2026-06-01T00:00:00Z')).elapsedFraction).toBe(0);
    expect(monthProgress('2026-07', new Date('2026-08-15T00:00:00Z')).elapsedFraction).toBe(1);
  });
});
