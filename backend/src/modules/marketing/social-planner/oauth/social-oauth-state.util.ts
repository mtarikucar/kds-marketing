import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

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
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signState(
  data: { workspaceId: string; network: string },
  ttlMs: number = TTL_MS,
): string {
  const payload: StatePayload = {
    workspaceId: data.workspaceId,
    network: data.network,
    nonce: b64url(randomBytes(12)),
    exp: Date.now() + ttlMs,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', key()).update(body).digest());
  return `${body}.${sig}`;
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
