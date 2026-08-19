/**
 * One registration AND one login per RUN.
 *
 * Two throttles shape this, both measured against a live backend:
 *   - register-workspace: 3/60s with a TEN MINUTE block (observed 201,429,429,
 *     429). A suite that signs up per test dies on test 3 and the block
 *     outlives the run.
 *   - login: 5/60s with a FIVE MINUTE block — and five minutes outlasts any
 *     in-suite backoff, so tripping it fails everything.
 *
 * So: register once (reused across runs), log in once, and write the whole
 * session to disk. Workers read that session instead of authenticating, which
 * is what keeps `workers` free to scale and makes back-to-back runs safe.
 * Reusing one session across workers is sound here because refresh tokens are
 * NOT invalidated on rotation — the server issues a fresh pair and leaves the
 * old one valid until it expires (verified: the same token refreshed twice,
 * both 201).
 *
 * Per-test isolation does not come from separate identities; it comes from a
 * fresh workspace per test via POST /marketing/workspaces, which production
 * caps at MAX_OWNED_WORKSPACES_PER_USER — raised for the harness, see up.mjs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { newApiContext, registerWorkspace, login, AuthSession } from './support/api';
import { OWNER_STATE_FILE, OWNER_PASSWORD, API_URL, apiUrl } from './support/config';

export interface OwnerState {
  email: string;
  password: string;
  /** Captured at setup so no worker has to spend the login budget. */
  session: AuthSession;
}

async function waitForBackend(): Promise<void> {
  const ctx = await newApiContext();
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await ctx.get(apiUrl('/health'));
      if (res.ok()) {
        await ctx.dispose();
        return;
      }
      last = `HTTP ${res.status()}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await ctx.dispose();
  throw new Error(
    `E2E backend not reachable at ${API_URL} (${last}).\n` +
      `Bring the stack up first — see ops/e2e/README.md.`,
  );
}

export default async function globalSetup(): Promise<void> {
  await waitForBackend();

  const file = path.resolve(OWNER_STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const ctx = await newApiContext();
  try {
    // Reuse an identity from a previous run when we still have one: that skips
    // the register throttle entirely. Only the login is spent, and only once.
    let email: string | null = null;
    if (fs.existsSync(file)) {
      try {
        email = (JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerState).email ?? null;
      } catch {
        email = null; // corrupt state file — fall through and register
      }
    }

    let session: AuthSession | null = null;
    if (email) {
      try {
        session = await login(ctx, email, OWNER_PASSWORD);
      } catch {
        email = null; // identity gone (fresh database?) — register a new one
      }
    }

    if (!session) {
      email = `e2e-owner-${Date.now()}@jeeta.local`;
      session = await registerWorkspace(ctx, {
        email,
        password: OWNER_PASSWORD,
        workspaceName: 'E2E Owner Workspace',
      });
    }

    const state: OwnerState = { email: email!, password: OWNER_PASSWORD, session };
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } finally {
    await ctx.dispose();
  }
}
