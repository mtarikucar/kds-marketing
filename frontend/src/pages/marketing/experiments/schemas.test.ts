import { describe, it, expect } from 'vitest';
import { affiliateSchema } from './schemas';

describe('affiliateSchema PERCENT commission bound', () => {
  const base = { name: 'Alice', email: 'a@b.com', code: 'ALICE10' } as const;

  it('rejects a PERCENT commission over 100', () => {
    expect(affiliateSchema.safeParse({ ...base, commissionType: 'PERCENT', commissionValue: 150 }).success).toBe(false);
  });

  it('accepts a PERCENT commission at or below 100', () => {
    expect(affiliateSchema.safeParse({ ...base, commissionType: 'PERCENT', commissionValue: 50 }).success).toBe(true);
  });

  it('accepts a FLAT commission above 100 (currency amount, unbounded)', () => {
    expect(affiliateSchema.safeParse({ ...base, commissionType: 'FLAT', commissionValue: 500 }).success).toBe(true);
  });
});
