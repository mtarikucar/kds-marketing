import { createHmac } from 'crypto';
import { constantTimeEquals } from '../channels/inbound/webhook-verifier';

/**
 * Order webhook signature v1 (contract §1.2):
 *
 *   signature = hex(HMAC_SHA256(sourceSecret, `${timestamp}.${rawBody}`))
 *   header    = "v1=" + signature            (several, comma-separated, allowed)
 *
 * The timestamp is inside the MAC, so it cannot be moved without the key, and a
 * request is only accepted within ±5 minutes of it. The inbound verifiers'
 * 24-hour window is right for ESP feedback and far too wide for orders.
 *
 * Freshness is judged only AFTER the signature checks out: an unauthenticated
 * caller learns "bad signature" whatever its clock says.
 */
export const COMMERCE_SIGNATURE_MAX_AGE_MS = 300_000;

export type CommerceSignatureCode = 'BAD_SIGNATURE' | 'STALE_TIMESTAMP';

export function signCommercePayload(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

export function verifyCommerceSignature(input: {
  rawBody: Buffer;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  /** Current secret first, then the previous one while its rotation window is open. */
  secrets: string[];
  now?: number;
}): { ok: true } | { ok: false; code: CommerceSignatureCode } {
  const { rawBody, timestamp, signatureHeader, secrets } = input;
  const bad = { ok: false as const, code: 'BAD_SIGNATURE' as const };
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatureHeader) return bad;

  const offered = signatureHeader
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3).toLowerCase())
    .filter((sig) => /^[0-9a-f]{64}$/.test(sig));
  if (offered.length === 0 || secrets.length === 0) return bad;

  const authentic = secrets.some((secret) => {
    const expected = signCommercePayload(secret, timestamp, rawBody);
    return offered.some((sig) => constantTimeEquals(sig, expected));
  });
  if (!authentic) return bad;

  const now = input.now ?? Date.now();
  if (Math.abs(now - Number(timestamp) * 1000) > COMMERCE_SIGNATURE_MAX_AGE_MS) {
    return { ok: false, code: 'STALE_TIMESTAMP' };
  }
  return { ok: true };
}
