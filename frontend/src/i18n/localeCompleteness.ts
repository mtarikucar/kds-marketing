/**
 * Locale completeness gate for the LanguageSwitcher.
 *
 * A half-translated locale is worse than none — the user lands in a UI that is
 * mostly English keys with a few native strings, which reads as broken. So we
 * only OFFER a locale once its catalog covers ≥95% of the reference (Turkish)
 * catalog's keys. English and Turkish are the product's first-class languages
 * and are always offered regardless of raw count.
 *
 * Coverage is computed once at import time from the bundled locale JSONs, so
 * finishing a translation automatically unhides its locale on the next build —
 * no config to remember to flip.
 */
import trCommon from './locales/tr/common.json';
import trMarketing from './locales/tr/marketing.json';
import arCommon from './locales/ar/common.json';
import arMarketing from './locales/ar/marketing.json';
import ruCommon from './locales/ru/common.json';
import ruMarketing from './locales/ru/marketing.json';
import uzCommon from './locales/uz/common.json';
import uzMarketing from './locales/uz/marketing.json';

/** Flatten a nested catalog to `ns.a.b.c` → string leaf paths (non-strings dropped). */
function flatten(obj: unknown, prefix: string, out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === 'string') {
    out[prefix] = obj;
  }
  return out;
}

function catalog(common: unknown, marketing: unknown): Record<string, string> {
  return { ...flatten(common, 'common'), ...flatten(marketing, 'marketing') };
}

const TR = catalog(trCommon, trMarketing);
const TR_KEYS = Object.keys(TR);

/** Fraction of the reference (tr) keys this locale fills with a non-empty string. */
function coverage(loc: Record<string, string>): number {
  if (TR_KEYS.length === 0) return 1;
  let matched = 0;
  for (const key of TR_KEYS) {
    if ((loc[key] ?? '').trim()) matched += 1;
  }
  return matched / TR_KEYS.length;
}

/** en + tr are always offered; every other locale must earn its place. */
const ALWAYS_OFFERED = new Set(['en', 'tr']);

export const LOCALE_COVERAGE: Record<string, number> = {
  ar: coverage(catalog(arCommon, arMarketing)),
  ru: coverage(catalog(ruCommon, ruMarketing)),
  uz: coverage(catalog(uzCommon, uzMarketing)),
};

export const LOCALE_COMPLETENESS_THRESHOLD = 0.95;

/** Whether the LanguageSwitcher should offer this locale to the user. */
export function isLocaleOffered(code: string, threshold = LOCALE_COMPLETENESS_THRESHOLD): boolean {
  if (ALWAYS_OFFERED.has(code)) return true;
  return (LOCALE_COVERAGE[code] ?? 0) >= threshold;
}
