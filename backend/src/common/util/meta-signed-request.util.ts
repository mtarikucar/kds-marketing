import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta `signed_request` verifier.
 *
 * Meta POSTs its **Data Deletion Request Callback** as a single form field,
 * `signed_request`, shaped `<base64url signature>.<base64url JSON payload>`.
 * The signature is `HMAC-SHA256(app secret, <the base64url payload STRING>)` —
 * over the still-encoded payload, NOT over the decoded JSON and NOT over the
 * whole `sig.payload` string. Getting that wrong makes every genuine request
 * look forged (and, worse, invites someone to "fix" it by not verifying).
 *
 * The decoded payload carries `{ algorithm, issued_at, user_id }` (and
 * sometimes `expires`). `user_id` is a **platform-scoped** id — see
 * PlatformDataDeletionService for what that means for resolution.
 *
 * This verification IS the security of the endpoint: the callback is public and
 * unauthenticated, so anything that fails here must be refused, never processed.
 * Returns a result object rather than throwing — the caller decides the HTTP
 * shape — and NEVER puts the request, the payload or the user id in its reason.
 */

/** Refuse a request older than this. Guards replay of a captured callback. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type MetaSignedRequestRefusal =
  | 'not_configured'
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'expired';

/**
 * A FLAT result, not a discriminated union — the same reason meta-graph.util's
 * MetaGraphResult is flat: this project sets `strictNullChecks: false`, under
 * which TypeScript does NOT narrow `{ok:true}|{ok:false}` through `if (!r.ok)`,
 * so a union here makes `r.reason` a compile error at every call site. `userId`
 * is set iff `ok`; `reason` is set iff not.
 */
export interface MetaSignedRequestResult {
  ok: boolean;
  userId: string | null;
  reason: MetaSignedRequestRefusal | null;
}

const refuse = (reason: MetaSignedRequestRefusal): MetaSignedRequestResult => ({
  ok: false,
  userId: null,
  reason,
});

export function parseMetaSignedRequest(
  signedRequest: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MetaSignedRequestResult {
  const secret = process.env.META_APP_SECRET;
  // An app with no configured secret cannot verify anything, so it must not
  // accept a deletion request either — "no secret" is not "any signature".
  if (!secret) return refuse('not_configured');
  if (typeof signedRequest !== 'string' || !signedRequest.includes('.')) {
    return refuse('malformed');
  }

  const dot = signedRequest.indexOf('.');
  const encodedSig = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);
  if (!encodedSig || !encodedPayload) return refuse('malformed');

  let payload: Record<string, unknown>;
  try {
    const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return refuse('malformed');
  }
  if (!payload || typeof payload !== 'object') return refuse('malformed');

  // Reject the algorithm BEFORE comparing: `algorithm: "none"` is the classic
  // downgrade, and answering "bad_signature" to it hides what was attempted.
  if (String(payload.algorithm ?? '').toUpperCase() !== 'HMAC-SHA256') {
    return refuse('bad_algorithm');
  }

  const expected = createHmac('sha256', secret).update(encodedPayload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(encodedSig, 'base64url');
  } catch {
    return refuse('bad_signature');
  }
  // Length check first — timingSafeEqual throws on a length mismatch.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse('bad_signature');
  }

  const userId = payload.user_id;
  if (typeof userId !== 'string' || !userId.trim()) return refuse('malformed');

  // Only an OLD request is refused. A slightly-future `issued_at` is clock skew
  // between Meta and us, not an attack, and refusing it would fail genuine
  // callbacks (which Meta's App Review reads as a broken endpoint).
  const issuedAt = Number(payload.issued_at);
  if (Number.isFinite(issuedAt) && nowSeconds - issuedAt > MAX_AGE_SECONDS) {
    return refuse('expired');
  }
  const expires = Number(payload.expires);
  if (Number.isFinite(expires) && expires > 0 && expires < nowSeconds) {
    return refuse('expired');
  }

  return { ok: true, userId: userId.trim(), reason: null };
}
