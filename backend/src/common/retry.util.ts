/** Bounded in-process retry with caller-defined backoff. */
export interface RetryOptions<T> {
  /** Total attempts (>= 1). */
  attempts: number;
  /** Retry when the call THREW (`error` set) or returned a retriable RESULT. */
  shouldRetry: (outcome: { result?: T; error?: unknown }) => boolean;
  /** Backoff before the next attempt; `attempt` is the 1-based index of the
   *  attempt that just failed (so the first delay is delayMs(1)). */
  delayMs: (attempt: number) => number;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying transient failures up to `attempts` times. A failure is
 * either a thrown error or a returned result the caller flags via `shouldRetry`.
 * Sleeps BETWEEN attempts only (never after the last). Returns the last result
 * or rethrows the last error once attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions<T>): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  let lastError: unknown;
  let lastResult: T | undefined;
  let threw = false;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    threw = false;
    try {
      lastResult = await fn();
    } catch (e) {
      threw = true;
      lastError = e;
    }

    const isLast = attempt === opts.attempts;
    const wantRetry = threw
      ? opts.shouldRetry({ error: lastError })
      : opts.shouldRetry({ result: lastResult });

    if (!wantRetry) {
      if (threw) throw lastError;
      return lastResult as T;
    }
    if (isLast) break;
    await sleep(opts.delayMs(attempt));
  }

  if (threw) throw lastError;
  return lastResult as T;
}
