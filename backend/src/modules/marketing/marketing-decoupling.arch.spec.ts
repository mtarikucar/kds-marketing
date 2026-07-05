import * as fs from 'fs';
import * as path from 'path';

/**
 * Architecture-fitness test for the marketing↔core decoupling (Phase 5 split
 * readiness). These assertions are the invariants that make the eventual
 * physical split mechanical — they fail loudly if a change re-couples the
 * contexts. CI-independent (does not rely on the ESLint boundary rule).
 */
const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const MARKETING_DIR = path.join(BACKEND_ROOT, 'src/modules/marketing');
const SCHEMA = path.join(BACKEND_ROOT, 'prisma/schema.prisma');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('marketing decoupling — split readiness (architecture fitness)', () => {
  // Standalone-repo adaptation: subscription_payments (and its
  // referredByMarketingUserId soft-ref column) is core-owned and no longer in
  // this schema, so the split is asserted the other way around — no core
  // model may exist here at all, while the marketing-side soft-ref columns
  // are retained.
  it('contains no core-owned models in the marketing schema, keeping soft-ref columns', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');

    // Core-owned models must not exist in the marketing database.
    expect(schema).not.toMatch(/^model Tenant\s/m);
    expect(schema).not.toMatch(/^model User\s/m);
    expect(schema).not.toMatch(/^model Subscription\s/m);
    expect(schema).not.toMatch(/^model SubscriptionPlan\s/m);
    expect(schema).not.toMatch(/^model SubscriptionPayment\s/m);
    expect(schema).not.toMatch(/^model TenantProvisioningLog\s/m);

    // Forward + back relations of the 4 cross-context FKs must be gone.
    expect(schema).not.toMatch(/convertedTenant\s+Tenant\?\s+@relation/);
    expect(schema).not.toMatch(/@relation\("ConvertedTenant"/);
    expect(schema).not.toMatch(/@relation\("MarketingCommissions"/);
    expect(schema).not.toMatch(/plan\s+SubscriptionPlan\?\s+@relation/);
    expect(schema).not.toMatch(/@relation\("ReferredByMarketer"/);

    // The soft-reference columns (the human-meaningful link) are retained.
    expect(schema).toMatch(/convertedTenantId\s+String\?/);
    expect(schema).toMatch(/referralCode\s+String\?/);
  });

  it('keeps marketing free of every core Prisma delegate (no cross-context table access)', () => {
    // Mirrors the ESLint boundary rule, asserted here as a committed guarantee.
    const forbidden =
      /\b(?:this\.prisma|tx)\.(tenant|user|subscription|subscriptionPlan|subscriptionPayment|contactMessage)\b/;
    const offenders: string[] = [];
    for (const file of walkTs(MARKETING_DIR)) {
      if (forbidden.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(BACKEND_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes the 2 business events through the contracts, not direct cross-imports', () => {
    // Marketing must not import a core implementation directly — only the
    // neutral core-contracts (ports) or the outbox event bus.
    const badImport = /from ['"][^'"]*modules\/(payments|subscriptions|tenants|auth)\//;
    const offenders: string[] = [];
    for (const file of walkTs(MARKETING_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      if (badImport.test(src)) offenders.push(path.relative(BACKEND_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Symmetric boundary guard (ported from the monorepo's v3.0.1 round-4
   * audit fix, adapted to the standalone layout). The marketing module owns
   * its tables; the infrastructure seams around it (modules/internal — the
   * core-facing HTTP surface, modules/outbox — the event bus, core-client —
   * the HTTP port to core) must never write marketing-owned tables directly.
   * Writes belong to the marketing module's services and consumers, so a
   * relayed event that needs a Lead write lands in a marketing consumer
   * (e.g. HardwareQuoteConsumer), not in the intake controller.
   */
  it('blocks non-marketing modules from writing marketing-owned tables (symmetric guard)', () => {
    const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
    // Marketing-owned Prisma delegates. Reads are tolerated — writes are
    // the leak we're chasing.
    const forbidden =
      /\b(?:this\.prisma|tx|prisma)\.(lead|leadOffer|leadActivity|marketingUser|marketingTask|marketingNotification|commission|installationCrew|installationJob|installationTask|salesCall|salesTarget|marketingDistributionConfig)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    const allowPath = /\/modules\/marketing\//;
    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          !entry.name.endsWith('.d.ts')
        ) {
          // Normalize to forward slashes so the exemption also matches on
          // Windows (path.join emits backslashes there, which made EVERY
          // marketing file look non-exempt and fail this guard locally).
          if (allowPath.test(full.split(path.sep).join('/'))) continue;
          if (forbidden.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(BACKEND_ROOT, full));
          }
        }
      }
    }
    walk(SRC_ROOT);
    expect(offenders.sort()).toEqual([]);
  });
});
