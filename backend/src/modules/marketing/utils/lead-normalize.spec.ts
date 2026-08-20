import { normalizePhone, normalizeEmail, localMsisdnVariants, toIysMsisdn, toE164, phoneIdentityVariants } from './lead-normalize';

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

/**
 * The canonical CHANNEL address form. Distinct from normalizePhone, which is a
 * lead MATCH KEY and deliberately preserves whatever shape arrived. Conflating
 * the two is what let an outbound thread be opened on "05551112233" while
 * inbound wrote "+905551112233", so the customer's reply forked into a second
 * lead.
 */
describe('toE164', () => {
  it('reduces every Turkish spelling to one form', () => {
    for (const raw of ['05551112233', '5551112233', '905551112233', '+905551112233', '0555 111 22 33', '00905551112233']) {
      expect(toE164(raw)).toBe('+905551112233');
    }
  });

  it('keeps a foreign number rather than refusing it', () => {
    // Unlike toIysMsisdn, a channel address may legitimately be non-TR —
    // refusing would put us straight back to mixed spellings.
    expect(toE164('+49 30 123456')).toBe('+4930123456');
  });

  it('is null for input with no digits', () => {
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164('abc')).toBeNull();
  });
});

describe('phoneIdentityVariants', () => {
  it('covers every spelling an identity may already be stored under', () => {
    expect(phoneIdentityVariants('+905551112233').sort()).toEqual(
      ['+05551112233', '+5551112233', '+905551112233', '05551112233', '5551112233', '905551112233'].sort(),
    );
  });

  it('reaches the same set from any input spelling', () => {
    const a = phoneIdentityVariants('05551112233').sort();
    const b = phoneIdentityVariants('+90 555 111 22 33').sort();
    expect(a).toEqual(b);
  });

  it('is empty for input with no digits, so a lookup is skipped rather than matching everything', () => {
    expect(phoneIdentityVariants('')).toEqual([]);
    expect(phoneIdentityVariants(null)).toEqual([]);
  });
});
