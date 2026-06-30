import * as fs from 'fs';
import * as path from 'path';
import { FEATURE_KEYS, LIMIT_KEYS } from './entitlements.service';

/**
 * Drift tripwire — the FEATURE_COLUMNS belt, ported. Three places must
 * agree on the feature vocabulary or a flag silently stops gating:
 *   1. FEATURE_KEYS (the engine)
 *   2. every package literal in prisma/seed-packages.ts
 *   3. every @RequiresFeature('…') call site
 * A new feature key = a conscious edit to all three; this spec turns a
 * forgotten one into a red build instead of a quiet entitlement hole.
 * The same belt now covers LIMIT_KEYS ↔ each package's `limits` block.
 */
describe('entitlements — feature-key drift tripwire', () => {
  it('pins the feature vocabulary (update ALL three places when this changes)', () => {
    expect([...FEATURE_KEYS].sort()).toEqual([
      'advancedReports',
      'agentStudio',
      'apiAccess',
      'askAi',
      'autoAssign',
      'campaigns',
      'commissions',
      'conversationAi',
      'funnels',
      'installations',
      'invoicing',
      'mediaGen',
      'reviews',
      'socialCampaigns',
      'telephony',
      'voiceAi',
      'workflows',
    ]);
  });

  it('pins the limit vocabulary (Package.limits keys ↔ LIMIT_KEYS)', () => {
    expect([...LIMIT_KEYS].sort()).toEqual([
      'aiCreditsMonthly',
      'maxAgents',
      'maxCalendars',
      'maxFunnels',
      'maxKnowledgeDocs',
      'maxWorkflows',
      'messagesMonthly',
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

  it('seed-packages.ts sets exactly the known limit keys on every package', () => {
    const seed = fs.readFileSync(
      path.resolve(__dirname, '../../../prisma/seed-packages.ts'),
      'utf8',
    );
    // Each `limits: { ... }` block must list every LIMIT_KEY explicitly with a
    // numeric value (-1 = unlimited). A missing limit defaults to 0 in the
    // engine — i.e. "feature present but nothing allowed", a silent dead end.
    const blocks = [...seed.matchAll(/limits:\s*\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const [, body] of blocks) {
      const keys = [...body.matchAll(/(\w+):\s*-?\d+/g)].map((m) => m[1]).sort();
      expect(keys).toEqual([...LIMIT_KEYS].sort());
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
