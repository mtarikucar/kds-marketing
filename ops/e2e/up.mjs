#!/usr/bin/env node
/**
 * Bring the E2E backend up against a DEDICATED database.
 *
 *   node ops/e2e/up.mjs            # migrate + seed + start the API
 *   node ops/e2e/up.mjs --db-only  # migrate + seed, then exit
 *
 * Why a launcher instead of npm scripts: the backend loads env from
 * `backend/.env` at import time (ConfigModule.forRoot), so overrides have to
 * be in the child process environment before Nest boots. Doing that portably
 * from package.json would need cross-env; this keeps it dependency-free and
 * makes the safety overrides explicit and reviewable in one place.
 *
 * SAFETY: `backend/.env` carries REAL provider credentials pulled from
 * production, including a live GoDaddy SMTP account. The overrides below are
 * what stop an E2E run from sending real email or touching the dev database.
 * Do not remove them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BACKEND = resolve(REPO, 'backend');

const E2E_DB_NAME = process.env.E2E_DB_NAME ?? 'marketing_e2e';
const E2E_PORT = process.env.E2E_API_PORT ?? '3101';
const E2E_APP_ORIGIN = process.env.E2E_APP_URL ?? 'http://localhost:5173';

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Swap the database name in a postgres URL, keeping host/creds/params. */
function withDatabase(url, dbName) {
  if (!url) return `postgresql://postgres:postgres@localhost:5433/${dbName}?schema=public`;
  return url.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
}

const base = parseEnvFile(resolve(BACKEND, '.env'));

const env = {
  ...process.env,
  ...base,

  // ── Isolation ────────────────────────────────────────────────────────────
  DATABASE_URL: withDatabase(base.DATABASE_URL, E2E_DB_NAME),
  PORT: E2E_PORT,
  NODE_ENV: 'development',
  CORS_ORIGIN: `${E2E_APP_ORIGIN},http://localhost:5173,http://localhost:5179`,
  FRONTEND_URL: E2E_APP_ORIGIN,
  APP_URL: E2E_APP_ORIGIN,

  // ── Safety: never send real mail from a test run ─────────────────────────
  EMAIL_HOST: '',
  EMAIL_PORT: '',
  EMAIL_USER: '',
  EMAIL_PASSWORD: '',
  EMAIL_FROM: '',

  // ── Safety: never take real money ────────────────────────────────────────
  PAYTR_TEST_MODE: '1',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',

  // ── Determinism + cost: no live LLM spend during E2E ─────────────────────
  // Flip to 0 only for a spec that deliberately exercises a real AI path.
  AI_DISABLED: process.env.E2E_AI_DISABLED ?? '1',

  // ── Headroom for a browser suite ─────────────────────────────────────────
  // The production envelope is 300/60s, sized for one human. Forty browser
  // tests each loading a console page that fans out to a dozen endpoints blow
  // straight through it, and the 429s do not look like a rate limit — they
  // look like broken auth, because the pages simply bounce to /login.
  // Production and ordinary dev runs are untouched; only this launcher sets it.
  THROTTLE_GLOBAL_LIMIT: process.env.E2E_THROTTLE_GLOBAL_LIMIT ?? '20000',
  // The suite mints a fresh workspace per test from ONE identity, which is
  // precisely what the production cap of 5 exists to stop. Same reasoning as
  // the throttle above: the harness is not a customer.
  MAX_OWNED_WORKSPACES_PER_USER: process.env.E2E_MAX_OWNED_WORKSPACES ?? '100000',
};

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: BACKEND,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(' ')} exited with ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

console.log(`▸ E2E database : ${env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);
console.log(`▸ E2E API port : ${E2E_PORT}`);
console.log(`▸ email/PSP/AI : disabled\n`);

/**
 * Create the database if it is missing. `prisma migrate deploy` does NOT do
 * this — it fails with P1003 — and the repo has no postgres client dependency,
 * so we reuse Prisma's own executor against the maintenance database. Already
 * exists is fine, hence the tolerated failure.
 */
function ensureDatabase() {
  const adminUrl = withDatabase(env.DATABASE_URL, 'postgres').replace(/\?.*$/, '');
  const res = spawnSync(
    'npx',
    ['prisma', 'db', 'execute', '--url', adminUrl, '--stdin'],
    {
      cwd: BACKEND,
      env,
      input: `CREATE DATABASE "${E2E_DB_NAME}";`,
      shell: process.platform === 'win32',
      encoding: 'utf8',
    },
  );
  if (res.status === 0) {
    console.log(`▸ created database ${E2E_DB_NAME}`);
  } else if (/already exists/i.test(`${res.stdout}${res.stderr}`)) {
    console.log(`▸ database ${E2E_DB_NAME} already present`);
  } else {
    console.error(`\n✗ could not create ${E2E_DB_NAME}:\n${res.stdout}${res.stderr}`);
    console.error('Is postgres up? `docker compose up -d postgres` (host port 5433).');
    process.exit(res.status ?? 1);
  }
}

/**
 * `prisma generate` rewrites the query-engine binary, which Windows locks
 * while an API process has it loaded — so re-running this script to reseed
 * while the API is up dies with EPERM on a step that had nothing to do.
 * Generate is only actually required after a schema change, and a locked
 * engine means a generated client already exists, so downgrade that specific
 * failure to a warning instead of aborting the run.
 */
function generateClient() {
  const res = spawnSync('npx', ['prisma', 'generate'], {
    cwd: BACKEND,
    env,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (res.status === 0) return;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (/EPERM|EBUSY|operation not permitted|being used by another process/i.test(out)) {
    console.warn('▸ prisma generate skipped — engine locked by a running API (client already generated)');
    return;
  }
  console.error(`\n✗ prisma generate failed:\n${out}`);
  process.exit(res.status ?? 1);
}

ensureDatabase();
generateClient();
run('npx', ['prisma', 'migrate', 'deploy']);
run('npm', ['run', 'seed:packages']);

if (process.argv.includes('--db-only')) {
  console.log('\n✓ E2E database ready.');
  process.exit(0);
}

console.log('\n▸ starting the API — first boot takes ~2 minutes\n');
const child = spawn('npm', ['run', 'start:dev'], {
  cwd: BACKEND,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
