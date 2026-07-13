import { createHmac, createHash, randomBytes } from 'crypto';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';

/**
 * Epic F — dependency-free TOTP (RFC 6238) for 2FA. SHA-1, 6 digits, 30s period
 * (the authenticator-app default). Base32 secrets; ±1 step verification window.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Seal a TOTP shared secret for at-rest storage with the AES-256-GCM secret-box
 * (the seed mints valid OTPs, so it must not sit in plaintext — every peer
 * credential is sealed). Falls back to plaintext only when the secret-box is
 * unconfigured (dev); MARKETING_SECRET_KEY is required in production.
 */
export function sealTotpSecret(secret: string): string {
  return isSecretBoxConfigured() ? sealSecret(secret) : secret;
}

/**
 * Open a stored TOTP secret. New rows are sealed (`v1:...`); rows enrolled
 * before this hardening are plaintext base32 — read both so existing 2FA users
 * keep working (and re-seal opportunistically on the next write).
 */
export function openTotpSecret(stored: string): string {
  if (stored.startsWith('v1:')) {
    try {
      return openSecret(stored);
    } catch {
      return stored;
    }
  }
  return stored;
}

export function totpUri(secret: string, label: string, issuer = 'kds-marketing'): string {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(label)}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function generateTotpCode(secret: string, atMs: number = Date.now()): string {
  return hotp(secret, Math.floor(atMs / 1000 / 30));
}

/**
 * Verify a TOTP token and return the matched 30-second time-step (counter), or
 * -1 if it matches no step in the ±window. The step is the RFC 6238 §5.2 replay
 * key: a verifier that grants a session should record it and reject any code
 * whose step is not strictly newer, so a captured code can't be replayed within
 * its (up to ~90s) validity window.
 */
export function verifyTotpStep(
  secret: string,
  token: string,
  atMs: number = Date.now(),
  window = 1,
): number {
  if (!/^\d{6}$/.test(token || '')) return -1;
  const counter = Math.floor(atMs / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === token) return counter + w;
  }
  return -1;
}

export function verifyTotp(
  secret: string,
  token: string,
  atMs: number = Date.now(),
  window = 1,
): boolean {
  return verifyTotpStep(secret, token, atMs, window) >= 0;
}

export function generateBackupCodes(n = 10): string[] {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex'));
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
