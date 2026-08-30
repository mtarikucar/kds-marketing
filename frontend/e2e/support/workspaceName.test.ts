/**
 * Unit test for the E2E fixture's workspace naming.
 *
 * This runs under VITEST, not Playwright (see the `testMatch` note in
 * playwright.config.ts and the `include` in vitest.config.ts) — it needs no
 * browser and no backend, and it is the fast net under a bug whose Playwright
 * symptom took a whole suite run and a warm database to show itself.
 *
 * What it guards: the fixture must never hand the backend two workspace names
 * that slugify to the same 40-character base. When it did, the backend's
 * linear-probe slug allocator turned every rerun into one more sequential
 * round trip inside a transaction, and the 51st rerun of a spec died on
 * `Could not allocate a workspace slug` (409).
 */
import { describe, it, expect } from 'vitest';
import { workspaceNameFor, SLUG_WINDOW } from './workspaceName';

/**
 * A copy of `slugify` + the base cut from
 * backend/src/modules/marketing/services/marketing-auth.service.ts.
 *
 * Copied ON PURPOSE. The 40-char `.slice` is the reason a token appended to
 * the END of the name is not a fix — it gets cut off and the slug base is
 * unchanged. A test that did not model the cut would pass for the broken fix.
 */
function slugBase(name: string): string {
  const turkishMap: Record<string, string> = {
    ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  };
  const base = name
    .toLowerCase()
    .replace(/[çğıöşü]/g, (ch) => turkishMap[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_WINDOW);
  return base || 'workspace';
}

/** Real titles from the suite — all comfortably longer than the 40-char cut. */
const TITLES = [
  'the pricing page offers exactly one plan',
  'the plan renders its Turkish price and Turkish feature names',
  'a new workspace starts on the trial, which grants every feature',
  'credit packs are sold as a one-off, not as a monthly charge',
  'the hub lists the whole provider catalogue',
  'a new workspace has no automations and says so',
];

describe('workspaceNameFor', () => {
  it('gives the same spec a different SLUG BASE on every call', () => {
    for (const title of TITLES) {
      const bases = new Set(
        Array.from({ length: 200 }, () => slugBase(workspaceNameFor(title))),
      );
      // 200 reruns of one spec must consume 200 distinct slug bases, not one.
      // At one shared base the backend caps out at 50 and 409s.
      expect(bases.size).toBe(200);
    }
  });

  it('keeps the unique token INSIDE slugify\'s 40-character window', () => {
    // The regression this pins: a token appended after the title is sliced
    // off, so the slug base collapses back to the deterministic one.
    const title = TITLES[1];
    const a = slugBase(workspaceNameFor(title, 'tokenaaaa0'));
    const b = slugBase(workspaceNameFor(title, 'tokenbbbb1'));

    expect(a).toContain('tokenaaaa0');
    expect(b).toContain('tokenbbbb1');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(SLUG_WINDOW);
  });

  it('distinguishes two different specs from each other', () => {
    const bases = new Set(TITLES.map((t) => slugBase(workspaceNameFor(t, 'sametoken0'))));
    expect(bases.size).toBe(TITLES.length);
  });

  it('still carries the spec title in the stored name, for traceability', () => {
    // The name is what a human reads off a leftover row; only the SLUG is
    // truncated to 40. Losing the title here would trade one bug for another.
    const title = 'credit packs are sold as a one-off, not as a monthly charge';
    expect(workspaceNameFor(title, 'tok0')).toContain(title);
  });

  it('never exceeds the name length the API accepts', () => {
    const long = 'x'.repeat(400);
    expect(workspaceNameFor(long).length).toBeLessThanOrEqual(110);
  });
});
