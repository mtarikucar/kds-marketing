import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { AccountRateBudgeter } from '../core/account-rate-budgeter';

export interface NetasistanAuthResult {
  ok: boolean;
  token: string | null;
  /** Epoch ms the bearer expires — a fresh auth is valid ~1h (facts: "1h bearer"). */
  expiresAt: number | null;
  message: string | null;
  /** True only for a rate-limit/budget denial — safe to retry shortly. */
  retriable: boolean;
}

export interface NetasistanActionResult {
  ok: boolean;
  code?: string;
  message: string | null;
  retriable: boolean;
}

/** The realm-wide `/break` + `/queue` (+ `/auth`) rate cap (facts: "60 req/min
 *  global") — every method on this client shares the SAME `'netasistan'`
 *  bucket, mirroring İYS's/autocall's aggregate-not-per-endpoint cap. */
const NETASISTAN_BUDGET_LIMIT = 60;
const NETASISTAN_BUDGET_WINDOW_MS = 60_000;

/** Re-authenticate a little before the real 1h expiry so a request mid-flight
 *  never 401s (same early-refresh idiom as the OAuth token stores). */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** NetGSM's documented bearer lifetime for this realm (facts: "1h bearer") —
 *  used only when the auth response doesn't echo its own TTL/expiry. */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Only a genuine rate-limit response eases on its own. */
function isRetriableHttpStatus(status: number): boolean {
  return status === 429;
}

/**
 * NetGSM Netasistan client (NetGSM Phase 6 Task 4) — a SEPARATE auth realm
 * from every other client in this hub: workspaces authenticate with an
 * `appKey` + `userKey` pair (NOT the Netsantral username/password
 * `NetsantralClient` uses) to obtain a short-lived (~1h) bearer token, then
 * spend that bearer on two agent SELF-SERVICE actions:
 *  - `PUT /break` — put the CALLING agent on/off a break, with an optional
 *    reason string.
 *  - `PUT /queue` — join/leave a named queue.
 *
 * Unlike `NetsantralClient.agentPause`/`agentLogin` (Phase 4 Task 4, an
 * ADMIN-level PBX action keyed by dahili), these two are documented as
 * agent-self-service — the presence sync in `TelephonyQueueService` calls
 * BOTH surfaces side by side (best-effort for Netasistan; the santral call
 * remains the source of truth), never one instead of the other.
 *
 * Only relevant for tenants running the separate Netasistan product ALONGSIDE
 * their Netsantral santral (facts) — a workspace with no Netasistan app-key/
 * user-key configured simply never reaches this client (gated upstream by
 * `TelephonyConfigService.resolveNetasistanForWorkspace` returning `null`).
 *
 * Host/paths are a best-effort match to NetGSM's separate-subdomain naming
 * convention for niche realms (mirrors `whatsappapi.netgsm.com.tr` for the
 * WhatsApp OTP client) — "researched, not yet live-verified", the SAME status
 * every other Phase 5/6 client carried before its own live confirmation;
 * response parsing stays tolerant of key-name aliases so the real shape slots
 * in without a rewrite. Never logs the app-key/user-key/bearer token — a
 * transport error's message can echo the request, so all three are scrubbed
 * before any log line.
 */
@Injectable()
export class NetasistanClient {
  private readonly logger = new Logger(NetasistanClient.name);
  static readonly AUTH_URL = 'https://netasistanapi.netgsm.com.tr/api/auth';
  static readonly BREAK_URL = 'https://netasistanapi.netgsm.com.tr/api/break';
  static readonly QUEUE_URL = 'https://netasistanapi.netgsm.com.tr/api/queue';

