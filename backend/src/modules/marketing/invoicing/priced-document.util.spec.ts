import { formatDocumentDate, formatMinorAmount, isQuoteExpired } from './priced-document.util';

describe('isQuoteExpired', () => {
  const NOW = new Date('2026-09-30T08:00:00.000Z');

  // `<input type="date">` posts "2026-09-30", which becomes 2026-09-30T00:00:00Z.
  // A strict `validUntil < now` would call a quote "valid until 30 September"
  // expired for the whole of 30 September — the common "valid through Friday,
  // sent Friday" case.
  it('is still valid on the last stated day, whatever the hour', () => {
    expect(isQuoteExpired(new Date('2026-09-30T00:00:00.000Z'), NOW)).toBe(false);
    expect(isQuoteExpired(new Date('2026-09-30T23:59:59.000Z'), NOW)).toBe(false);
  });

  it('is expired the moment the next UTC day begins', () => {
    expect(isQuoteExpired(new Date('2026-09-29T00:00:00.000Z'), NOW)).toBe(true);
    expect(isQuoteExpired(new Date('2026-09-29T23:00:00.000Z'), NOW)).toBe(true);
  });

  it('never expires without a date — a null must not read as 1970', () => {
    expect(isQuoteExpired(null, NOW)).toBe(false);
    expect(isQuoteExpired(undefined, NOW)).toBe(false);
    expect(isQuoteExpired(new Date('not a date'), NOW)).toBe(false);
  });

  it('accepts the ISO string a JSON round-trip leaves behind', () => {
    expect(isQuoteExpired('2026-09-29T00:00:00.000Z', NOW)).toBe(true);
    expect(isQuoteExpired('2026-10-01T00:00:00.000Z', NOW)).toBe(false);
  });

  it('defaults to now when no clock is passed', () => {
    expect(isQuoteExpired(new Date(Date.now() - 86_400_000 * 2))).toBe(true);
    expect(isQuoteExpired(new Date(Date.now() + 86_400_000))).toBe(false);
  });
});

describe('formatMinorAmount', () => {
  // Minor units are the column; a mail that renders ₺1.250,50 as "125050 TRY"
  // is the one thing a customer notices immediately.
  it('renders minor units as major, always with two decimals', () => {
    expect(formatMinorAmount(125050, 'TRY', 'en')).toBe('1,250.50 TRY');
    expect(formatMinorAmount(5000, 'TRY', 'en')).toBe('50.00 TRY');
    expect(formatMinorAmount(5, 'USD', 'en')).toBe('0.05 USD');
  });

  it('uses the Turkish separators for a Turkish workspace', () => {
    expect(formatMinorAmount(125050, 'TRY', 'tr')).toBe('1.250,50 TRY');
    expect(formatMinorAmount(100000000, 'TRY', 'tr')).toBe('1.000.000,00 TRY');
  });

  it('falls back to TRY, the column default, when no currency is stored', () => {
    expect(formatMinorAmount(5000, null, 'en')).toBe('50.00 TRY');
  });

  it('says nothing rather than "NaN" when there is no amount', () => {
    expect(formatMinorAmount(null, 'TRY', 'en')).toBe('');
    expect(formatMinorAmount(undefined, 'TRY', 'en')).toBe('');
    expect(formatMinorAmount(Number.NaN, 'TRY', 'en')).toBe('');
  });
});

describe('formatDocumentDate', () => {
  it('reads as a date in the recipient language', () => {
    expect(formatDocumentDate(new Date('2026-09-30T00:00:00.000Z'), 'tr')).toBe('30.09.2026');
    expect(formatDocumentDate(new Date('2026-09-30T00:00:00.000Z'), 'en')).toBe('2026-09-30');
  });

  // Date-only columns are stored at UTC midnight; formatting them in the
  // server's local zone moves "30 September" to the 29th west of Greenwich.
  it('reads the stored day in UTC, not in the server zone', () => {
    expect(formatDocumentDate('2026-01-01T00:00:00.000Z', 'tr')).toBe('01.01.2026');
  });

  it('says nothing for a missing or unparsable date', () => {
    expect(formatDocumentDate(null, 'tr')).toBe('');
    expect(formatDocumentDate(undefined, 'en')).toBe('');
    expect(formatDocumentDate(new Date('nope'), 'en')).toBe('');
  });
});
