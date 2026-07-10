import { describe, it, expect } from 'vitest';
import {
  isGsm7,
  smsSegments,
  NETGSM_HEADER_OVERHEAD_CHARS,
  CAMPAIGN_UNSUBSCRIBE_FOOTER_CHARS,
  CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS,
} from './smsSegments';

// Mirrors backend/src/modules/marketing/wallet/sms-segments.util.spec.ts —
// the two must never drift apart (same alphabet, same thresholds).
describe('smsSegments (frontend port)', () => {
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

  describe('reservedSuffixChars', () => {
    it('defaults to the raw backend math when omitted', () => {
      expect(smsSegments('a'.repeat(160))).toBe(1);
      expect(smsSegments('a'.repeat(160), {})).toBe(1);
      expect(smsSegments('a'.repeat(161), {})).toBe(2);
    });

    it('shrinks the GSM-7 single-segment cap by the reserved amount', () => {
      expect(smsSegments('a'.repeat(155), { reservedSuffixChars: 5 })).toBe(1);
      expect(smsSegments('a'.repeat(156), { reservedSuffixChars: 5 })).toBe(2);
    });

    it('shrinks the GSM-7 multi-segment cap by the reserved amount too', () => {
      // 148 * 2 = 296 chars still fits in 2 segments at reserved=5 (153-5=148)
      expect(smsSegments('a'.repeat(296), { reservedSuffixChars: 5 })).toBe(2);
      expect(smsSegments('a'.repeat(297), { reservedSuffixChars: 5 })).toBe(3);
    });

    it('applies the same reservation to the UCS-2 caps', () => {
      // 65 = 70-5 single-segment cap for a headed UCS-2 send
      expect(smsSegments('ç'.repeat(65), { reservedSuffixChars: 5 })).toBe(1);
      expect(smsSegments('ç'.repeat(66), { reservedSuffixChars: 5 })).toBe(2);
    });

    it('never collapses the cap below 1 char for a pathologically large reservation', () => {
      expect(smsSegments('a', { reservedSuffixChars: 999 })).toBe(1);
      expect(smsSegments('a'.repeat(3), { reservedSuffixChars: 999 })).toBe(3);
    });

    it('models the full campaign reservation (header overhead + unsubscribe footer)', () => {
      expect(CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS).toBe(
        NETGSM_HEADER_OVERHEAD_CHARS + CAMPAIGN_UNSUBSCRIBE_FOOTER_CHARS,
      );
      const cap = 160 - CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS;
      expect(smsSegments('a'.repeat(cap), { reservedSuffixChars: CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS })).toBe(1);
      expect(smsSegments('a'.repeat(cap + 1), { reservedSuffixChars: CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS })).toBe(2);
    });
  });
});
