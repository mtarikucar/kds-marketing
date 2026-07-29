import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Secret handling for the authorization server — one implementation shared by
 * the code service (Task 4), the token service (Task 5) and the MCP token
 * verifier (Task 6), so "hashed at rest" cannot drift between them.
 */

/**
 * SHA-256, hex. Byte-for-byte the convention `ApiKeysService.hash()` already
 * uses for `ApiKey.keyHash`, so `McpOAuthCode.codeHash` / `McpOAuthToken.
 * tokenHash` are stored exactly the same way as every other credential here.
 *
 * A plain (unsalted, un-stretched) digest is correct for these values and only
 * these: they are 256 bits of CSPRNG output, not human-chosen passwords, so
 * there is nothing to brute-force and nothing a rainbow table can precompute.
 * The digest is what makes the lookup an indexed equality match while a
 * database leak yields no usable credential.
 */
export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 256 bits of CSPRNG output, URL-safe — the raw form of every secret we mint. */
export function newSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/**
 * RFC 7636 §4.6: `BASE64URL(SHA256(ASCII(code_verifier)))`, unpadded. `plain`
 * is deliberately not implemented — see the authorize endpoint, which refuses
 * any `code_challenge_method` other than `S256`.
 */
export function pkceS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * Constant-time string compare for secret-derived values. `===` on a digest
 * leaks its matching prefix length through timing; over enough attempts that is
 * enough to reconstruct the expected value byte by byte.
 */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // (coarse) leak — but length is public for fixed-width digests, so compare
  // only equal-length inputs and reject the rest.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
