import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { SIGNATURE_MAX_AGE_MS } from './index';

/**
 * "Has this webhook token already been spent, and on which body?"
 *
 * ## Why it exists
 *
 * Mailgun signs `timestamp + token` and NOT the payload, so one captured
 * signature block authenticates ANY body until the timestamp goes stale — and
 * `SIGNATURE_MAX_AGE_MS` is a deliberate 24 hours, because the providers replay
 * their original signed payload for up to a day and a tight window would turn
 * one bad deploy into permanently lost bounce events. Mailgun makes the token
 * single-use on THEIR side, which says nothing about a forgery posted straight
 * at us. So the token has to be spent on OUR side too, and spent on one
 * specific body (`mailgun-body-unsigned`).
 *
 * The body hash is what keeps that from breaking the provider: a redelivery
 * carries the same bytes and is acknowledged; only a DIFFERENT body under an
 * already-seen token is a forgery.
 *
 * ## Where it is kept
 *
 * Redis when `REDIS_URL` is set (which production is), so the token is spent
 * for the whole deployment and not once per replica. Without it, an in-process
 * map — per-replica best-effort, the same trade-off `ThrottlerRedisModule`
 * already documents for the rate limiter, and still a hard bound on an attacker
 * who would otherwise have 24 hours of unlimited reuse.
 *
 * Never throws and never blocks a webhook: a store that cannot answer returns
 * "not seen", because losing a real bounce event is a worse outcome than
 * letting a replay through to an idempotent write. For the same reason the
 * check and the write are not one atomic step — the token is spent only once
 * the request has settled 2xx, so two requests racing on one token can both be
 * let through. That costs an attacker who already holds a valid captured block
 * one extra use; making it atomic would cost a provider its retry, which is
 * the failure this whole package exists to prevent.
 */

/** Mirrors the signature's own lifetime: once the timestamp is stale the
 *  verifier refuses the block anyway, so remembering it longer buys nothing. */
const TTL_MS = SIGNATURE_MAX_AGE_MS;

/** In-memory ceiling. At ~100 bytes an entry this is a few MB, and a webhook
 *  flood must not be able to grow the heap without bound. */
const MAX_ENTRIES = 50_000;

export interface ReplayVerdict {
  /** This token has been spent before. */
  seen: boolean;
  /** …on exactly these bytes — i.e. a genuine provider redelivery. */
  sameBody?: boolean;
}

@Injectable()
export class WebhookReplayStore implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookReplayStore.name);
  private readonly redis: Redis | null;
  /** Insertion-ordered, so the oldest key is the first one a Map yields. */
  private readonly memory = new Map<string, { hash: string; expiresAt: number }>();
  private warned = false;

  constructor() {
    const url = process.env.REDIS_URL;
    this.redis = url ? new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false }) : null;
    // ioredis emits `error` on a dropped connection; an unhandled one takes the
    // process down. Every read and write below already falls back to memory.
    this.redis?.on('error', (e) => this.warnOnce(`redis unavailable: ${e?.message ?? e}`));
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis?.quit();
    } catch {
      /* a store that cannot close cleanly must not fail a shutdown */
    }
  }

  /** The body's identity, so a redelivery can be told apart from a forgery. */
  static hashBody(raw: Buffer): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Has `token` been spent, and on these bytes?
   *
   * Answers `{ seen: false }` for an unknown token AND for a store that is
   * unreachable — see the fail-open note above.
   */
  async check(provider: string, token: string, bodyHash: string): Promise<ReplayVerdict> {
    if (!token) return { seen: false };
    const key = this.key(provider, token);
    const stored = await this.read(key);
    if (!stored) return { seen: false };
    return { seen: true, sameBody: stored === bodyHash };
  }

  /**
   * Spend `token` on these bytes.
   *
   * Called only once the request has actually settled 2xx: recording a token
   * whose handling failed would turn the provider's retry — the thing that
   * makes a transient failure survivable — into a permanent loss.
   */
  async remember(provider: string, token: string, bodyHash: string): Promise<void> {
    if (!token) return;
    const key = this.key(provider, token);
    if (this.redis) {
      try {
        await this.redis.set(key, bodyHash, 'PX', TTL_MS);
        return;
      } catch (e: any) {
        this.warnOnce(`redis write failed, falling back to memory: ${e?.message ?? e}`);
      }
    }
    this.writeMemory(key, bodyHash);
  }

  private async read(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const hit = await this.redis.get(key);
        if (hit) return hit;
      } catch (e: any) {
        this.warnOnce(`redis read failed, falling back to memory: ${e?.message ?? e}`);
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.hash;
  }

  private writeMemory(key: string, hash: string): void {
    // Sweep what has expired before trimming, so a quiet period does not evict
    // live tokens just because the map once filled up.
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
    this.memory.set(key, { hash, expiresAt: now + TTL_MS });
    while (this.memory.size > MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** Scoped by provider: two ESPs' token spaces are unrelated. */
  private key(provider: string, token: string): string {
    return `webhook-replay:${provider}:${token}`;
  }

  /** One line per outage, not one per request. */
  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(`webhook replay store: ${message}`);
  }
}
