import { describe, expect, it } from 'vitest';
import tr from './tr.json';
import en from './en.json';
import { flatten } from './flatten';

describe('i18n catalogs', () => {
  const trFlat = flatten(tr);
  const enFlat = flatten(en);

  it('tr and en have identical key sets', () => {
    expect(Object.keys(trFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it('no value is empty', () => {
    for (const [lang, flat] of [
      ['tr', trFlat],
      ['en', enFlat],
    ] as const) {
      const empty = Object.entries(flat)
        .filter(([, value]) => value.trim() === '')
        .map(([key]) => `${lang}:${key}`);
      expect(empty).toEqual([]);
    }
  });

  it('every leaf is a string', () => {
    expect(Object.keys(trFlat).length).toBeGreaterThan(0);
    for (const value of [...Object.values(trFlat), ...Object.values(enFlat)]) {
      expect(typeof value).toBe('string');
    }
  });

  it('flatten keeps non-string leaves visible so a number or null cannot slip in', () => {
    expect(flatten({ a: { b: 'x', c: 1, d: null } })).toEqual({ 'a.b': 'x', 'a.c': '1', 'a.d': '' });
  });
});
