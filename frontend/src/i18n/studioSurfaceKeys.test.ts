import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

/**
 * Source-driven i18n scan for the Growth Studio surface.
 *
 * Every other block in `marketing-parity.test.ts` pins a hand-written LIST of
 * keys, which is the right shape when the point is that a particular sentence
 * must exist in five locales. It is the wrong shape for the problem this file
 * exists for: keys added to a component and never added to a catalogue at all.
 * A hand-written list cannot notice those, because whoever forgot the catalogue
 * also forgot the list.
 *
 * So this reads the COMPONENTS and diffs them against the catalogues. It found
 * two live bugs the moment it was written — `settingsGroup.marketing` and
 * `settings.backToApp`, the group heading and the top link of the Settings
 * sidebar, both in neither catalogue, both silently English in every language
 * the product ships — plus thirty-nine `budget.*` keys the Autopilot console
 * renders that only `tr` had.
 *
 * WHY IT LOOKS LIKE THIS. Sources are read through `import.meta.glob(?raw)`
 * rather than `node:fs`, following `test/designSystemGuard.test.ts`: the same
 * pattern typechecks under the browser tsconfig this project compiles with.
 * And "does the catalogue have this key" mirrors i18next's own `deepFind`,
 * which tries the literal dotted key BEFORE walking the path — these files
 * store some keys nested and some flat, and a check that only walked the nested
 * path reports keys that are plainly there.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * The surface this scan is responsible for: the one-screen Studio, the chart
 * primitives it draws with, the Autopilot console behind its status bar, and
 * the Settings sidebar the Studio pushed three pages into.
 */
const SCANNED = [
  /^\/src\/pages\/marketing\/studio\//,
  /^\/src\/components\/charts\//,
  /^\/src\/pages\/marketing\/budget\/BudgetAutopilotPage\.tsx$/,
  /^\/src\/features\/marketing\/components\/SettingsLayout\.tsx$/,
];

const files = Object.entries(sources).filter(
  ([path]) => SCANNED.some((re) => re.test(path)) && !/\.test\.tsx?$/.test(path),
);

/** `t('key', 'default')` — the direct call sites. */
const T_CALL = /\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g;
/**
 * Table rows that name a key for someone else to translate: `labelKey: 'x.y'`.
 * `actionKinds.ts` is nothing but such tables, and its keys never appear in a
 * `t(...)` literal anywhere.
 */
const KEY_FIELD =
  /\b(?:labelKey|whatKey|confirmKey|manualCtaKey|manualHintKey|titleKey|descKey|key)\s*:\s*(['"])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g;

/**
 * `t(`settingsGroup.${g.key}`, g.label)` — a template literal no regex can
 * resolve, and the key class this program has already lost twice. Named
 * explicitly so the one heading nobody could see missing is the one heading
 * that cannot go missing again.
 */
const TEMPLATED = [
  'settingsGroup.workspace',
  'settingsGroup.automation',
  'settingsGroup.marketing',
  'settingsGroup.telephony',
  'settingsGroup.billing',
  'settingsGroup.data',
  'settingsGroup.connections',
  'settingsGroup.developer',
  'settingsGroup.agency',
  'settingsGroup.other',
];

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (key: string, path: string) => {
    const at = found.get(key) ?? [];
    if (!at.includes(path)) at.push(path);
    found.set(key, at);
  };
  for (const [path, src] of files) {
    for (const m of src.matchAll(T_CALL)) add(m[2], path);
    for (const m of src.matchAll(KEY_FIELD)) add(m[2], path);
  }
  for (const k of TEMPLATED) add(k, '/src/features/marketing/components/SettingsLayout.tsx');
  return found;
}

type Json = Record<string, unknown>;

/** i18next's resolution order: the literal flat key, then the nested walk. */
function value(cat: Json, dotted: string): string | undefined {
  const flat = cat[dotted];
  if (typeof flat === 'string') return flat;
  let cur: unknown = cat;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

const KEYS = [...scan().keys()].sort();

describe('Growth Studio i18n — every key the surface renders is in both catalogues', () => {
  it('scans the components rather than a list somebody has to remember to update', () => {
    // A guard on the guard: a glob or a regex that quietly stops matching would
    // turn every assertion below into a vacuous pass.
    expect(files.length).toBeGreaterThan(15);
    expect(KEYS.length).toBeGreaterThan(200);
    expect(KEYS).toEqual(expect.arrayContaining(['settingsGroup.marketing', 'studio.stats.title']));
  });

  it('tr defines every one of them', () => {
    expect(KEYS.filter((k) => value(tr as Json, k) === undefined)).toEqual([]);
  });

  /**
   * en matters as much as tr and is the half that rots, because it is also the
   * `fallbackLng`: a key missing from en does not throw and does not show a raw
   * key, it silently serves whatever the call site's inline default happens to
   * be — and on this surface those defaults are Turkish. So a gap here is not a
   * missing translation, it is an English-speaking operator reading Turkish.
   */
  it('en defines every one of them', () => {
    expect(KEYS.filter((k) => value(en as Json, k) === undefined)).toEqual([]);
  });

  /**
   * …and defines them in ENGLISH. A copy-paste that lands the Turkish string in
   * the en catalogue passes both checks above while shipping the exact bug they
   * exist to prevent, and it is invisible in review because the two files are
   * never read side by side.
   *
   * Short identical values are legitimate — a product name, a bare unit, a
   * symbol — so the comparison only speaks about strings long enough to be a
   * sentence.
   */
  it('never serves a Turkish string out of the en catalogue', () => {
    const same = KEYS.filter((k) => {
      const e = value(en as Json, k);
      const t = value(tr as Json, k);
      return e !== undefined && e === t && e.length > 3;
    });
    expect(same).toEqual([]);
  });
});
