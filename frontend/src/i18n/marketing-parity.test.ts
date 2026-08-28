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

describe('marketing i18n — MCP connector console (Faz 4)', () => {
  it('en defines the mcpConsole namespace and its nav entry', () => {
    expect((en as Json).mcpConsole).toBeTruthy();
    expect(flat(en as Json)).toEqual(expect.arrayContaining(['nav.mcpConsole']));
  });

  it('tr mirrors every mcpConsole key in en (and vice versa)', () => {
    const enKeys = flat(en as Json).filter((k) => /^(mcpConsole\.|nav\.mcpConsole$)/.test(k));
    const trKeys = flat(tr as Json).filter((k) => /^(mcpConsole\.|nav\.mcpConsole$)/.test(k));
    const trSet = new Set(trKeys);
    const enSet = new Set(enKeys);
    expect(enKeys.filter((k) => !trSet.has(k))).toEqual([]);
    expect(trKeys.filter((k) => !enSet.has(k))).toEqual([]);
  });
});

describe('marketing i18n — home timeline panel', () => {
  // The panel's t() calls all carry Turkish inline defaults, so a locale that
  // is merely MISSING these keys does not throw or show a raw key — it quietly
  // serves Turkish to an English, Russian, Arabic or Uzbek operator. That is a
  // defect no runtime check can see, which is why it is pinned here.
  it('every offered locale defines the timeline namespace, not just tr', async () => {
    const want = flat((tr as Json).timeline as Json).map((k) => `timeline.${k}`);
    expect(want.length).toBeGreaterThan(0);
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });
});
