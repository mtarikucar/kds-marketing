import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { realDbEnabled } from '../utils/test-app';

/**
 * The five email-programme migration pairs, run up → down → up against REAL
 * Postgres.
 *
 * A `down.sql` is the only file in the repo nobody ever executes: `migrate
 * deploy` reads `migration.sql` and nothing else, so a down half can name a
 * column that was never added, drop the wrong index, or take a table the up
 * did not create, and every gate in CI stays green. It is discovered at the
 * worst possible moment — mid-rollback, on prod, with the API already down
 * (`docker-compose.prod.yml` boots as `prisma migrate deploy && … && node
 * dist/main`, so the chain stops and the container never serves a request).
 *
 * So each pair is exercised here the way an operator would: apply the up,
 * assert the objects it promises, apply the down, assert they are gone AND
 * that the rows around them survived, then apply the up again — a rollback is
 * only safe if you can roll forward afterwards. Each down is applied twice, to
 * prove it is a no-op when the revert already happened.
 *
 * ## How it runs without touching anything
 *
 * All five files name their tables unqualified ("leads", "campaign_recipients",
 * …), so a `SET LOCAL search_path` to a scratch schema holding clones of the
 * two tables they ALTER is enough to run the real files, byte for byte, with
 * nothing but the clones in reach. The three tables they CREATE land in the
 * scratch schema too, and the whole schema is dropped at the end. The public
 * tables the rest of the real-DB lane shares are never in the path — which
 * matters more here than anywhere else, because two of these downs drop
 * columns off `leads` and `campaign_recipients`.
 *
 * The clones are made with `LIKE public.… INCLUDING DEFAULTS INCLUDING
 * CONSTRAINTS` so their columns cannot drift from the real ones. They are then
 * rewound to the pre-migration shape by hand (not by running down.sql — that
 * is the thing under test, it cannot also be the fixture).
 *
 * `PrismaClient` directly rather than `createRealDbTestApp`: there is no
 * service, guard or pipe in the path being tested, and booting the whole Nest
 * app to send DDL would only add ways for this to be slow and flaky.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

const SCHEMA = 'mail_migration_probe';
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

const M1 = '20260922100000_contact_suppression';
const M2 = '20260922101000_mail_log';
const M3 = '20260922102000_campaign_recipient_channel_feedback';
const M4 = '20260922103000_email_inbound_items';
const M5 = '20260922104000_lead_iys_email';
const PAIRS = [M1, M2, M3, M4, M5] as const;

/**
 * Split a migration into statements the way psql would.
 *
 * `$executeRawUnsafe` speaks the extended protocol, which accepts exactly one
 * command per call, so the file has to be cut on its top-level semicolons.
 * Line comments and string literals are skipped over rather than scanned, so a
 * ';' inside either cannot cut a statement in half.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
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

  // Drop comment-only tails: every file here opens and closes with prose.
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

describeRealDb('email migration pairs — up/down round-trip, real DB (e2e)', () => {
  let db: PrismaClient;

  /** Run one half of a pair the way `migrate deploy` does: one transaction, in order. */
  async function apply(dir: string, half: 'migration.sql' | 'down.sql'): Promise<void> {
    const file = path.join(MIGRATIONS, dir, half);
    const statements = splitStatements(fs.readFileSync(file, 'utf8'));
    expect(statements.length).toBeGreaterThan(0);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${SCHEMA}"`);
        for (const stmt of statements) await tx.$executeRawUnsafe(stmt);
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  async function tableExists(table: string): Promise<boolean> {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2`,
      SCHEMA,
      table,
    );
    return rows[0].n > 0;
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      SCHEMA,
      table,
      column,
    );
    return rows[0].n > 0;
  }

  async function indexExists(index: string): Promise<boolean> {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      SCHEMA,
      index,
    );
    return rows[0].n > 0;
  }

  async function countRows(table: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${table}"`,
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    db = new PrismaClient();
    await db.$connect();

    const [{ n: leadsInPublic }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'leads'`,
    );
    if (!leadsInPublic) {
      throw new Error('public."leads" is missing — run `npx prisma migrate deploy` first');
    }

    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    for (const table of ['campaigns', 'campaign_recipients', 'leads']) {
      await db.$executeRawUnsafe(
        `CREATE TABLE "${SCHEMA}"."${table}"
           (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
    }
    // Rewind the two ALTERed clones to their pre-migration shape by hand. Using
    // down.sql for this would make the fixture and the subject the same file.
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."campaign_recipients"
         DROP COLUMN IF EXISTS "channel",
         DROP COLUMN IF EXISTS "bouncedAt",
         DROP COLUMN IF EXISTS "complainedAt",
         DROP COLUMN IF EXISTS "mailLogId"`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE "${SCHEMA}"."leads"
         DROP COLUMN IF EXISTS "iysEmailStatus",
         DROP COLUMN IF EXISTS "iysEmailCheckedAt"`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await db.$disconnect();
    }
  });

  it('every pair ships both halves', () => {
    for (const dir of PAIRS) {
      for (const half of ['migration.sql', 'down.sql']) {
        const file = path.join(MIGRATIONS, dir, half);
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0);
      }
    }
  });

  describe(`M1 ${M1}`, () => {
    it('creates contact_suppressions with the reason-in-key unique, drops it, recreates it', async () => {
      await apply(M1, 'migration.sql');
      expect(await tableExists('contact_suppressions')).toBe(true);
      expect(await indexExists('contact_suppressions_workspaceId_kind_hash_reason_key')).toBe(true);
      expect(await indexExists('contact_suppressions_workspaceId_kind_hash_idx')).toBe(true);

      // R5: an ERASURE tombstone and a HARD_BOUNCE for the same address coexist.
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."contact_suppressions" ("id","workspaceId","kind","hash","reason")
         VALUES ('s1','w1','EMAIL','abc','ERASURE'), ('s2','w1','EMAIL','abc','HARD_BOUNCE')`,
      );
      expect(await countRows('contact_suppressions')).toBe(2);
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "${SCHEMA}"."contact_suppressions" ("id","workspaceId","kind","hash","reason")
           VALUES ('s3','w1','EMAIL','abc','ERASURE')`,
        ),
      ).rejects.toThrow();

      await apply(M1, 'down.sql');
      expect(await tableExists('contact_suppressions')).toBe(false);
      await apply(M1, 'down.sql'); // idempotent: a safe no-op when already reverted

      await apply(M1, 'migration.sql');
      expect(await tableExists('contact_suppressions')).toBe(true);
      expect(await countRows('contact_suppressions')).toBe(0);
    });
  });

  describe(`M2 ${M2}`, () => {
    it('creates mail_log with its four indexes, drops it, recreates it', async () => {
      await apply(M2, 'migration.sql');
      expect(await tableExists('mail_log')).toBe(true);
      expect(await indexExists('mail_log_workspaceId_createdAt_idx')).toBe(true);
      expect(await indexExists('mail_log_workspaceId_messageId_idx')).toBe(true);
      expect(await indexExists('mail_log_workspaceId_toAddressNorm_createdAt_idx')).toBe(true);
      expect(await indexExists('mail_log_workspaceId_idempotencyKey_key')).toBe(true);

      // idempotencyKey is OPTIONAL: many rows may leave it null, one row per
      // (workspace, key) may set it.
      const row = (id: string, key: string | null) =>
        `('${id}','w1','BULK','campaign:c1',${key === null ? 'NULL' : `'${key}'`},'a@b.com','a@b.com','from@jeetagrowth.com','PLATFORM','Konu',now())`;
      const cols = `("id","workspaceId","mailClass","source","idempotencyKey","toAddress","toAddressNorm","fromAddress","transport","subject","updatedAt")`;
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."mail_log" ${cols} VALUES ${row('m1', null)}, ${row('m2', null)}, ${row('m3', 'k1')}`,
      );
      expect(await countRows('mail_log')).toBe(3);
      await expect(
        db.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."mail_log" ${cols} VALUES ${row('m4', 'k1')}`),
      ).rejects.toThrow();

      await apply(M2, 'down.sql');
      expect(await tableExists('mail_log')).toBe(false);
      await apply(M2, 'down.sql');

      await apply(M2, 'migration.sql');
      expect(await tableExists('mail_log')).toBe(true);
    });
  });

  describe(`M3 ${M3}`, () => {
    const COLUMNS = ['channel', 'bouncedAt', 'complainedAt', 'mailLogId'];

    beforeAll(async () => {
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."campaigns" ("id","workspaceId","name","channel","body","updatedAt")
         VALUES ('c-mail','w1','Mail blast','EMAIL','gövde',now()),
                ('c-sms','w1','SMS blast','SMS','gövde',now())`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."campaign_recipients" ("id","workspaceId","campaignId","leadId","token")
         VALUES ('r-mail','w1','c-mail','l1','t1'), ('r-sms','w1','c-sms','l2','t2')`,
      );
    });

    async function channelOf(id: string): Promise<string | null> {
      const rows = await db.$queryRawUnsafe<{ channel: string | null }[]>(
        `SELECT "channel" FROM "${SCHEMA}"."campaign_recipients" WHERE "id" = $1`,
        id,
      );
      return rows[0].channel;
    }

    it('adds the four columns and backfills channel from the campaign', async () => {
      await apply(M3, 'migration.sql');
      for (const c of COLUMNS) expect(await columnExists('campaign_recipients', c)).toBe(true);
      expect(await channelOf('r-mail')).toBe('EMAIL');
      expect(await channelOf('r-sms')).toBe('SMS');
    });

    it('re-running the up never overwrites a channel that is already set', async () => {
      await db.$executeRawUnsafe(
        `UPDATE "${SCHEMA}"."campaign_recipients" SET "channel" = 'WHATSAPP' WHERE "id" = 'r-mail'`,
      );
      await apply(M3, 'migration.sql');
      expect(await channelOf('r-mail')).toBe('WHATSAPP');
      expect(await channelOf('r-sms')).toBe('SMS');
    });

    it('drops exactly its four columns, keeps the recipient rows, and rolls forward again', async () => {
      const before = await countRows('campaign_recipients');

      await apply(M3, 'down.sql');
      for (const c of COLUMNS) expect(await columnExists('campaign_recipients', c)).toBe(false);
      expect(await columnExists('campaign_recipients', 'token')).toBe(true);
      expect(await countRows('campaign_recipients')).toBe(before);
      await apply(M3, 'down.sql');

      await apply(M3, 'migration.sql');
      for (const c of COLUMNS) expect(await columnExists('campaign_recipients', c)).toBe(true);
      expect(await countRows('campaign_recipients')).toBe(before);
      expect(await channelOf('r-mail')).toBe('EMAIL');
    });
  });

  describe(`M4 ${M4}`, () => {
    it('creates email_inbound_items with its unique + state index, drops it, recreates it', async () => {
      await apply(M4, 'migration.sql');
      expect(await tableExists('email_inbound_items')).toBe(true);
      expect(await indexExists('email_inbound_items_channelId_source_itemKey_key')).toBe(true);
      expect(await indexExists('email_inbound_items_workspaceId_state_updatedAt_idx')).toBe(true);

      // One row per EXAMINED item: the same uid seen twice must not duplicate.
      const cols = `("id","workspaceId","channelId","source","itemKey","updatedAt")`;
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."email_inbound_items" ${cols}
         VALUES ('i1','w1','ch1','imap','12:345',now())`,
      );
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "${SCHEMA}"."email_inbound_items" ${cols}
           VALUES ('i2','w1','ch1','imap','12:345',now())`,
        ),
      ).rejects.toThrow();

      await apply(M4, 'down.sql');
      expect(await tableExists('email_inbound_items')).toBe(false);
      await apply(M4, 'down.sql');

      await apply(M4, 'migration.sql');
      expect(await tableExists('email_inbound_items')).toBe(true);
    });
  });

  describe(`M5 ${M5}`, () => {
    beforeAll(async () => {
      await db.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."leads"
           ("id","workspaceId","businessName","contactPerson","businessType","source","updatedAt")
         VALUES ('l-iys','w1','Acme','Ayşe','CAFE','WEBSITE',now())`,
      );
    });

    it('adds the two İYS cache columns, drops exactly those, keeps the lead, rolls forward', async () => {
      await apply(M5, 'migration.sql');
      expect(await columnExists('leads', 'iysEmailStatus')).toBe(true);
      expect(await columnExists('leads', 'iysEmailCheckedAt')).toBe(true);

      // G3: the cache defaults to null — nothing is claimed about a lead İYS
      // was never asked about.
      const rows = await db.$queryRawUnsafe<{ iysEmailStatus: string | null }[]>(
        `SELECT "iysEmailStatus" FROM "${SCHEMA}"."leads" WHERE "id" = 'l-iys'`,
      );
      expect(rows[0].iysEmailStatus).toBeNull();

      const before = await countRows('leads');
      await apply(M5, 'down.sql');
      expect(await columnExists('leads', 'iysEmailStatus')).toBe(false);
      expect(await columnExists('leads', 'iysEmailCheckedAt')).toBe(false);
      expect(await columnExists('leads', 'emailOptOut')).toBe(true);
      expect(await countRows('leads')).toBe(before);
      await apply(M5, 'down.sql');

      await apply(M5, 'migration.sql');
      expect(await columnExists('leads', 'iysEmailStatus')).toBe(true);
      expect(await countRows('leads')).toBe(before);
    });
  });
});
