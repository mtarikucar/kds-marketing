import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/**
 * Symmetric secret sealing for at-rest channel/PSP credentials (WhatsApp
 * tokens, per-workspace Stripe keys, etc.). AES-256-GCM (authenticated —
 * tamper is detected on open). The master key comes from env
 * `MARKETING_SECRET_KEY` (32 bytes, base64). Output is self-describing:
 *
 *   v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * The `v1:` prefix is the rotation seam — a future `v2` (new key/algorithm)
 * can be decrypted by branching on the prefix while old ciphertext keeps
 * opening. These values live in dedicated columns, never in the
 * platform-PATCHable Workspace.settings, and API responses mask them.
 */

const VERSION = 'v1';
let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) {
    throw new Error('MARKETING_SECRET_KEY is not configured');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `MARKETING_SECRET_KEY must decode to 32 bytes (got ${key.length}) — generate with: openssl rand -base64 32`,
    );
  }
  cachedKey = key;
  return key;
}

/** True when a valid master key is present — lets callers degrade instead of throwing at boot. */
export function isSecretBoxConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12); // GCM standard nonce length
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function openSecret(sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('sealed secret is malformed or uses an unknown version');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Keyed HMAC-SHA256 pepper — one-way hash for low-entropy secrets (e.g. a
 * 6-digit OTP code, ~20 bits of entropy) where a plain unkeyed hash would be
 * offline brute-forceable straight from a leaked DB row (all 1e6 candidates
 * hash in well under a second). Keyed with the same master key as
 * sealSecret/openSecret, so a stolen hash column alone is not enough —
 * cracking it also requires MARKETING_SECRET_KEY. Callers should prefix
 * `data` with a purpose label (e.g. `"sms-otp-code:123456"`) for domain
 * separation, mirroring the netgsm callback/webhook token helpers.
 */
export function hmacHex(data: string): string {
  return createHmac('sha256', masterKey()).update(data).digest('hex');
}

/** Show only the last `visible` chars (e.g. for "•••• 1234" UI previews). */
export function maskSecret(plain: string | null | undefined, visible = 4): string {
  if (!plain) return '';
  if (plain.length <= visible) return '•'.repeat(plain.length);
  return '••••' + plain.slice(-visible);
}
