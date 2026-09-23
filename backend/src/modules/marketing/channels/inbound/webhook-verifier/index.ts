import { timingSafeEqual } from 'crypto';
import { genericHmacVerifier } from './generic-hmac';
import { mailgunVerifier } from './mailgun';
import { postmarkVerifier } from './postmark';
import { sendgridVerifier } from './sendgrid';

/**
 * Who signed this webhook, and did they really?
 *
 * ## Why a registry instead of one HMAC
 *
 * The single `x-esp-signature` HMAC this path shipped with is a shape no real
 * ESP produces: SendGrid signs with ECDSA, Mailgun puts its signature in the
 * BODY, Postmark offers basic auth and nothing else (`esp-feedback-auth`). An
 * operator who wired any of them up got 401 on every event, so bounce and
 * complaint suppression stayed dead while looking configured.
 *
 * ## The provider comes from the URL, never from the payload
 *
 * `POST /api/public/esp/feedback/:provider` picks the verifier BEFORE a single
 * attacker-controlled byte is parsed. Sniffing the body for "which ESP is this"
 * would mean choosing the verification rule from the very data being verified —
 * an attacker would simply post the shape whose secret is unset. An unknown
 * provider resolves to nothing at all; there is no fallback verifier.
 *
 * ## Every verifier is individually inert
 *
 * `configured()` is false until ITS operator secret is set, and `verify()` then
 * answers `NOT_CONFIGURED` rather than accepting or throwing. That is what lets
 * this whole path ship dark: nothing here can suppress an address until a human
 * pastes a key, and `espVerifierStatus()` names the key that is missing so the
 * UI can say so out loud instead of failing quietly (PLAN G6).
 */

export const ESP_PROVIDERS = ['sendgrid', 'mailgun', 'postmark', 'generic'] as const;
export type EspProvider = (typeof ESP_PROVIDERS)[number];

/** What a verifier is handed: the EXACT bytes that were signed, plus the envelope. */
export interface WebhookRequest {
  /** The raw body as received. Re-serialised JSON never verifies. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Peer address, for the providers that publish a fixed egress range. */
  ip?: string;
}

export type VerifyFailure =
  /** This provider's operator secret is unset — the path is dark, not broken. */
  | 'NOT_CONFIGURED'
  /** A signature/credential was present and wrong. */
  | 'BAD_SIGNATURE'
  /** Correctly signed, but far enough in the past to be a replay. */
  | 'STALE_TIMESTAMP'
  /** The envelope the signature lives in could not be read at all. */
  | 'MALFORMED';

/** One shape, not a discriminated union: this project compiles with
 *  `strictNullChecks: false`, where narrowing on a boolean discriminant does not
 *  hold, and `MailReceipt` already sets the house precedent (`ok` + optional
 *  `reason`). */
export interface VerifyOutcome {
  ok: boolean;
  /** Set whenever `ok` is false. Machine code; never printed raw at a user. */
  reason?: VerifyFailure;
  /**
   * A single-use token the signature covers INSTEAD of the body.
   *
   * Only Mailgun sets it, and only because its signature is over
   * `timestamp + token`: the payload is unsigned, so nothing but the token
   * distinguishes one accepted request from another. The caller spends it
   * through `WebhookReplayStore`, which is what turns "one captured block, any
   * body, for 24 hours" back into "one token, one body".
   *
   * A verifier that signs the raw body (sendgrid, generic-hmac) leaves this
   * unset: for those a replay necessarily carries identical bytes, and the
   * writes behind this path are idempotent.
   */
  replayToken?: string;
}

export interface WebhookVerifier {
  readonly provider: EspProvider;
  /** The env keys an operator must set. Surfaced verbatim by the health view. */
  readonly requires: readonly string[];
  configured(): boolean;
  /** Never throws — a malformed request is an answer, not an exception (G2). */
  verify(req: WebhookRequest): VerifyOutcome;
}

