import * as fs from 'fs';
import * as path from 'path';
import { FEATURE_KEYS } from './entitlements.service';

/**
 * Drift tripwire — the FEATURE_COLUMNS belt, ported. Three places must
 * agree on the feature vocabulary or a flag silently stops gating:
 *   1. FEATURE_KEYS (the engine)
 *   2. every package literal in prisma/seed-packages.ts
 *   3. every @RequiresFeature('…') call site
 * A new feature key = a conscious edit to all three; this spec turns a
 * forgotten one into a red build instead of a quiet entitlement hole.
 */
describe('entitlements — feature-key drift tripwire', () => {
  it('pins the feature vocabulary (update ALL three places when this changes)', () => {
    expect([...FEATURE_KEYS].sort()).toEqual([
      'advancedReports',
      'apiAccess',
      'autoAssign',
      'commissions',
      'installations',
      'telephony',
    ]);
  });

  it('seed-packages.ts grants exactly the known keys on every package', () => {
    const seed = fs.readFileSync(
      path.resolve(__dirname, '../../../prisma/seed-packages.ts'),
      'utf8',
    );
    // Every `features: { ... }` block in the seed must list every key —
    // explicit false beats implicit absence (absence reads as "forgot").
    const blocks = [...seed.matchAll(/features:\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const [, body] of blocks) {
      const keys = [...body.matchAll(/(\w+):\s*(?:true|false)/g)]
        .map((m) => m[1])
        .sort();
      expect(keys).toEqual([...FEATURE_KEYS].sort());
    }
  });

  it('every @RequiresFeature call site uses a known key', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const src = fs.readFileSync(full, 'utf8');
          for (const m of src.matchAll(/@?RequiresFeature\(\s*'([^']+)'\s*\)/g)) {
            if (!(FEATURE_KEYS as readonly string[]).includes(m[1])) {
              offenders.push(`${full}: unknown feature '${m[1]}'`);
            }
          }
        }
      }
    }
    walk(root);
    expect(offenders).toEqual([]);
  });
});
