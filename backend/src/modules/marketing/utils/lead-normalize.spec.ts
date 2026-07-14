import {
  normalizePhone,
  normalizeEmail,
  localMsisdnVariants,
  toIysMsisdn,
} from './lead-normalize';

const LOCAL = '5551112233'; // bare 10-digit
const ZERO = '05551112233'; // 0-prefixed 11-digit
const CC = '905551112233'; // 90-prefixed 12-digit (E.164 digits, no +)
const INTL = '00905551112233'; // 00 international-access-prefixed 14-digit

describe('normalizePhone / normalizeEmail', () => {
  it('strips non-digits to a bare digit key', () => {
    expect(normalizePhone('+90 (555) 111-22-33')).toBe('905551112233');
    expect(normalizePhone('0555 111 22 33')).toBe('05551112233');
  });
  it('returns null for empty/blank', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it('lowercases + trims email', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeEmail('')).toBeNull();
  });
});

describe('toIysMsisdn — reduce any TR mobile spelling to 90+local, else null (fail-closed)', () => {
  it.each([LOCAL, ZERO, CC, '+90 555 111 22 33', '0555-111-22-33'])(
    'reduces standard spelling %s → 905551112233',
    (raw) => expect(toIysMsisdn(raw)).toBe(CC),
  );

  it('reduces the 00 international-access prefix too (00·90·local → 90·local)', () => {
    expect(toIysMsisdn(INTL)).toBe(CC);
  });

  it('returns null for landline / foreign / garbage (never forwarded to İYS)', () => {
    expect(toIysMsisdn('02121112233')).toBeNull(); // İstanbul landline (post-strip starts 2)
    expect(toIysMsisdn('001 202 555 0100')).toBeNull(); // US number
    expect(toIysMsisdn('')).toBeNull();
    expect(toIysMsisdn(null)).toBeNull();
  });
});

describe('localMsisdnVariants — enumerate every stored spelling of one number', () => {
  it.each([LOCAL, ZERO, CC])(
    'from %s enumerates all three spellings',
    (input) => expect(localMsisdnVariants(input).sort()).toEqual([LOCAL, ZERO, CC].sort()),
  );

  it('reduces a 00-prefixed value to the same three spellings (dedup/lookup no longer misses it)', () => {
    expect(localMsisdnVariants(INTL).sort()).toEqual([LOCAL, ZERO, CC].sort());
  });

  it('returns the input unchanged when it is not a recognizable TR mobile', () => {
    expect(localMsisdnVariants('12345')).toEqual(['12345']);
  });
});
