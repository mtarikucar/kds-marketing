import { isGsm7, smsSegments } from './sms-segments.util';

describe('sms-segments', () => {
  it('detects GSM-7 vs UCS-2', () => {
    expect(isGsm7('Hello, GHL parity!')).toBe(true);
    expect(isGsm7('Fiyat: 30 TL')).toBe(true);
    expect(isGsm7('Merhaba dünya çğİş')).toBe(false); // Turkish ç ğ İ ş are not GSM-7 basic
    expect(isGsm7('emoji 🎉')).toBe(false);
  });

  it('counts one segment for short GSM-7 and empty text', () => {
    expect(smsSegments('')).toBe(1);
    expect(smsSegments('short')).toBe(1);
    expect(smsSegments('a'.repeat(160))).toBe(1);
  });

  it('splits GSM-7 into 153-char segments past 160', () => {
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2); // 2 * 153
    expect(smsSegments('a'.repeat(307))).toBe(3);
  });

  it('charges extended GSM-7 characters as two septets', () => {
    // 159 basic + 1 extended (€ = 2 septets) = 161 septets -> 2 segments
    expect(smsSegments('a'.repeat(159) + '€')).toBe(2);
  });

  it('uses 70/67-char segments for UCS-2 (non-GSM-7) text', () => {
    expect(smsSegments('ç')).toBe(1);
    expect(smsSegments('ç'.repeat(70))).toBe(1);
    expect(smsSegments('ç'.repeat(71))).toBe(2);
    expect(smsSegments('ç'.repeat(134))).toBe(2); // 2 * 67
    expect(smsSegments('ç'.repeat(135))).toBe(3);
  });
});
