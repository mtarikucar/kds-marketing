import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Tripwire: FeatureGuard is per-controller (not global). A controller that
 * declares @RequiresFeature but forgets FeatureGuard in its @UseGuards chain
 * silently skips entitlement checks. This scans every *.controller.ts under
 * src/modules and fails the build for that gap.
 *
 * Guard resolution follows one level of indirection: some controllers (e.g.
 * marketing-conversations.controller.ts) hoist their guard list into a
 * `const REST_GUARDS = [MarketingGuard, ..., FeatureGuard, ...]` array and
 * apply it per-route as `@UseGuards(...REST_GUARDS)`. A plain literal-text
 * check for "FeatureGuard" inside the @UseGuards(...) parens would miss that
 * and false-positive on a legitimate pattern, so a @UseGuards(...) call whose
 * spread identifier resolves to an in-file array literal containing
 * FeatureGuard counts as guarded too.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.controller.ts') ? [p] : [];
  });
}

/** Count @UseGuards(...) call sites that wire FeatureGuard, directly or via a hoisted array. */
function countFeatureGuardedUseGuards(src: string): number {
  const arrayLiterals = new Map<string, boolean>();
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*\[([^\]]*)\]/g)) {
    arrayLiterals.set(m[1], m[2].includes('FeatureGuard'));
  }
  const calls = src.match(/@UseGuards\([^)]*\)/g) ?? [];
  let count = 0;
  for (const call of calls) {
    if (call.includes('FeatureGuard')) {
      count++;
      continue;
    }
    const spreadIds = [...call.matchAll(/\.\.\.(\w+)/g)].map((mm) => mm[1]);
    if (spreadIds.some((id) => arrayLiterals.get(id))) count++;
  }
  return count;
}

describe('FeatureGuard presence tripwire', () => {
  const root = join(__dirname, '..', '..');
  it('every @RequiresFeature controller wires FeatureGuard', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('@RequiresFeature(')) continue;
      // Every class block that carries @RequiresFeature must also carry a
      // @UseGuards(...) mention of FeatureGuard (or a hoisted array
      // containing it) somewhere in the same file AND the file must not use
      // @RequiresFeature more times than classes covered by a guarded chain.
      const classCount = (src.match(/@Controller\(/g) ?? []).length;
      const guardedCount = countFeatureGuardedUseGuards(src);
      const requiresOnClasses = (src.match(/@RequiresFeature\(/g) ?? []).length;
      if (guardedCount === 0 || (classCount > 1 && guardedCount < Math.min(classCount, requiresOnClasses))) {
        offenders.push(file.replace(root, 'src/modules'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
