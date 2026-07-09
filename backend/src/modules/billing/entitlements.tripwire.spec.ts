import * as fs from 'fs';
import * as path from 'path';
import { FEATURE_KEYS, LIMIT_KEYS, TOGGLEABLE_MODULE_KEYS } from './entitlements.service';

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
      'memberships',
      'research',
      'reviews',
      'sms',
      'smsOtp',
      'socialCampaigns',
      'telephony',
      'voiceAi',
      'voiceCampaigns',
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

/**
 * Backfill-note tripwire. `EntitlementsService.compute()` treats a non-null
 * `Workspace.activatedModules` as an explicit allow-list: any
 * TOGGLEABLE_MODULE_KEYS entry missing from it is forced to
 * `features[k] = false`, no matter what Package.features grants. That means
 * any FEATURE_KEYS member added AFTER the allow-list model shipped
 * (20260702160000_workspace_activated_modules) needs a one-off data
 * migration backfilling it into every pre-existing customized allow-list, or
 * every tenant who had already customized their module list silently loses
 * the new capability on deploy. Pin the keys that needed this treatment here
 * — adding a new post-20260702 toggleable key means EITHER shipping a
 * backfill migration for it and listing it below, OR proving it can't
 * possibly appear in a pre-existing allow-list (e.g. it's read-only/never
 * user-toggleable) and documenting why instead.
 */
describe('entitlements — activatedModules backfill-note tripwire', () => {
  const KEYS_REQUIRING_BACKFILL = ['sms', 'voiceCampaigns'] as const;

  // NetGSM SMS v2 Task 12 — `smsOtp` is a FEATURE_KEYS member added AFTER
  // 20260702160000_workspace_activated_modules, same as `sms` was, but it
  // does NOT need a backfill migration: it's excluded from
  // TOGGLEABLE_MODULE_KEYS (add-on-only, `false` in every plan, never a
  // Settings > Modules toggle), so EntitlementsService.compute()'s
  // allow-list intersection never iterates it — a customized
  // activatedModules list has no way to mask it. Pin the exclusion here so a
  // future refactor that folds smsOtp into TOGGLEABLE_MODULE_KEYS is forced
  // to ALSO add it to KEYS_REQUIRING_BACKFILL + ship the migration.
  it('smsOtp is excluded from TOGGLEABLE_MODULE_KEYS (add-on-only — no backfill needed)', () => {
    expect(TOGGLEABLE_MODULE_KEYS).not.toContain('smsOtp');
  });

  // NetGSM Phase 5 Task 1 — `voiceCampaigns` is the OPPOSITE case from
  // `smsOtp`: it's `true` on SCALE/OPERATOR (seed-packages.ts), so it IS a
  // genuine Settings > Modules toggle (present in TOGGLEABLE_MODULE_KEYS,
  // unlike smsOtp) — meaning a workspace that had already customized its
  // activatedModules allow-list BEFORE this key existed needs the backfill
  // migration below, or it would silently lose voice campaigns on deploy
  // despite being entitled by its plan.
  it('voiceCampaigns is NOT excluded from TOGGLEABLE_MODULE_KEYS (plan-entitled — backfill required)', () => {
    expect(TOGGLEABLE_MODULE_KEYS).toContain('voiceCampaigns');
  });

  it('every key needing a backfill has a reversible migration on disk', () => {
    const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const key of KEYS_REQUIRING_BACKFILL) {
      expect(FEATURE_KEYS as readonly string[]).toContain(key);

      const match = dirs.find((d) => d.includes(`backfill_${key}_activated_modules`));
      expect(match).toBeDefined();

      const migrationPath = path.join(migrationsRoot, match!, 'migration.sql');
      const downPath = path.join(migrationsRoot, match!, 'down.sql');
      expect(fs.existsSync(downPath)).toBe(true); // reversible, per repo convention

      const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();
      expect(sql).toContain('activatedmodules');
      expect(sql).toContain(key.toLowerCase());
    }
  });
});
