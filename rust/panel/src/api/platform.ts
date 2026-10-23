import { request, seg } from './client';
import type { PlatformSessionOut, WorkspaceAdminOut, WorkspaceStatus } from './types';

/** `POST /api/platform/login`: the operator session travels in the `jt_platform` cookie. */
export function platformLogin(input: { email: string; password: string }): Promise<PlatformSessionOut> {
  return request('POST', '/api/platform/login', { body: input, redirectOn401: false });
}

/** `GET /api/platform/workspaces`: newest first. */
export function listWorkspaces(): Promise<WorkspaceAdminOut[]> {
  return request('GET', '/api/platform/workspaces');
}

/** `PATCH /api/platform/workspaces/{workspace_id}/status`. */
export function setWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): Promise<WorkspaceAdminOut> {
  return request('PATCH', `/api/platform/workspaces/${seg(workspaceId)}/status`, { body: { status } });
}
