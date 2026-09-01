import { validate } from 'class-validator';
import { isIanaTimeZone, IsIanaTimeZone } from './iana-timezone';

class Holder {
  @IsIanaTimeZone()
  timezone!: string;
}

async function errorsFor(value: unknown): Promise<string[]> {
  const h = new Holder();
  (h as unknown as Record<string, unknown>).timezone = value;
  const res = await validate(h);
  return res.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('isIanaTimeZone', () => {
  it('accepts the zones a browser and an operator actually produce', () => {
    // Two-segment, three-segment, the schema default, and a LINK name that
    // `Intl.supportedValuesOf('timeZone')` deliberately omits — a signup from a
    // machine that still reports 'Asia/Calcutta' must not 400.
    for (const zone of [
      'Europe/Istanbul',
      'America/New_York',
      'Asia/Tokyo',
      'America/Argentina/Buenos_Aires',
      'Asia/Calcutta',
      'UTC',
      'Etc/GMT+5',
    ]) {
      expect(isIanaTimeZone(zone)).toBe(true);
    }
  });

  it('rejects a fixed OFFSET, which is a fact about a moment and not about a place', () => {
    // The whole reason the column exists is to answer "when does this
    // workspace's day start" across a DST transition. An offset cannot, and
    // stored here it would freeze the business at whichever offset was in force
    // the day it signed up.
    for (const offset of ['+03:00', '-05:00', 'GMT+3', 'UTC+3', '03:00']) {
      expect(isIanaTimeZone(offset)).toBe(false);
    }
  });

  it('rejects nonsense, wrong types and unbounded strings', () => {
    expect(isIanaTimeZone('Not/AZone')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone('   ')).toBe(false);
    expect(isIanaTimeZone(undefined)).toBe(false);
    expect(isIanaTimeZone(null)).toBe(false);
    expect(isIanaTimeZone(42)).toBe(false);
    expect(isIanaTimeZone({ timeZone: 'UTC' })).toBe(false);
    expect(isIanaTimeZone(`Europe/${'x'.repeat(200)}`)).toBe(false);
  });
});

describe('@IsIanaTimeZone', () => {
  it('passes a real zone and fails a bogus one with a message that names the shape', async () => {
    expect(await errorsFor('Europe/Istanbul')).toEqual([]);
    const errors = await errorsFor('Mars/Olympus_Mons');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('IANA time zone');
  });
});
