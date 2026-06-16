/**
 * TanStack Query hooks for the Agency console (Epic D). Every queryFn /
 * mutationFn calls a real backend route (see types.ts for the route map). All
 * routes are AGENCY-OWNER gated server-side; the pages are additionally hidden
 * unless `workspace.kind === 'AGENCY'`.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type {
  AgencyDashboard,
  ApplyResult,
  Location,
  RebillCharge,
  RebillingPlan,
  SnapshotListItem,
} from './types';

/** Normalise either a bare array or a `{ data: [...] }` envelope to an array. */
function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown })?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

// ── Sub-accounts (locations) ──────────────────────────────────────────────────

export const locationsKey = ['marketing', 'agency', 'locations'] as const;
export const dashboardKey = ['marketing', 'agency', 'dashboard'] as const;

export function useLocations(): UseQueryResult<Location[]> {
  return useQuery({
    queryKey: locationsKey,
    queryFn: () =>
      marketingApi.get('/agency/locations').then((r) => asArray<Location>(r.data)),
  });
}

export function useAgencyDashboard(): UseQueryResult<AgencyDashboard> {
  return useQuery({
    queryKey: dashboardKey,
    queryFn: () =>
      marketingApi.get('/agency/dashboard').then((r) => r.data as AgencyDashboard),
  });
}

export function useLocationMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: locationsKey });
    qc.invalidateQueries({ queryKey: dashboardKey });
  };

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/agency/locations', payload).then((r) => r.data as Location),
    onSuccess: invalidate,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'SUSPENDED' | 'ACTIVE' }) =>
      marketingApi
        .patch(`/agency/locations/${id}/suspend`, { status })
        .then((r) => r.data as Location),
    onSuccess: invalidate,
  });

  return { create, setStatus };
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export const snapshotsKey = ['marketing', 'agency', 'snapshots'] as const;

export function useSnapshots(): UseQueryResult<SnapshotListItem[]> {
  return useQuery({
    queryKey: snapshotsKey,
    queryFn: () =>
      marketingApi.get('/agency/snapshots').then((r) => asArray<SnapshotListItem>(r.data)),
  });
}

export function useSnapshotMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: snapshotsKey });

  const capture = useMutation({
    mutationFn: (payload: { name: string; description?: string; sourceWorkspaceId?: string }) =>
      marketingApi.post('/agency/snapshots', payload).then((r) => r.data as SnapshotListItem),
    onSuccess: invalidate,
  });

  const apply = useMutation({
    mutationFn: ({ snapshotId, locationId }: { snapshotId: string; locationId: string }) =>
      marketingApi
        .post(`/agency/snapshots/${snapshotId}/apply/${locationId}`)
        .then((r) => r.data as ApplyResult),
  });

  return { capture, apply };
}

// ── Rebilling ─────────────────────────────────────────────────────────────────

export const plansKey = ['marketing', 'agency', 'rebilling', 'plans'] as const;
export const chargesKey = (locationId?: string) =>
  ['marketing', 'agency', 'rebilling', 'charges', { locationId: locationId ?? null }] as const;

export function useRebillingPlans(): UseQueryResult<RebillingPlan[]> {
  return useQuery({
    queryKey: plansKey,
    queryFn: () =>
      marketingApi.get('/agency/rebilling/plans').then((r) => asArray<RebillingPlan>(r.data)),
  });
}

export function useRebillingCharges(locationId?: string): UseQueryResult<RebillCharge[]> {
  return useQuery({
    queryKey: chargesKey(locationId),
    queryFn: () =>
      marketingApi
        .get('/agency/rebilling/charges', {
          params: { locationWorkspaceId: locationId || undefined },
        })
        .then((r) => asArray<RebillCharge>(r.data)),
  });
}

export function useRebillingMutations() {
  const qc = useQueryClient();
  const invalidatePlans = () => qc.invalidateQueries({ queryKey: plansKey });
  const invalidateCharges = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'agency', 'rebilling', 'charges'] });

  const upsertPlan = useMutation({
    mutationFn: ({ locationId, data }: { locationId: string; data: Record<string, unknown> }) =>
      marketingApi
        .put(`/agency/rebilling/plans/${locationId}`, data)
        .then((r) => r.data as RebillingPlan),
    onSuccess: invalidatePlans,
  });

  const computeCharge = useMutation({
    mutationFn: ({
      locationId,
      periodStart,
      periodEnd,
    }: {
      locationId: string;
      periodStart: string;
      periodEnd: string;
    }) =>
      marketingApi
        .post(`/agency/rebilling/charges/${locationId}/compute`, { periodStart, periodEnd })
        .then((r) => r.data as RebillCharge),
    onSuccess: invalidateCharges,
  });

  // The live, env-gated outbound charge. Surfaces the not-configured 503 to the
  // caller (the UI translates it to a clean state via isRebillingNotConfigured).
  const settleCharge = useMutation({
    mutationFn: (chargeId: string) =>
      marketingApi
        .post(`/agency/rebilling/charges/${chargeId}/charge`)
        .then((r) => r.data as RebillCharge),
    onSuccess: invalidateCharges,
  });

  return { upsertPlan, computeCharge, settleCharge };
}
