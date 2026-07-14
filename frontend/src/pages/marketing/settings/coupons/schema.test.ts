import { describe, it, expect } from 'vitest';
import { schema } from './index';

// A PERCENT coupon value must be 1–100 (mirrors the backend assertShape) — the form
// used to submit e.g. 150 and surface a raw server 400 instead of inline validation.
// FIXED is a currency amount, so it stays unbounded.
const base = { code: 'SAVE', maxRedemptions: '', expiresAt: '', active: true } as const;

describe('coupons form schema — PERCENT value bound', () => {
  it('rejects a PERCENT value over 100', () => {
    expect(schema.safeParse({ ...base, kind: 'PERCENT', value: 150 }).success).toBe(false);
  });

  it('rejects a PERCENT value under 1', () => {
    expect(schema.safeParse({ ...base, kind: 'PERCENT', value: 0.5 }).success).toBe(false);
  });

  it('accepts a PERCENT value within 1–100', () => {
    expect(schema.safeParse({ ...base, kind: 'PERCENT', value: 50 }).success).toBe(true);
  });

  it('accepts a FIXED value above 100 with a currency (currency amount, unbounded)', () => {
    expect(schema.safeParse({ ...base, kind: 'FIXED', value: 500, currency: 'TRY' }).success).toBe(true);
  });

  it('rejects a FIXED coupon with no currency (the backend requires one)', () => {
    const r = schema.safeParse({ ...base, kind: 'FIXED', value: 500 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === 'currency')).toBe(true);
    }
  });
});
