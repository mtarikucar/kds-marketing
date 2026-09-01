import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

/**
 * Every `t('…')` key a screen actually USES must exist in the en and tr
 * catalogues.
 *
 * ## Why this exists, measured rather than imagined
 *
 * The house convention is `t('some.key', 'An English default')`, and the unit
 * tests for these screens mock `react-i18next` with a `t` that returns the
 * inline default and ignores the key entirely. That mock is the right one for
 * asserting behaviour — but it means a screen whose keys are ALL WRONG passes
 * every one of its own tests in English while rendering English to a Turkish
 * customer.
 *
 * That is not hypothetical. `DistributionPanel.tsx` shipped its first draft with
 * eight keys under `distribution.*` when the catalogue entries were written
 * under `contentDistribution.*` (the `distribution.*` namespace was already
 * taken by the lead round-robin settings). Twelve jsdom tests stayed green. The
 * browser test caught it, because tr-TR is pinned there — but only for the ONE
 * string that spec happened to assert.
 *
 * A parity list of REQUIRED keys (the shape `socialCampaign.i18n.test.ts` uses)
 * would not have caught it either: every listed key existed in both catalogues.
 * The missing question was whether the CODE asks for the keys that exist. This
 * file asks it.
 *
 * ## Scope, and why it is a list of files
 *
 * Only files added by this session's content-production work. Applying it
 * repo-wide would be a large and separate piece of work — several hundred
 * legitimate inline-default-only strings have never been extracted, and turning
 * that into a failing test today would make the gate meaningless by making it
 * red. A file joins this list when it is written; that is a decision somebody
 * makes, not a baseline that drifts.
 */
const WATCHED = import.meta.glob(
  [
    '/src/pages/marketing/settings/aiModels/AiModelsPage.tsx',
    '/src/pages/marketing/socialCampaigns/DistributionPanel.tsx',
  ],
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>;

/** `t('a.b.c'` — the only call shape these files use. Keys with no dot are
 *  namespace-less shorthands the catalogue stores flat; both are checked the
 *  same way. */
const KEY = /\bt\(\s*'([a-zA-Z0-9_.]+)'/g;

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

/** The catalogue also stores some keys FLAT with dots in the name (e.g.
 *  `"settings.backToApp"`), so a nested miss is not yet a miss. */
function resolves(catalogue: unknown, key: string): boolean {
  const nested = get(catalogue, key);
  if (typeof nested === 'string' && nested.length > 0) return true;
  const flat = (catalogue as Record<string, unknown>)[key];
  return typeof flat === 'string' && flat.length > 0;
}

describe('every t() key these screens use exists in en and tr', () => {
  it('has files to check (a glob that matched nothing would pass vacuously)', () => {
    expect(Object.keys(WATCHED).length).toBe(2);
  });

  for (const [path, src] of Object.entries(WATCHED)) {
    it(`${path} — no key falls back to its inline default`, () => {
      const keys = [...src.matchAll(KEY)].map((m) => m[1]);
      // A file whose keys stopped being extractable would otherwise pass by
      // finding nothing to check.
      expect(keys.length).toBeGreaterThan(5);

      const missingEn = [...new Set(keys)].filter((k) => !resolves(en, k));
      const missingTr = [...new Set(keys)].filter((k) => !resolves(tr, k));
      expect({ locale: 'en', missing: missingEn }).toEqual({ locale: 'en', missing: [] });
      expect({ locale: 'tr', missing: missingTr }).toEqual({ locale: 'tr', missing: [] });
    });
  }
});
