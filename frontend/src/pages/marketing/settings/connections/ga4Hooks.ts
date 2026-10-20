/**
 * TanStack Query hooks for the workspace GA4 connection and the site snippet
 * keys. Paths are relative to `${API_URL}/marketing`. Both backends answer 404
 * while their feature flag is off; the cards read that as "not offered here"
 * and render nothing, so the hooks do not retry it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../../../../features/marketing/api/marketingApi';

export interface Ga4Status {
  configured: boolean;
  connected: boolean;
  propertyId: string | null;
  propertyName: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  enabled: boolean;
}

export interface Ga4Property {
  propertyId: string;
  displayName: string;
  account: string;
}

export interface SiteKey {
  id: string;
  key: string;
  label: string | null;
  allowedHosts: string[];
  status: 'ACTIVE' | 'REVOKED';
  snippet: string;
}

export const ga4Key = ['marketing', 'integrations', 'ga4'] as const;
export const siteKeysKey = ['marketing', 'site-tracking', 'keys'] as const;

/** A 404 here means the feature is switched off on this server. */
export function isNotOffered(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 404;
}

/** Lists may arrive bare or wrapped in `{ data }`; anything else reads as empty. */
function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown })?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

const noRetryOn404 = (count: number, error: unknown) => !isNotOffered(error) && count < 2;

export function useGa4Status() {
  return useQuery<Ga4Status>({
    queryKey: [...ga4Key, 'status'],
    queryFn: () => marketingApi.get('/integrations/ga4/status').then((r) => r.data),
    retry: noRetryOn404,
  });
}

export function useGa4Properties(enabled: boolean) {
  return useQuery<Ga4Property[]>({
    queryKey: [...ga4Key, 'properties'],
    queryFn: () => marketingApi.get('/integrations/ga4/properties').then((r) => asArray<Ga4Property>(r.data)),
    enabled,
  });
}

export function useGa4Mutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ga4Key });
  return {
    connect: useMutation({
      mutationFn: () => marketingApi.get('/integrations/ga4/connect').then((r) => r.data as { url: string }),
    }),
    selectProperty: useMutation({
      mutationFn: (propertyId: string) => marketingApi.post('/integrations/ga4/property', { propertyId }).then((r) => r.data),
      onSuccess: invalidate,
    }),
    syncNow: useMutation({
      mutationFn: () => marketingApi.post('/integrations/ga4/sync').then((r) => r.data),
      onSuccess: invalidate,
    }),
    disconnect: useMutation({
      mutationFn: () => marketingApi.delete('/integrations/ga4').then((r) => r.data),
      onSuccess: invalidate,
    }),
  };
}

export function useSiteKeys() {
  return useQuery<SiteKey[]>({
    queryKey: siteKeysKey,
    queryFn: () => marketingApi.get('/site-tracking/keys').then((r) => asArray<SiteKey>(r.data)),
    retry: noRetryOn404,
  });
}

export function useSiteKeyMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: siteKeysKey });
  return {
    create: useMutation({
      mutationFn: (body: { label?: string; allowedHosts: string[] }) =>
        marketingApi.post('/site-tracking/keys', body).then((r) => r.data as SiteKey),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => marketingApi.delete(`/site-tracking/keys/${id}`).then((r) => r.data),
      onSuccess: invalidate,
    }),
  };
}
