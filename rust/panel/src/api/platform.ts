import { request, seg } from './client';
import type { PlatformSessionOut, WorkspaceAdminOut } from './types';

/** `POST /api/platform/login`: the operator session travels in the `jt_platform` cookie. */
export function platformLogin(input: { email: string; password: string }): Promise<PlatformSessionOut> {
  return request('POST', '/api/platform/login', { body: input, redirectOn401: false });
}

/** `GET /api/platform/workspaces`: newest first. */
export function listWorkspaces(): Promise<WorkspaceAdminOut[]> {
  return request('GET', '/api/platform/workspaces');
}

/** Explicit entitlement-preserving workspace transitions. */
export function suspendWorkspace(workspaceId: string, reason: string): Promise<WorkspaceAdminOut> {
  return request('POST', `/api/platform/workspaces/${seg(workspaceId)}/suspend`, { body: { reason } });
}
export function resumeWorkspace(workspaceId: string): Promise<WorkspaceAdminOut> {
  return request('POST', `/api/platform/workspaces/${seg(workspaceId)}/resume`);
}
