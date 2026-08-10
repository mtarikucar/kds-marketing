/**
 * Thin typed wrapper over the marketing API for E2E setup work.
 *
 * Everything here runs OUT of the browser (Playwright's `request` context) —
 * it is scaffolding, not the behaviour under test. Tests assert through the
 * UI; this file only gets them to a realistic starting state fast.
 */
import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { apiUrl } from './config';

export interface AuthUser {
  id: string;
  workspaceId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

async function readJson(res: { json: () => Promise<unknown>; text: () => Promise<string>; status: () => number }) {
  try {
    return await res.json();
  } catch {
    throw new Error(`HTTP ${res.status()} — non-JSON body: ${(await res.text()).slice(0, 300)}`);
  }
}

export async function newApiContext(): Promise<APIRequestContext> {
  // No baseURL on purpose — see the note on apiUrl() in config.ts.
  return pwRequest.newContext();
}

/**
 * Register a brand-new user AND their first workspace.
 *
 * Rate-limited hard (3/60s, 10-minute block). Call this ONCE per run from
 * globalSetup — never from a test. Use {@link createWorkspace} for per-test
 * isolation instead; that route carries no per-route throttle.
 */
export async function registerWorkspace(
  ctx: APIRequestContext,
  input: { email: string; password: string; workspaceName: string; productName?: string },
): Promise<AuthSession> {
  const res = await ctx.post(apiUrl('/marketing/auth/register-workspace'), {
    data: {
      workspaceName: input.workspaceName,
      productName: input.productName ?? input.workspaceName,
      email: input.email,
      password: input.password,
      firstName: 'E2E',
      lastName: 'Owner',
      language: 'tr',
      currency: 'TRY',
    },
  });
  const body = (await readJson(res)) as AuthSession & { message?: string };
  if (res.status() !== 201) {
    throw new Error(`register-workspace failed (${res.status()}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

export async function login(
  ctx: APIRequestContext,
  email: string,
  password: string,
): Promise<AuthSession> {
  const res = await ctx.post(apiUrl('/marketing/auth/login'), { data: { email, password } });
  const body = (await readJson(res)) as AuthSession & { message?: string };
  if (!body?.refreshToken) {
    throw new Error(`login failed (${res.status()}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

/**
 * Create an additional workspace owned by the already-authenticated user.
 * This is the per-test isolation primitive — unlike register-workspace it has
 * no per-route throttle (marketing-workspaces.controller.ts).
 */
export async function createWorkspace(
  ctx: APIRequestContext,
  accessToken: string,
  workspaceName: string,
): Promise<{ id: string }> {
  const res = await ctx.post(apiUrl('/marketing/workspaces'), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { workspaceName, productName: workspaceName, language: 'tr', currency: 'TRY' },
  });
  const body = (await readJson(res)) as { id?: string; workspace?: { id: string } };
  const id = body.id ?? body.workspace?.id;
  if (!id) {
    throw new Error(`createWorkspace failed (${res.status()}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { id };
}

/**
 * Re-issue a token pair scoped to `workspaceId`. The JWT carries the active
 * workspace in its `wsp` claim, so a session must be minted per workspace.
 */
export async function switchWorkspace(
  ctx: APIRequestContext,
  accessToken: string,
  workspaceId: string,
): Promise<AuthSession> {
  const res = await ctx.post(apiUrl('/marketing/auth/switch-workspace'), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { workspaceId },
  });
  const body = (await readJson(res)) as AuthSession & { message?: string };
  if (!body?.refreshToken) {
    throw new Error(`switch-workspace failed (${res.status()}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}
