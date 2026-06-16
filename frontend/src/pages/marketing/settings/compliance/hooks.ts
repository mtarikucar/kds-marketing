/**
 * TanStack Query hooks for the Compliance console. Routes:
 *   GET  /compliance/requests                  → data-request history
 *   GET  /compliance/leads/:leadId/consent     → latest consent per type
 *   POST /compliance/leads/:leadId/export       → returns the export bundle
 *   POST /compliance/leads/:leadId/erasure      → records a PENDING erasure
 *   GET  /leads?search=...                      → lead picker
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '@/features/marketing/api/marketingApi';
import type { ComplianceLead, ConsentRecord, DataRequest } from './types';

export const requestsKey = ['marketing', 'compliance', 'requests'] as const;

export function useDataRequests(): UseQueryResult<DataRequest[]> {
  return useQuery({
    queryKey: requestsKey,
    queryFn: () =>
      marketingApi
        .get('/compliance/requests')
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
  });
}

export function useLeadSearch(search: string): UseQueryResult<ComplianceLead[]> {
  return useQuery({
    queryKey: ['marketing', 'compliance', 'lead-search', search],
    queryFn: () =>
      marketingApi
        .get('/leads', { params: { search: search || undefined, limit: 20 } })
        .then((r) => {
          const data = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
          return data as ComplianceLead[];
        }),
    enabled: search.trim().length >= 2,
  });
}

export function useLeadConsents(leadId: string | null): UseQueryResult<ConsentRecord[]> {
  return useQuery({
    queryKey: ['marketing', 'compliance', 'consent', leadId],
    queryFn: () =>
      marketingApi
        .get(`/compliance/leads/${leadId}/consent`)
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: !!leadId,
  });
}

export function useComplianceMutations() {
  const qc = useQueryClient();
  const invalidateRequests = () => qc.invalidateQueries({ queryKey: requestsKey });

  const exportData = useMutation({
    mutationFn: (leadId: string) =>
      marketingApi.post(`/compliance/leads/${leadId}/export`).then((r) => r.data),
    onSuccess: invalidateRequests,
  });

  const erasure = useMutation({
    mutationFn: (leadId: string) =>
      marketingApi.post(`/compliance/leads/${leadId}/erasure`).then((r) => r.data),
    onSuccess: invalidateRequests,
  });

  return { exportData, erasure };
}
