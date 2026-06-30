import { describe, it, expect } from 'vitest';
import { reshapeValueForCmp } from './segmentDsl';

// When a segment leaf's comparator changes, its value must be reshaped so the
// serialized leaf matches what the new comparator expects: in/nin/between take a
// list (array), every other (scalar) comparator takes a single value. Carrying a
// stale shape across that boundary lets the builder serialize an array under a
// scalar `eq` — which the backend compiler rejects (it would compile to an
// invalid Prisma filter that 500s on every evaluation) — or a string under `in`
// (compiles to an empty match).
describe('reshapeValueForCmp', () => {
  it('drops a stale array when switching to a scalar comparator (in → eq)', () => {
    expect(reshapeValueForCmp('eq', ['NEW', 'CONTACTED'])).toBe('');
    expect(reshapeValueForCmp('contains', ['a', 'b'])).toBe('');
    // range → scalar also drops the array
    expect(reshapeValueForCmp('eq', ['1', '9'])).toBe('');
  });

  it('drops a stale scalar when switching to a list comparator (eq → in)', () => {
    expect(reshapeValueForCmp('in', 'NEW')).toEqual([]);
    expect(reshapeValueForCmp('nin', 'NEW')).toEqual([]);
    // scalar → range wants a list too
    expect(reshapeValueForCmp('between', '5')).toEqual([]);
  });

  it('keeps the value when the list-vs-scalar shape is unchanged', () => {
    expect(reshapeValueForCmp('ne', 'NEW')).toBe('NEW'); // scalar → scalar
    expect(reshapeValueForCmp('nin', ['A', 'B'])).toEqual(['A', 'B']); // list → list
    expect(reshapeValueForCmp('between', ['1', '9'])).toEqual(['1', '9']); // range → range
  });

  it('normalizes a missing scalar value to an empty string', () => {
    expect(reshapeValueForCmp('eq', undefined)).toBe('');
    expect(reshapeValueForCmp('eq', null)).toBe('');
  });
});
