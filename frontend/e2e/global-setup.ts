/**
 * One registration per RUN.
 *
 * The register route is throttled at 3 requests / 60s with a TEN MINUTE block
 * (`marketing-auth.controller.ts:37`). Measured against a live backend the
 * sequence is 201, 429, 429, 429 — so a suite that signs up per test dies on
 * test 3 and the block outlives the run. We register a single owner here and
 * every test derives its own isolated workspace from that identity via
 * `POST /marketing/workspaces`, which carries no per-route throttle.
 *
 * Re-runs reuse the stored identity: registration is skipped when the saved
 * credentials still log in, so an interrupted run never burns the throttle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { newApiContext, registerWorkspace, login } from './support/api';
import { OWNER_STATE_FILE, OWNER_PASSWORD, API_URL, apiUrl } from './support/config';

export interface OwnerState {
  email: string;
  password: string;
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
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerState;
      try {
        await login(ctx, saved.email, saved.password);
        return; // identity still good — do not touch the throttle
      } catch {
        // fall through and register a fresh one
      }
    }

    const email = `e2e-owner-${Date.now()}@jeeta.local`;
    await registerWorkspace(ctx, {
      email,
      password: OWNER_PASSWORD,
      workspaceName: 'E2E Owner Workspace',
    });

    const state: OwnerState = { email, password: OWNER_PASSWORD };
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } finally {
    await ctx.dispose();
  }
}
