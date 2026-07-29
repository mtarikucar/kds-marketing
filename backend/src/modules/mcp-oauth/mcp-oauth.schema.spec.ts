import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';

/**
 * MCP Faz 3 Task 1 — the OAuth authorization server's data model.
 *
 * Two things are locked here:
 *  1. the generated Prisma client really exposes the three new models (so a
 *     schema edit that was never `prisma generate`d fails loudly), and
 *  2. the hand-written migration honours the repo convention: the `up` is
 *     idempotent (`IF NOT EXISTS`) and the `down` drops EXACTLY the tables the
 *     up created and nothing else, so up → down → up round-trips.
 *
 * There is no live Postgres in this suite, so the round-trip is verified
 * structurally (statement-level) rather than by executing the SQL.
 */
const MIGRATION_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20260729120000_mcp_oauth',
);

const TABLES = ['mcp_oauth_clients', 'mcp_oauth_codes', 'mcp_oauth_tokens'];

const up = () => readFileSync(join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const down = () => readFileSync(join(MIGRATION_DIR, 'down.sql'), 'utf8');

describe('mcp-oauth data model', () => {
  it('exposes the three new models on the generated Prisma client', () => {
    expect(Prisma.ModelName.McpOAuthClient).toBe('McpOAuthClient');
    expect(Prisma.ModelName.McpOAuthCode).toBe('McpOAuthCode');
    expect(Prisma.ModelName.McpOAuthToken).toBe('McpOAuthToken');
  });

  it('creates exactly the three mcp_oauth tables', () => {
    const created = [...up().matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
  });

  it('is re-runnable: every up statement is guarded with IF NOT EXISTS', () => {
    for (const stmt of statements(up())) {
      if (/^CREATE (TABLE|(UNIQUE )?INDEX)/i.test(stmt)) {
        expect(stmt).toMatch(/IF NOT EXISTS/i);
      }
    }
  });

  it('down drops exactly what up added, and is re-runnable', () => {
    const dropped = [...down().matchAll(/DROP TABLE IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([...TABLES].sort());
    // Nothing but table drops — a down that touched a pre-existing table would
    // not be a rollback of an additive migration.
    for (const stmt of statements(down())) {
      expect(stmt).toMatch(/^DROP TABLE IF EXISTS/i);
    }
  });

  it('indexes the lookup columns the authorization server queries by', () => {
    const sql = up();
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_clients_clientId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_codes_codeHash_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_tokens_tokenHash_key"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "mcp_oauth_codes_workspaceId_idx"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_workspaceId_type_idx"/);
  });
});

/** Split a .sql file into non-empty, comment-stripped statements. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
