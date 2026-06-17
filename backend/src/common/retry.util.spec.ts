import { withRetry } from './retry.util';

/**
 * Bounded in-process retry. Retries either a thrown error OR a returned result
 * the caller deems retriable (e.g. a provider "rate limited" outcome), backing
 * off between attempts. `sleep` is injected so tests stay deterministic and
 * instant.
 */
describe('withRetry', () => {
  const noSleep = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => noSleep.mockClear());

  it('returns immediately on success without sleeping', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const out = await withRetry(fn, {
      attempts: 3,
      shouldRetry: ({ error }) => error !== undefined,
      delayMs: () => 100,
      sleep: noSleep,
    });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('retries a thrown error up to `attempts` then rethrows the last error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      withRetry(fn, { attempts: 3, shouldRetry: () => true, delayMs: () => 10, sleep: noSleep }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2); // sleeps BETWEEN attempts, not after the last
  });

  it('stops early and returns once a transient throw recovers', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('recovered');
    const out = await withRetry(fn, {
      attempts: 3,
      shouldRetry: ({ error }) => error !== undefined,
      delayMs: () => 10,
      sleep: noSleep,
    });
    expect(out).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
  });

  it('retries a retriable RESULT and returns the last result when still retriable at the end', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: false, retriable: true });
    const out = await withRetry(fn, {
      attempts: 2,
      shouldRetry: ({ result }) => !!result && (result as any).retriable,
      delayMs: () => 10,
      sleep: noSleep,
    });
    expect(out).toEqual({ ok: false, retriable: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when shouldRetry returns false (permanent failure)', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: false, retriable: false });
    const out = await withRetry(fn, {
      attempts: 5,
      shouldRetry: ({ result }) => !!result && (result as any).retriable,
      delayMs: () => 10,
      sleep: noSleep,
    });
    expect((out as any).ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('computes the backoff per failed-attempt index (1-based) and awaits it', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('x'));
    const delays: number[] = [];
    const sleep = jest.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });
    await expect(
      withRetry(fn, {
        attempts: 3,
        shouldRetry: () => true,
        delayMs: (attempt) => attempt * 100,
        sleep,
      }),
    ).rejects.toThrow('x');
    expect(delays).toEqual([100, 200]);
  });
});
