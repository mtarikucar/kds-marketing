import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * Integration test for the distributed limiter store. It needs a real Redis
 * (the atomic Lua semantics are the whole point and can't be meaningfully
 * mocked), so it auto-skips where none is reachable — CI without Redis stays
 * green, and the session container (REDIS_URL set by the start hook) exercises
 * it for real.
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

describe('RedisThrottlerStorage (integration)', () => {
  let available = false;

  beforeAll(async () => {
    try {
      const probe = new Redis(REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 800,
      });
      await probe.connect();
      await probe.ping();
      await probe.quit();
      available = true;
    } catch {
      available = false;
      // eslint-disable-next-line no-console
      console.warn('[skip] Redis not reachable — RedisThrottlerStorage spec skipped');
    }
  });

  const newStore = () =>
    new RedisThrottlerStorage(REDIS_URL, `throttle-test-${randomUUID()}`);

  it('counts hits within the window and does not block under the limit', async () => {
    if (!available) return;
    const store = newStore();
    try {
      const key = 'user-a';
      const first = await store.increment(key, 10_000, 3, 10_000);
      const second = await store.increment(key, 10_000, 3, 10_000);

      expect(first.totalHits).toBe(1);
      expect(second.totalHits).toBe(2);
      expect(second.isBlocked).toBe(false);
      // TTL is armed on the first hit and within the window.
      expect(first.timeToExpire).toBeGreaterThan(0);
      expect(first.timeToExpire).toBeLessThanOrEqual(10_000);
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('blocks once the limit is exceeded and reports the block window', async () => {
    if (!available) return;
    const store = newStore();
    try {
      const key = 'user-b';
      const limit = 2;
      await store.increment(key, 10_000, limit, 5_000); // 1
      await store.increment(key, 10_000, limit, 5_000); // 2 (== limit, allowed)
      const over = await store.increment(key, 10_000, limit, 5_000); // 3 (> limit)

      expect(over.isBlocked).toBe(true);
      expect(over.timeToBlockExpire).toBeGreaterThan(0);
      expect(over.timeToBlockExpire).toBeLessThanOrEqual(5_000);
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('keeps separate keys in independent buckets (per-identity isolation)', async () => {
    if (!available) return;
    const store = newStore();
    try {
      await store.increment('alice', 10_000, 5, 10_000);
      await store.increment('alice', 10_000, 5, 10_000);
      const bob = await store.increment('bob', 10_000, 5, 10_000);
      expect(bob.totalHits).toBe(1);
    } finally {
      await store.onModuleDestroy();
    }
  });

  it('shares one bucket across separate store instances (the cross-replica guarantee)', async () => {
    if (!available) return;
    // Same prefix + key from two instances == two replicas hitting one bucket.
    const prefix = `throttle-shared-${randomUUID()}`;
    const a = new RedisThrottlerStorage(REDIS_URL, prefix);
    const b = new RedisThrottlerStorage(REDIS_URL, prefix);
    try {
      const r1 = await a.increment('k', 10_000, 10, 10_000);
      const r2 = await b.increment('k', 10_000, 10, 10_000);
      expect(r1.totalHits).toBe(1);
      expect(r2.totalHits).toBe(2); // b sees a's hit — shared global counter
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
  });
});
