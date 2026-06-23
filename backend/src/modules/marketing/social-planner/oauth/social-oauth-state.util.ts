import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Signed, short-lived OAuth `state` for the social-connect flow. Carries the
 * workspace + network so the public callback can bind the returned token to the
 * right tenant without a server session, and is HMAC-signed (MARKETING_SECRET_KEY)
 * so it can't be forged or replayed past its TTL — CSRF-safe. Mirrors the HMAC
 * approach in netgsm-callback.util.
 */

const TTL_MS = 10 * 60 * 1000;

function key(): string {
  const k = process.env.MARKETING_SECRET_KEY;
  if (!k) throw new Error('MARKETING_SECRET_KEY not set');
  return k;
}

export interface StatePayload {
  workspaceId: string;
  network: string;
  nonce: string;
  exp: number;
  /** Sealed (AES-GCM) PKCE code_verifier — present only for PKCE networks (X).
   *  Sealed, not plaintext, so an interceptor who sees the redirect state can't
   *  recover the verifier and defeat PKCE's code-interception protection. */
  cv?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signState(
  data: { workspaceId: string; network: string; cv?: string },
  ttlMs: number = TTL_MS,
): string {
  const payload: StatePayload = {
    workspaceId: data.workspaceId,
    network: data.network,
    nonce: b64url(randomBytes(12)),
    exp: Date.now() + ttlMs,
    ...(data.cv ? { cv: data.cv } : {}),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', key()).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Generate a PKCE pair: a high-entropy `verifier` (43–128 chars per RFC 7636)
 * and its S256 `challenge` (base64url(SHA-256(verifier))). The verifier is kept
 * server-side (sealed into the OAuth state); only the challenge goes on the
 * authorize URL.
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 url-safe chars
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function verifyState(token: string): StatePayload | null {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = b64url(createHmac('sha256', key()).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(body).toString()) as StatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!payload.workspaceId || !payload.network) return null;
    return payload;
  } catch {
    return null;
  }
}
