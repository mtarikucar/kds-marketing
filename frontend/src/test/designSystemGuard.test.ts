import { describe, it, expect } from 'vitest';

/**
 * Design-system guardrail. Console UI must use the theme-aware semantic `primary`
 * token (bg-primary / text-primary / border-primary/NN …) — NOT the fixed numeric
 * `primary-50..950` ramp, which does not shift for dark mode. The public landing +
 * legal pages keep their own fixed light-only brand ramp by design, so they're
 * excluded. Uses Vite's import.meta.glob (no Node fs) so it typechecks in the
 * browser tsconfig.
 */
const files = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const FIXED_RAMP =
  /\b(?:bg|text|border|ring|from|to|via|shadow|divide|outline)-primary-[0-9]/;

describe('design-system guard', () => {
  it('no fixed primary-* ramp in console code (use the theme-aware `primary` token)', () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(files)) {
      if (/\/pages\/(landing|legal)\//.test(path)) continue;
      if (/designSystemGuard\.test\./.test(path)) continue;
      src.split('\n').forEach((line, i) => {
        if (FIXED_RAMP.test(line)) offenders.push(`${path}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use bg-primary / text-primary / border-primary token instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
