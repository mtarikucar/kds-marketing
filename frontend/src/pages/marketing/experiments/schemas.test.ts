import { describe, it, expect } from 'vitest';
import { surveySchema, experimentSchema, affiliateSchema } from './schemas';

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

const q = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  label: 'Question',
  type: 'TEXT',
  required: false,
  options: '',
  ...over,
});

describe('surveySchema duplicate question keys', () => {
  // Survey answers are stored as a map keyed by question.key, so two questions
  // sharing a key collide — one respondent answer overwrites the other (lost
  // data). The builder's default key is `q${fields.length + 1}`, so an
  // add-delete-add sequence (q1,q2,q3 → delete q2 → add → q3) silently produces
  // a duplicate. Mirror experimentSchema's variant-key guard and reject it.
  it('rejects two questions with the same key', () => {
    const r = surveySchema.safeParse({ name: 'S', questions: [q('q1'), q('q1')] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'duplicateKey')).toBe(true);
    }
  });

  it('rejects keys that differ only by case', () => {
    const r = surveySchema.safeParse({ name: 'S', questions: [q('Q1'), q('q1')] });
    expect(r.success).toBe(false);
  });

  it('accepts unique question keys', () => {
    const r = surveySchema.safeParse({ name: 'S', questions: [q('q1'), q('q2')] });
    expect(r.success).toBe(true);
  });
});

// Guard the existing experiment behavior so the shared pattern stays consistent.
describe('experimentSchema duplicate variant keys', () => {
  it('still rejects duplicate variant keys', () => {
    const r = experimentSchema.safeParse({
      name: 'E',
      variants: [
        { key: 'a', label: 'A', weight: 1 },
        { key: 'a', label: 'B', weight: 1 },
      ],
    });
    expect(r.success).toBe(false);
  });
});
