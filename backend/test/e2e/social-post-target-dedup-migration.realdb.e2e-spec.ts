import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { realDbEnabled } from '../utils/test-app';

/**
 * The 20260901110000 de-dup migration, executed against REAL Postgres.
 *
 * This migration is the only kind of code in the repo that can take the product
 * down by running correctly-typed, fully-reviewed SQL: `docker-compose.prod.yml`
 * boots the API as `npx prisma migrate deploy && … && node dist/main`, so a
 * statement that raises here does not merely fail to migrate — the `&&` chain
 * stops and the container never serves a request. It also DELETES rows, and one
 * class of row it deletes (a second PUBLISHED target) is the only surviving
 * evidence that a post reached a real customer's feed twice.
 *
 * Neither risk is reachable from the unit suite. There is no TypeScript to call:
 * the whole thing is a .sql file that Postgres alone can interpret, and the two
 * bugs it shipped with — an UPDATE that could violate a unique constraint, and a
 * keep-rule that preferred a dead FAILED row over a queued PENDING one — are
 * invisible to any test that does not actually run it over actual rows.
 *
 * ## How it runs without touching anything
 *
 * The file names its tables unqualified ("social_post_targets"), so a
 * `SET LOCAL search_path` to a scratch schema holding clones of them is enough
 * to run the real file, byte for byte, with nothing but the clones in reach.
 * Everything it creates — the archive table, the unique index — lands in the
 * scratch schema too, and the whole schema is dropped at the end. The public
 * tables the rest of the real-DB lane shares are never in the path.
 *
 * The clones are made with `LIKE public.… INCLUDING DEFAULTS INCLUDING
 * CONSTRAINTS`, so their columns cannot drift from the real ones, and the
 * constraints the migration actually collides with are then stated here by hand
 * rather than copied: the PK on each table, UNIQUE (targetId, date) on the
 * metrics — the one whose violation aborted the boot — and the ON DELETE CASCADE
 * that carries a loser's metrics away with it. If a later migration changes any
 * of those, this spec should be the thing that notices.
 *
 * `PrismaClient` directly rather than `createRealDbTestApp`: there is no service,
 * guard or pipe in the path being tested, and booting the whole Nest app to send
 * DDL would only add ways for this to be slow and flaky.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

const SCHEMA = 'mig_dedup_probe';
const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../prisma/migrations/20260901110000_social_post_target_account_unique/migration.sql',
);

/**
 * Split the migration into statements the way psql would.
 *
 * `$executeRawUnsafe` speaks the extended protocol, which accepts exactly one
 * command per call, so the file has to be cut on its top-level semicolons — and
 * naive splitting on ';' would cut the RAISE NOTICE message in half, because it
 * contains one. So string literals, line comments and dollar-quoted blocks (the
 * DO $$ … $$ that logs the count) are all skipped over rather than scanned.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollarTag: string | null = null;
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        cur += ch;
        i += 1;
      }
      continue;
    }
    if (inString) {
      cur += ch;
      // A doubled '' closes and immediately reopens, which lands in the same
      // place as treating it as an escape — and no ';' can hide between them.
      if (ch === "'") inString = false;
      i += 1;
      continue;
    }
    if (sql.startsWith('--', i)) {
      inLineComment = true;
      cur += '--';
      i += 2;
      continue;
    }
    if (ch === "'") {
      inString = true;
      cur += ch;
      i += 1;
      continue;
    }
    const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (tag) {
      dollarTag = tag[0];
      cur += tag[0];
      i += tag[0].length;
      continue;
    }
    if (ch === ';') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur);

  // Drop the comment-only tails: the file ends with prose after its last ';'.
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

interface TargetRow {
  id: string;
  postId: string;
  accountId: string;
  status: string;
  externalPostId?: string;
  error?: string;
}

describeRealDb('social_post_targets de-dup migration — real DB (e2e)', () => {
  let db: PrismaClient;
  let statements: string[];

  const q = (v: string | undefined) => (v === undefined ? 'NULL' : `'${v}'`);

  async function insertTargets(rows: TargetRow[]) {
    const values = rows
      .map(
        (r) =>
          `('${r.id}','w1','${r.postId}','${r.accountId}','INSTAGRAM','${r.status}',${q(
            r.externalPostId,
          )},${q(r.error)})`,
      )
      .join(',');
    await db.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."social_post_targets"
         ("id","workspaceId","postId","socialAccountId","network","status","externalPostId","error")
       VALUES ${values}`,
    );
  }

  async function insertMetric(id: string, targetId: string, date: string, impressions: number) {
    await db.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."social_post_metrics" ("id","workspaceId","targetId","date","impressions")
       VALUES ('${id}','w1','${targetId}',DATE '${date}',${impressions})`,
    );
  }

  /** Put the scratch schema back into its pre-migration shape. */
  async function rewind() {
    await db.$executeRawUnsafe(
      `DROP TABLE IF EXISTS "${SCHEMA}"."social_post_targets_dedup_archive"`,
    );
    await db.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "${SCHEMA}"."social_post_targets_postId_socialAccountId_key"`,
    );
    await db.$executeRawUnsafe(
      `TRUNCATE "${SCHEMA}"."social_post_targets", "${SCHEMA}"."social_post_metrics"`,
    );
  }

  /** Run the real file the way `migrate deploy` does: one transaction, in order. */
  async function applyMigration() {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${SCHEMA}"`);
        for (const stmt of statements) await tx.$executeRawUnsafe(stmt);
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  const targets = () =>
    db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "id","postId","socialAccountId","status","externalPostId","error"
         FROM "${SCHEMA}"."social_post_targets" ORDER BY "id"`,
    );
  const metrics = () =>
    db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "id","targetId","date","impressions"
         FROM "${SCHEMA}"."social_post_metrics" ORDER BY "targetId","date"`,
    );
  const archive = () =>
    db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "targetId","postId","socialAccountId","status","externalPostId","error","keeperId"
         FROM "${SCHEMA}"."social_post_targets_dedup_archive" ORDER BY "targetId"`,
    );

  beforeAll(async () => {
    db = new PrismaClient();
    statements = splitStatements(fs.readFileSync(MIGRATION_SQL, 'utf8'));

    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await db.$executeRawUnsafe(
      `CREATE TABLE "${SCHEMA}"."social_post_targets"
         (LIKE public."social_post_targets" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE "${SCHEMA}"."social_post_metrics"
         (LIKE public."social_post_metrics" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."social_post_targets" ADD PRIMARY KEY ("id")`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."social_post_metrics" ADD PRIMARY KEY ("id")`,
    );
    // The constraint the migration used to violate, and the cascade it relies on
    // to take a loser's unmovable readings with it.
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."social_post_metrics"
         ADD CONSTRAINT "probe_metrics_target_date_key" UNIQUE ("targetId","date")`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."social_post_metrics"
         ADD CONSTRAINT "probe_metrics_target_fkey" FOREIGN KEY ("targetId")
         REFERENCES "${SCHEMA}"."social_post_targets"("id") ON DELETE CASCADE`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await db.$disconnect();
    }
  });

  beforeEach(rewind);

  it('survives two losers holding a reading for the same date', async () => {
    // Three rows for one pair. t2 and t3 both carry a reading for 2026-08-20,
    // which the keeper has nothing for — so both pass the "keeper already has
    // this date" guard, and moving both onto (t1, 2026-08-20) violates
    // UNIQUE (targetId, date). That raise is what stopped the container.
    await insertTargets([
      { id: 't1', postId: 'p1', accountId: 'a1', status: 'PUBLISHED', externalPostId: 'ext-1' },
      { id: 't2', postId: 'p1', accountId: 'a1', status: 'PUBLISHED', externalPostId: 'ext-2' },
      { id: 't3', postId: 'p1', accountId: 'a1', status: 'FAILED', error: 'rate limited' },
    ]);
    await insertMetric('m1', 't1', '2026-08-19', 100);
    await insertMetric('m2', 't2', '2026-08-19', 200);
    await insertMetric('m3', 't2', '2026-08-20', 300);
    await insertMetric('m4', 't3', '2026-08-20', 400);
    await insertMetric('m5', 't3', '2026-08-21', 500);

    await expect(applyMigration()).resolves.toBeUndefined();

    // The keeper keeps its own reading for the contested day it already had
    // (m1, not m2), takes 2026-08-20 from the BETTER-ranked loser (m3, not m4),
    // and takes the uncontested 2026-08-21. m2 and m4 cascade away with their
    // rows, which is what happened to every one of them before the move existed.
    expect(await metrics()).toEqual([
      expect.objectContaining({ id: 'm1', targetId: 't1', impressions: 100 }),
      expect.objectContaining({ id: 'm3', targetId: 't1', impressions: 300 }),
      expect.objectContaining({ id: 'm5', targetId: 't1', impressions: 500 }),
    ]);
    expect((await targets()).map((t) => t.id)).toEqual(['t1']);
  });

  it('archives a destroyed PUBLISHED row instead of just deleting it', async () => {
    await insertTargets([
      { id: 't1', postId: 'p1', accountId: 'a1', status: 'PUBLISHED', externalPostId: 'ext-live-1' },
      { id: 't2', postId: 'p1', accountId: 'a1', status: 'PUBLISHED', externalPostId: 'ext-live-2' },
    ]);

    await applyMigration();

    // ext-live-2 is a post sitting on a real customer's feed that nobody meant
    // to send. Without this row an operator cannot even name it, let alone
    // delete it — and the target it hung off is gone.
    expect(await archive()).toEqual([
      {
        targetId: 't2',
        postId: 'p1',
        socialAccountId: 'a1',
        status: 'PUBLISHED',
        externalPostId: 'ext-live-2',
        error: null,
        keeperId: 't1',
      },
    ]);
  });

  it('keeps the PENDING row of a (FAILED, PENDING) pair, and archives the error', async () => {
    // The FAILED row deliberately holds the LOWER id, so the id tiebreak cannot
    // be what saves the PENDING one — only the keep-rule can. Keeping the FAILED
    // row here drops this network from a post that is still queued to go out:
    // publishDuePost fans out over PENDING targets and no others, and
    // attachTargets refuses to re-attach an account the post already has a row
    // for, so the composer cannot put it back either.
    await insertTargets([
      { id: 't4-failed', postId: 'p2', accountId: 'a2', status: 'FAILED', error: 'token expired' },
      { id: 't5-pending', postId: 'p2', accountId: 'a2', status: 'PENDING' },
    ]);

    await applyMigration();

    expect((await targets()).map((t) => t.id)).toEqual(['t5-pending']);
    // The operator's error string is not lost, it just moved.
    expect(await archive()).toEqual([
      expect.objectContaining({ targetId: 't4-failed', error: 'token expired', keeperId: 't5-pending' }),
    ]);
  });

  it('still prefers a FAILED row that reached the network over a PENDING one', async () => {
    // Rule 2 outranks rule 3: an externalPostId means the network HAS this post,
    // whatever the status column says, and publishing the PENDING row would send
    // it a second time. Only rows with nothing on the network reach rule 3.
    await insertTargets([
      {
        id: 't6-failed-ext',
        postId: 'p3',
        accountId: 'a3',
        status: 'FAILED',
        externalPostId: 'ext-partial',
        error: 'died after the vendor call',
      },
      { id: 't7-pending', postId: 'p3', accountId: 'a3', status: 'PENDING' },
    ]);

    await applyMigration();

    expect((await targets()).map((t) => t.id)).toEqual(['t6-failed-ext']);
  });

  it('is re-runnable against a database it has already been applied to', async () => {
    // `migrate deploy` will not re-run an applied migration, but its bookkeeping
    // is not always there: a dump restored without _prisma_migrations, or an
    // operator replaying the file by hand over a database that drifted. A second
    // pass must be a no-op, not a failure — and in particular must not file the
    // same rows into the archive twice.
    await insertTargets([
      { id: 't1', postId: 'p1', accountId: 'a1', status: 'PUBLISHED', externalPostId: 'ext-1' },
      { id: 't2', postId: 'p1', accountId: 'a1', status: 'PENDING' },
      { id: 't8-solo', postId: 'p4', accountId: 'a4', status: 'PENDING' },
    ]);
    await insertMetric('m6', 't8-solo', '2026-08-20', 600);

    await applyMigration();
    const afterFirst = { t: await targets(), m: await metrics(), a: await archive() };

    await expect(applyMigration()).resolves.toBeUndefined();

    expect(await targets()).toEqual(afterFirst.t);
    expect(await metrics()).toEqual(afterFirst.m);
    expect(await archive()).toEqual(afterFirst.a);
    expect(afterFirst.a).toHaveLength(1);
    // A pair that was never duplicated is untouched, readings and all.
    expect(afterFirst.m).toEqual([
      expect.objectContaining({ id: 'm6', targetId: 't8-solo', impressions: 600 }),
    ]);
  });
});
