import { maskEmail, maskIp, maskPhone } from './pii-mask.helper';

describe('maskEmail', () => {
  it('masks the local part keeping first character and domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('bob.smith@host.com')).toBe('b***@host.com');
  });

  it('fully masks single-character local parts', () => {
    // Keeping the first char would leak the whole local part.
    expect(maskEmail('x@host.com')).toBe('*@host.com');
  });

  it('returns *** for input without an @', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
  });

  it('returns *** when @ is the first character (no local part)', () => {
    expect(maskEmail('@host.com')).toBe('***');
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
  });

  it('preserves the full domain (so debugging different mail providers stays possible)', () => {
    expect(maskEmail('admin@example.com')).toBe('a***@example.com');
    expect(maskEmail('admin@gmail.com')).toBe('a***@gmail.com');
  });
});

describe('maskPhone', () => {
  it('masks TR numbers keeping +90 country code and last 2 digits', () => {
    expect(maskPhone('+905551112233')).toBe('+90****33');
  });

  it('masks US-style numbers keeping +1 country code', () => {
    // +1 has 1-digit country code, but our cheap rule keeps "+1" only when
    // the prefix is "+9"; otherwise it keeps the first 2 chars "+1".
    expect(maskPhone('+15551112233')).toBe('+1****33');
  });

  it('masks numbers without leading + with no country-code segment', () => {
    expect(maskPhone('5551112233')).toBe('***33');
  });

  it('fully masks too-short inputs', () => {
    expect(maskPhone('abc')).toBe('***');
    expect(maskPhone('12')).toBe('***');
  });

  it('returns empty for null / undefined / empty', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });

  it('trims surrounding whitespace before masking', () => {
    expect(maskPhone('  +905551112233  ')).toBe('+90****33');
  });
});

describe('maskIp', () => {
  it('truncates IPv4 to first two octets', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.x.x');
    expect(maskIp('192.168.1.1')).toBe('192.168.x.x');
  });

  it('truncates IPv6 to first two hextets', () => {
    expect(maskIp('2001:db8::1')).toBe('2001:db8:x:x');
    // 8-segment fully-expanded form
    expect(maskIp('2001:db8:0:0:0:0:0:1')).toBe('2001:db8:x:x:x:x:x:x');
  });

  it('preserves loopback addresses verbatim (not PII, useful in dev)', () => {
    expect(maskIp('127.0.0.1')).toBe('127.0.0.1');
    expect(maskIp('::1')).toBe('::1');
  });

  it('returns malformed input as-is rather than guessing', () => {
    expect(maskIp('unknown')).toBe('unknown');
    expect(maskIp('203.0.113')).toBe('203.0.113'); // only 3 octets
  });

  it('returns empty for null / undefined / empty', () => {
    expect(maskIp('')).toBe('');
    expect(maskIp(null)).toBe('');
    expect(maskIp(undefined)).toBe('');
  });
});
