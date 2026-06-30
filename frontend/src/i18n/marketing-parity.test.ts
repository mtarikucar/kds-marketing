import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

type Json = Record<string, unknown>;
const flat = (o: Json, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flat(v as Json, `${p}${k}.`)
      : [`${p}${k}`],
  );

describe('marketing i18n — AI Studio / Brand Kit', () => {
  it('en defines the new namespaces and nav keys', () => {
    expect((en as Json).aiStudio).toBeTruthy();
    expect((en as Json).brandKit).toBeTruthy();
    expect(flat(en as Json)).toEqual(expect.arrayContaining(['nav.aiStudio', 'nav.brandKit']));
  });

  it('tr mirrors every aiStudio / brandKit / social.composer key in en', () => {
    const want = flat(en as Json).filter((k) =>
      /^(aiStudio|brandKit|social\.composer)\./.test(k),
    );
    const have = new Set(flat(tr as Json));
    expect(want.filter((k) => !have.has(k))).toEqual([]);
  });
});
