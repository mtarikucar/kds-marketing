import {
  sealSecret,
  openSecret,
  maskSecret,
  isSecretBoxConfigured,
} from './secret-box.helper';

describe('secret-box helper (AES-256-GCM)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
    // reset module-cached key between cases that swap keys
    jest.resetModules();
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('round-trips a secret', () => {
    const sealed = sealSecret('wa-token-12345');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('wa-token-12345');
    expect(openSecret(sealed)).toBe('wa-token-12345');
  });

  it('produces a fresh IV each call (no deterministic ciphertext)', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const sealed = sealSecret('secret');
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => openSecret(parts.join(':'))).toThrow();
  });

  it('rejects an unknown version prefix', () => {
    const sealed = sealSecret('secret').replace(/^v1:/, 'v9:');
    expect(() => openSecret(sealed)).toThrow(/version/i);
  });

  it('throws on a wrong-length key', () => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(16).toString('base64');
    const { sealSecret: seal } = require('./secret-box.helper');
    expect(() => seal('x')).toThrow(/32 bytes/);
  });

  it('isSecretBoxConfigured reflects env presence', () => {
    expect(isSecretBoxConfigured()).toBe(true);
    delete process.env.MARKETING_SECRET_KEY;
    const { isSecretBoxConfigured: check } = require('./secret-box.helper');
    expect(check()).toBe(false);
  });

  it('maskSecret reveals only the tail', () => {
    expect(maskSecret('sk_live_abcd1234')).toBe('••••1234');
    expect(maskSecret('ab')).toBe('••');
    expect(maskSecret(null)).toBe('');
  });
});
