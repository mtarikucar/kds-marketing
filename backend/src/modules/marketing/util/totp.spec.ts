import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotp,
  base32Decode,
  base32Encode,
} from './totp';

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('hello world');
    expect(base32Decode(base32Encode(buf)).toString()).toBe('hello world');
  });

  it('verifies a freshly generated code', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const code = generateTotpCode(secret, at);
    expect(verifyTotp(secret, code, at)).toBe(true);
  });

  it('accepts a code from the adjacent step (clock skew window)', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const prev = generateTotpCode(secret, at - 30_000);
    expect(verifyTotp(secret, prev, at, 1)).toBe(true);
  });

  it('rejects a wrong code and malformed input', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const code = generateTotpCode(secret, at);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong, at)).toBe(false);
    expect(verifyTotp(secret, 'abc', at)).toBe(false);
    expect(verifyTotp(secret, '', at)).toBe(false);
  });

  it('is stable for the RFC test secret', () => {
    // Same secret + same time window must always yield the same 6-digit code.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const at = 1_700_000_000_000;
    expect(generateTotpCode(secret, at)).toMatch(/^\d{6}$/);
    expect(generateTotpCode(secret, at)).toBe(generateTotpCode(secret, at));
  });
});
