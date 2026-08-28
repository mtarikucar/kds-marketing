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
  // i18next resolves lng -> fallbackLng -> the call's inline defaultValue, and
  // config.ts sets `fallbackLng: 'en'`. So a locale merely MISSING these keys
  // neither throws nor shows a raw key: a ru/ar/uz operator is quietly served
  // ENGLISH. TimelinePanel's Turkish inline defaults are reachable only if `en`
  // lacks the key too — which is why the en catalogue is in the loop below
  // rather than assumed.
  //
  // Silent English is exactly as invisible as a raw key is loud, and nothing
  // else catches it: `missingKeyHandler` is dev-only (`saveMissing` is gated on
  // import.meta.env.DEV, so prod is silent), and localeCompleteness's >=95%
  // offer gate would not notice seven missing keys in a catalogue this size.
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

describe('marketing i18n — home left-column tabs', () => {
  // Same trap as the timeline panel, one level worse: these two words ARE the
  // navigation. A ru/ar/uz operator who is quietly served the Turkish default
  // sees a column whose two tabs are labelled in a language they did not pick,
  // and `fallbackLng: 'en'` means nothing throws and no raw key ever appears.
  // The failure-count label is in the same set because a badge announced only
  // as a bare number tells a screen-reader user nothing about what it counts.
  it('every offered locale defines the command.tabs namespace, not just tr', async () => {
    const want = flat((tr as Json).command as Json)
      .filter((k) => k.startsWith('tabs.'))
      .map((k) => `command.${k}`);
    expect(want).toEqual(
      expect.arrayContaining(['command.tabs.timeline', 'command.tabs.flow', 'command.tabs.failures']),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });
});
