import { createHmac, createHash, randomBytes } from 'crypto';

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

export function verifyTotp(
  secret: string,
  token: string,
  atMs: number = Date.now(),
  window = 1,
): boolean {
  if (!/^\d{6}$/.test(token || '')) return false;
  const counter = Math.floor(atMs / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === token) return true;
  }
  return false;
}

export function generateBackupCodes(n = 10): string[] {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex'));
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
