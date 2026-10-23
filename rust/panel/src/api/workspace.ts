import { request } from './client';
import type { WorkspaceOut } from './types';

/** `GET /api/workspace`: the session's current workspace, with the caller's role there. */
export function getWorkspace(): Promise<WorkspaceOut> {
  return request('GET', '/api/workspace');
}
