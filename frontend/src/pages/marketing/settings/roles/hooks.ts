/**
 * TanStack Query hooks for the Roles & permissions editor. Every call hits a
 * real backend route on RolesController (GET /roles, GET /roles/catalog,
 * POST/PATCH/DELETE /roles, POST /roles/assign) and MarketingUsersController
 * (GET /users) for the assignment target list.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '@/features/marketing/api/marketingApi';
import type { CustomRole, RoleAssignTarget } from './types';

export const rolesKey = ['marketing', 'roles'] as const;
export const catalogKey = ['marketing', 'roles', 'catalog'] as const;

export function useRoles(): UseQueryResult<CustomRole[]> {
  return useQuery({
    queryKey: rolesKey,
    queryFn: () =>
      marketingApi
        .get('/roles')
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? [])))
        .then((rows: CustomRole[]) =>
          rows.map((row) => ({ ...row, permissions: Array.isArray(row.permissions) ? row.permissions : [] })),
        ),
  });
}

export function usePermissionCatalog(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: catalogKey,
    queryFn: () =>
      marketingApi.get('/roles/catalog').then((r) => (Array.isArray(r.data) ? r.data : [])),
    staleTime: 5 * 60 * 1000,
  });
}

export function useRoleAssignTargets(): UseQueryResult<RoleAssignTarget[]> {
  return useQuery({
    queryKey: ['marketing', 'users', 'role-targets'],
    queryFn: () =>
      marketingApi.get('/users').then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
  });
}

export function useRoleMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: rolesKey });

  const create = useMutation({
    mutationFn: (payload: { name: string; permissions: string[] }) =>
      marketingApi.post('/roles', payload).then((r) => r.data),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; permissions?: string[] } }) =>
      marketingApi.patch(`/roles/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/roles/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });

  const assign = useMutation({
    mutationFn: (payload: { userId: string; roleId: string | null }) =>
      marketingApi.post('/roles/assign', payload).then((r) => r.data),
  });

  return { create, update, remove, assign };
}