  /**
   * In-memory bearer cache, keyed by `appKey` — the Netasistan app-key is
   * already unique per workspace's Netasistan account, so no separate
   * workspace id is needed as part of the key. Never persisted: a process
   * restart just re-authenticates on the next presence toggle. Not an
   * accuracy hazard (same accepted limitation as `AccountRateBudgeter`'s
   * in-memory windows) since a stale/missing cache entry only costs one
   * extra `/auth` round trip, never a wrong result.
   */
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly budgeter: AccountRateBudgeter) {}

  /** Raw `/auth` call — ALWAYS hits the network (no caching here; see
   *  `getToken` for the cached accessor most callers should use instead). */
  async authenticate(appKey: string, userKey: string): Promise<NetasistanAuthResult> {
    if (!appKey || !appKey.trim() || !userKey || !userKey.trim()) {
      return {
        ok: false, token: null, expiresAt: null,
        message: 'Netasistan app-key/user-key gerekli.', retriable: false,
      };
    }
    if (!this.budgeter.tryTake(appKey, 'netasistan', NETASISTAN_BUDGET_LIMIT, NETASISTAN_BUDGET_WINDOW_MS)) {
      return { ok: false, token: null, expiresAt: null, message: this.budgetDeniedMessage(), retriable: true };
    }

    let httpStatus = 0;
    let respBody: any;
    try {
      const res = await safeFetch(NetasistanClient.AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, userKey }),
        timeoutMs: 15_000,
      });
      httpStatus = res.status;
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netasistan auth transport error: ${this.scrubKeys(e, appKey, userKey)}`);
      return {
        ok: false, token: null, expiresAt: null,
        message: 'Netasistan kimlik doğrulama isteğine ulaşılamadı.', retriable: false,
      };
    }
    if (httpStatus >= 400) {
      this.logger.warn(`netasistan auth HTTP ${httpStatus}`);
      return {
        ok: false, token: null, expiresAt: null,
        message: `Netasistan kimlik doğrulaması reddedildi (HTTP ${httpStatus}).`,
        retriable: isRetriableHttpStatus(httpStatus),
      };
    }
    const token = pick(respBody, ['token', 'accessToken', 'access_token', 'Token', 'AccessToken']);
    if (token == null) {
      return {
        ok: false, token: null, expiresAt: null,
        message: 'Netasistan beklenmedik yanıt döndürdü.', retriable: false,
      };
    }
    return {
      ok: true, token: String(token), expiresAt: this.computeExpiresAt(respBody),
      message: null, retriable: false,
    };
  }

  /**
   * Cached accessor — returns the cached bearer while it still has more than
   * `TOKEN_SAFETY_MARGIN_MS` left on its ~1h lifetime, and only calls
   * `authenticate` (spending a budget slot + refreshing the cache) once it's
   * missing/expiring. This is the method `TelephonyQueueService` should call
   * on every presence toggle — it degrades to one `/auth` round trip per hour
   * per workspace rather than one per toggle.
   */
  async getToken(appKey: string, userKey: string): Promise<NetasistanAuthResult> {
    const cached = this.tokenCache.get(appKey);
    if (cached && cached.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()) {
      return { ok: true, token: cached.token, expiresAt: cached.expiresAt, message: null, retriable: false };
    }
    const fresh = await this.authenticate(appKey, userKey);
    if (fresh.ok && fresh.token && fresh.expiresAt) {
      this.tokenCache.set(appKey, { token: fresh.token, expiresAt: fresh.expiresAt });
    } else {
      this.tokenCache.delete(appKey);
    }
    return fresh;
  }

  /**
   * `PUT /break` — self-service: put `agentId` on break (with an optional
   * reason) or take them off it. `agentId` is a best-effort re-use of the
   * rep's Netsantral `dahili` (see `TelephonyQueueService` — Netasistan may
   * require a distinct agent identifier of its own; that's an open item
   * pending a live account, same status as every other unconfirmed field
   * name in this program).
   */
  async setBreak(token: string, agentId: string, reason?: string): Promise<NetasistanActionResult> {
    if (!token || !agentId) {
      return { ok: false, message: 'Netasistan break için token/agentId gerekli.', retriable: false };
    }
    return this.putAuthorized(NetasistanClient.BREAK_URL, token, { agentId, ...(reason ? { reason } : {}) }, 'break');
  }

  /** `PUT /queue` — self-service join (`join:true`) or leave (`join:false`)
   *  a named queue. `queueName` is optional — omitted joins/leaves whatever
   *  queue the Netasistan account has the agent assigned to by default. */
  async setQueue(token: string, agentId: string, join: boolean, queueName?: string): Promise<NetasistanActionResult> {
    if (!token || !agentId) {
      return { ok: false, message: 'Netasistan queue için token/agentId gerekli.', retriable: false };
    }
    return this.putAuthorized(
      NetasistanClient.QUEUE_URL,
      token,
      { agentId, join, ...(queueName ? { queueName } : {}) },
      'queue',
    );
  }

  private async putAuthorized(
    url: string,
    token: string,
    body: Record<string, unknown>,
    label: 'break' | 'queue',
  ): Promise<NetasistanActionResult> {
    // break/queue share the SAME realm-wide 60/min cap as /auth (facts). The
    // bearer token is the only account-identifying value these two methods
    // receive (by the deliverable's own signature — no appKey param) and is
    // stable for the life of the ~1h token, so it doubles as the budgeter key:
    // every agent under the same Netasistan account shares one token and thus
    // one budget bucket, which is the correct scope for an account-wide cap.
    if (!this.budgeter.tryTake(token, 'netasistan', NETASISTAN_BUDGET_LIMIT, NETASISTAN_BUDGET_WINDOW_MS)) {
      return { ok: false, message: this.budgetDeniedMessage(), retriable: true };
    }

    let httpStatus = 0;
    let respBody: any;
    try {
      const res = await safeFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        timeoutMs: 15_000,
      });
      httpStatus = res.status;
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netasistan ${label} transport error: ${this.scrubToken(e, token)}`);
      return { ok: false, message: `Netasistan ${label} isteğine ulaşılamadı.`, retriable: false };
    }
    if (httpStatus >= 400) {
      this.logger.warn(`netasistan ${label} HTTP ${httpStatus}`);
      return {
        ok: false,
        message: `Netasistan ${label} isteği reddedildi (HTTP ${httpStatus}).`,
        retriable: isRetriableHttpStatus(httpStatus),
      };
    }
    const code = respBody?.code != null ? String(respBody.code) : null;
    // Tolerant success/failure envelope: an explicit non-'00'/'0' code is a
    // rejection; no code at all (or '00'/'0') on a 2xx is treated as success —
    // mirrors the rest of this hub's `{code, message}` classic-API tolerance.
    if (code != null && code !== '00' && code !== '0') {
      const message =
        typeof respBody?.message === 'string' && respBody.message.trim()
          ? respBody.message.trim()
          : `Netasistan ${label} isteği reddedildi (kod ${code}).`;
      this.logger.warn(`netasistan ${label} error code=${code} ${message}`);
      return { ok: false, code, message, retriable: false };
    }
    return { ok: true, code: code ?? undefined, message: null, retriable: false };
  }

  /** `expiresAt`/`expiresIn`-tolerant TTL extraction: prefers an explicit
   *  absolute expiry (epoch seconds/ms or ISO string) when the response
   *  supplies one, falls back to a relative `expiresIn` (seconds), and
   *  finally to the documented ~1h default when the response omits both. */
  private computeExpiresAt(body: any): number {
    const absRaw = pick(body, ['expiresAt', 'expires_at', 'ExpiresAt']);
    if (absRaw != null) {
      const n = Number(absRaw);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
      const parsed = Date.parse(String(absRaw));
      if (!Number.isNaN(parsed)) return parsed;
    }
    const ttlRaw = pick(body, ['expiresIn', 'expires_in', 'expiresInSeconds', 'ttl', 'ExpiresIn']);
    const seconds = ttlRaw != null ? Number(ttlRaw) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
    return Date.now() + DEFAULT_TOKEN_TTL_MS;
  }

  private budgetDeniedMessage(): string {
    return 'Netasistan hız limiti (dakikada 60 istek) doldu — kısa bir süre sonra yeniden deneyin.';
  }

  /** Scrub both cred values out of a thrown transport error's message before
   *  it's ever logged — a timeout/DNS error can echo the request verbatim. */
  private scrubKeys(e: any, appKey: string, userKey: string): string {
    return String(e?.message ?? e).split(userKey).join('***').split(appKey).join('***');
  }

  /** Same scrub, for the bearer token used on break/queue calls. */
  private scrubToken(e: any, token: string): string {
    return String(e?.message ?? e).split(token).join('***');
  }
}

function pick(o: any, keys: string[]): any {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
}
