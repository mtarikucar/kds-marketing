import { Global, Module } from '@nestjs/common';
import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * Provides the {@link RedisThrottlerStorage} as a first-class provider — but
 * ONLY when `REDIS_URL` is configured; otherwise the provider resolves to
 * `null` and the ThrottlerModule keeps its default in-memory store (so dev, the
 * e2e harness, and any single-replica deploy work with zero Redis dependency).
 *
 * Registering it as a provider (rather than `new`-ing it inside the Throttler
 * factory) is what lets Nest call its `onModuleDestroy` and quit the Redis
 * connection cleanly on a rolling restart.
 */
@Global()
@Module({
  providers: [
    {
      provide: RedisThrottlerStorage,
      useFactory: (): RedisThrottlerStorage | null => {
        const url = process.env.REDIS_URL;
        return url ? new RedisThrottlerStorage(url) : null;
      },
    },
  ],
  exports: [RedisThrottlerStorage],
})
export class ThrottlerRedisModule {}
