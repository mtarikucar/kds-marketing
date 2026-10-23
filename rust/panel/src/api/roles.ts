import { request, seg } from './client';
import type { Permission, RoleDef } from './types';

/** `GET /api/roles`. */
export function listRoles(): Promise<RoleDef[]> {
  return request('GET', '/api/roles');
}

/** `POST /api/roles`. */
export function createRole(input: { key: string; name: string; permissions: Permission[] }): Promise<RoleDef> {
  return request('POST', '/api/roles', { body: input });
}

/** `PATCH /api/roles/{role_id}`. */
export function updateRole(roleId: string, permissions: Permission[]): Promise<RoleDef> {
  return request('PATCH', `/api/roles/${seg(roleId)}`, { body: { permissions } });
}

/** `DELETE /api/roles/{role_id}`. */
export function deleteRole(roleId: string): Promise<void> {
  return request('DELETE', `/api/roles/${seg(roleId)}`);
}
