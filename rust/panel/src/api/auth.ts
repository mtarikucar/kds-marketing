import { request } from './client';
import type { MeOut } from './types';

export interface RegisterInput {
  email: string;
  password: string;
  display_name: string;
  workspace_name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

/** `POST /api/auth/register`: creates the user and their first workspace, and signs them in. */
export function register(input: RegisterInput): Promise<MeOut> {
  return request('POST', '/api/auth/register', { body: input, redirectOn401: false });
}

/** `POST /api/auth/login`. A wrong email or password is a 401 the form shows itself. */
export function login(input: LoginInput): Promise<MeOut> {
  return request('POST', '/api/auth/login', { body: input, redirectOn401: false });
}

/** `POST /api/auth/logout`. */
export function logout(): Promise<void> {
  return request('POST', '/api/auth/logout', { redirectOn401: false });
}

/** `GET /api/auth/me`. With `redirectOn401: false`, a visitor is a 401 the caller handles. */
export function me(options: { redirectOn401?: boolean } = {}): Promise<MeOut> {
  return request('GET', '/api/auth/me', { redirectOn401: options.redirectOn401 });
}

/** `POST /api/auth/switch-workspace`. */
export function switchWorkspace(workspaceId: string): Promise<MeOut> {
  return request('POST', '/api/auth/switch-workspace', { body: { workspace_id: workspaceId } });
}
