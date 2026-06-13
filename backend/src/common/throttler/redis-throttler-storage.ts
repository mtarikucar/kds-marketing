import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

/**
 * The shape ThrottlerGuard expects back from a storage. Defined inline because
 * `@nestjs/throttler` re-exports the `ThrottlerStorage` interface from its root
 * but not this record interface. All times are milliseconds.
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed {@link ThrottlerStorage} (Horizontal Scalability) — backlog #6.
 *
 * The default `ThrottlerModule` keeps its hit counters in per-process memory, so
 * behind N replicas a "5 logins / minute" rule actually allows 5·N — each pod
 * counts its own slice. Moving the counters to Redis makes the bucket GLOBAL, so
 * the limit means what it says regardless of replica count.
 *
 * Correctness: the increment + expiry-arm + over-limit block decision must be
 * one atomic step or two pods racing can both see "first hit" and never arm the
 * TTL. We do it in a single Lua script (Redis executes it atomically), mirroring
 * the well-trodden `nestjs-throttler-storage-redis` approach but vendored here so
 * we own the v6 interface (ms-based `ttl`/`blockDuration`, the `isBlocked` /
 * `timeToBlockExpire` fields) and the fail-open policy below.
 *
 * Availability: a rate limiter must never become a single point of failure. If
 * Redis is unreachable we FAIL OPEN — log once and let the request through —
 * rather than 500 every caller. A brief limiter outage is a far smaller incident
 * than a total outage.
 */
const SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

-- Already blocked? Report the remaining block window without counting further.
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitsKey)) or (limit + 1)
  local hitsTtl = redis.call('PTTL', hitsKey)
  if hitsTtl < 0 then hitsTtl = ttl end
  return { hits, hitsTtl, 1, blockTtl }
end

local totalHits = redis.call('INCR', hitsKey)
local timeToExpire = redis.call('PTTL', hitsKey)
if timeToExpire <= 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  timeToExpire = ttl
end

local isBlocked = 0
local timeToBlockExpire = 0
if totalHits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  isBlocked = 1
  timeToBlockExpire = blockDuration
end

return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
`;

interface ThrottleRedis extends Redis {
  throttle(
    hitsKey: string,
    blockKey: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<[number, number, number, number]>;
}

export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: ThrottleRedis;
  private warnedDown = false;

  constructor(url: string, prefix = 'throttle') {
    this.redis = new Redis(url, {
      // Bound every wait so a slow/blocked Redis can't pin a request: commandTimeout
      // hard-caps each call (queued or live) at 1s, after which increment() fails
      // open. The offline queue is left ON so the very first call (issued before
      // the socket is ready) succeeds instead of being rejected; the timeout still
      // protects it. connection 'error' events are swallowed below.
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
    }) as ThrottleRedis;

    // Swallow connection-error events (they'd otherwise crash the process as
    // unhandled 'error'); increment() already degrades gracefully.
    this.redis.on('error', (err) => {
      if (!this.warnedDown) {
        this.logger.warn(`Redis throttler store unavailable: ${err.message}`);
        this.warnedDown = true;
      }
    });
    this.redis.on('ready', () => {
      this.warnedDown = false;
    });

    this.redis.defineCommand('throttle', { numberOfKeys: 2, lua: SCRIPT });
    this.prefix = prefix;
  }

  private readonly prefix: string;

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `${this.prefix}:${key}`;
    const blockKey = `${this.prefix}:block:${key}`;
    try {
      const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] =
        await this.redis.throttle(hitsKey, blockKey, ttl, limit, blockDuration);
      return {
        totalHits,
        timeToExpire,
        isBlocked: isBlocked === 1,
        timeToBlockExpire,
      };
    } catch (err) {
      // Default policy is FAIL OPEN: a limiter outage must not become an API
      // outage. The trade-off is that brute-force protection (e.g. the login
      // limit) is lifted while Redis is unreachable. Deploys that prefer to keep
      // the limiter strict during an outage can set THROTTLER_FAIL_CLOSED=1 to
      // fail CLOSED instead (every request 429s until Redis recovers). Either
      // way the condition is surfaced (once) so it's alertable on the log line.
      const failClosed = process.env.THROTTLER_FAIL_CLOSED === '1';
      if (!this.warnedDown) {
        this.logger.warn(
          `Redis throttler increment failed, failing ${failClosed ? 'CLOSED' : 'OPEN'}: ${(err as Error).message}`,
        );
        this.warnedDown = true;
      }
      return failClosed
        ? { totalHits: limit + 1, timeToExpire: ttl, isBlocked: true, timeToBlockExpire: blockDuration }
        : { totalHits: 0, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
