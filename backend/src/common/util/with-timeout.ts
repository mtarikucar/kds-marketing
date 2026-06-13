/**
 * Races a promise against a bounded timeout. Used to cap work that must never
 * hang a request — notably the DB queries the Prometheus collectors run inside
 * prom-client's `collect()` hook, which a `/metrics` scrape awaits: without a
 * bound, a hung DB would leave the scrape (and its connection) pending forever
 * and let concurrent scrapes exhaust the pool.
 *
 * The timer is `unref`'d so it can never keep the process alive on its own.
 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    // Node's Timeout has unref(); guard for non-Node timers in tests.
    (timer as { unref?: () => void }).unref?.();

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
