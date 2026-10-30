/**
 * A clock that moves 1 ms on EVERY read — `new Date()` and `Date.now()` alike.
 *
 * A real clock can tick between any two statements, but rarely does, so code
 * that reads it twice for what is meant to be one instant passes almost every
 * run and fails in CI once in a while. This makes the tick certain instead of
 * rare. Returns the function that puts the real clock back.
 *
 * Only `Date` is replaced; timers are untouched, so awaits and real I/O run
 * normally underneath it.
 */
export function installTickingClock(): () => void {
  const RealDate = Date;
  let now = RealDate.now();
  class TickingDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(now++);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return now++;
    }
  }
  globalThis.Date = TickingDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
