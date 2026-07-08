import { AccountRateBudgeter } from './account-rate-budgeter';

describe('AccountRateBudgeter', () => {
  it('enforces the window per account+bucket independently', () => {
    const b = new AccountRateBudgeter();
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(true);
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(true);
    expect(b.tryTake('acc1', 'report', 2, 60_000)).toBe(false); // acc1 exhausted
    expect(b.tryTake('acc2', 'report', 2, 60_000)).toBe(true);  // acc2 unaffected
    expect(b.tryTake('acc1', 'iys', 2, 60_000)).toBe(true);     // other bucket unaffected
  });
  it('refills after the window elapses', () => {
    jest.useFakeTimers();
    const b = new AccountRateBudgeter();
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(true);
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(false);
    jest.advanceTimersByTime(1001);
    expect(b.tryTake('a', 'x', 1, 1000)).toBe(true);
    jest.useRealTimers();
  });
});