/**
 * How old a signed timestamp may be.
 *
 * Deliberately a whole day rather than the couple of minutes a replay-window
 * guide would suggest: Mailgun retries a failed webhook for 8 hours and
 * SendGrid for 24, both REPLAYING the original signed payload, so a tight
 * window would turn one bad deploy into permanently lost bounce events — the
 * exact failure this package exists to end.
 *
 * What that window costs depends on WHAT was signed. For `sendgrid` (ECDSA
 * over `timestamp || rawBody`) and `generic-hmac` (HMAC over `rawBody`) a
 * replay necessarily carries the same bytes, so it re-applies a suppression
 * already on file and `EspFeedbackService` is idempotent. For `mailgun` the
 * body is NOT signed, so a captured block would authenticate any payload for a
 * whole day — that one is bounded by `WebhookReplayStore` instead, which spends
 * the token on one specific body.
 */
export const SIGNATURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a provider clock that runs ahead of ours. */
export const SIGNATURE_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** First value of a header, lower-cased key, arrays collapsed (a duplicated
 *  header must never merge an attacker's copy into the genuine one). */
export function header(req: WebhookRequest, name: string): string | undefined {
  const v = req.headers?.[name.toLowerCase()];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return undefined;
}

/** Length-safe, constant-time string compare. Never throws. */
export function constantTimeEquals(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/** Unix-seconds freshness, per SIGNATURE_MAX_AGE_MS. */
export function timestampFresh(unixSeconds: string, now = Date.now()): boolean {
  const ts = Number(unixSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const deltaMs = now - ts * 1000;
  return deltaMs <= SIGNATURE_MAX_AGE_MS && deltaMs >= -SIGNATURE_FUTURE_SKEW_MS;
}

const REGISTRY: Record<EspProvider, WebhookVerifier> = {
  sendgrid: sendgridVerifier,
  mailgun: mailgunVerifier,
  postmark: postmarkVerifier,
  generic: genericHmacVerifier,
};

/** The verifier for a URL segment, or null — there is no default. */
export function getVerifier(provider: string | undefined | null): WebhookVerifier | null {
  const key = String(provider ?? '').trim().toLowerCase();
  return (ESP_PROVIDERS as readonly string[]).includes(key) ? REGISTRY[key as EspProvider] : null;
}

/** Every env key any feedback verifier can need, generic relay first. The
 *  deploy parity guard derives the keys it forwards from `requires` directly;
 *  this is the flattened view for a panel that has to name the whole menu. */
export const ESP_FEEDBACK_ENV_KEYS: readonly string[] = [
  ...new Set(ESP_PROVIDERS.flatMap((p) => [...REGISTRY[p].requires])),
];

/** Set, and not the empty string an unset deploy Secret renders as. */
function present(env: Record<string, string | undefined>, key: string): boolean {
  return !!(env[key] ?? '').trim();
}

/**
 * Which of a verifier's keys are still unset, in `requires` order.
 *
 * Derived from `requires` rather than by asking `configured()`, so a caller
 * already answering "what is inert on THIS deployment" from an explicit env bag
 * — the mail-health panel and its spec — gets the same answer without mutating
 * `process.env`. The spec pins the two in agreement for every provider, so
 * `requires` cannot drift into a list that documents a gate it does not open.
 */
export function verifierMissing(
  v: WebhookVerifier,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return v.requires.filter((k) => !present(env, k));
}

/** Armed exactly when nothing it requires is missing. A verifier with an empty
 *  `requires` would otherwise read as armed for free — it cannot exist here,
 *  and must not be invented by this helper either. */
export function verifierConfigured(
  v: WebhookVerifier,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return v.requires.length > 0 && verifierMissing(v, env).length === 0;
}

export interface EspVerifierStatus {
  provider: EspProvider;
  configured: boolean;
  requires: readonly string[];
  /** The subset still unset. Only key NAMES — a value never leaves this file. */
  missing: string[];
}

/** "Which feedback providers are actually armed?" — for the ops/health view. */
export function espVerifierStatus(
  env: Record<string, string | undefined> = process.env,
): EspVerifierStatus[] {
  return ESP_PROVIDERS.map((provider) => ({
    provider,
    configured: verifierConfigured(REGISTRY[provider], env),
    requires: REGISTRY[provider].requires,
    missing: verifierMissing(REGISTRY[provider], env),
  }));
}
