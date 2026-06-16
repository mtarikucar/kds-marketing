/**
 * TanStack Query hooks for the CSV import wizard.
 *
 * Backend routes (marketing-imports.controller.ts):
 *   GET  /marketing/imports            → list (last 50)
 *   POST /marketing/imports            → upload (UploadImportDto)
 *   GET  /marketing/imports/:id        → status polling
 *   POST /marketing/imports/:id/commit → commit (CommitImportDto)
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';

// ── Types ────────────────────────────────────────────────────────────────────

export type ImportStatus = 'MAPPING' | 'RUNNING' | 'DONE' | 'FAILED';

export type ImportDedupePolicy = 'SKIP' | 'UPDATE' | 'CREATE';

export interface ImportJob {
  id: string;
  filename: string;
  status: ImportStatus;
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  dedupePolicy: ImportDedupePolicy | null;
  errors: { row: number; message: string }[] | null;
  createdAt: string;
}

export interface UploadResult {
  jobId: string;
  headers: string[];
  suggestedMapping: Record<string, string>;
  total: number;
}

// ── Query keys ───────────────────────────────────────────────────────────────

export const importListKey = () => ['marketing', 'imports'] as const;
export const importJobKey = (id: string) => ['marketing', 'imports', id] as const;

// ── Hooks ────────────────────────────────────────────────────────────────────

/** List of recent imports (last 50, newest first). */
export function useImportList() {
  return useQuery<ImportJob[]>({
    queryKey: importListKey(),
    queryFn: () => marketingApi.get('/imports').then((r) => r.data),
  });
}

/** Status of a single import job.  Poll while RUNNING. */
export function useImportJob(id: string | null, poll: boolean) {
  return useQuery<ImportJob>({
    queryKey: importJobKey(id ?? ''),
    queryFn: () => marketingApi.get(`/imports/${id}`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: poll ? 2_000 : false,
  });
}

/** Upload CSV content → returns headers + suggested mapping. */
export function useUploadImport() {
  const qc = useQueryClient();
  return useMutation<UploadResult, Error, { filename: string; content: string }>({
    mutationFn: (payload) =>
      marketingApi.post('/imports', payload).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: importListKey() }),
  });
}

/** Commit mapping + dedupe policy → triggers batch processing. */
export function useCommitImport() {
  const qc = useQueryClient();
  return useMutation<
    { jobId: string; status: string },
    Error,
    { jobId: string; mapping: Record<string, string>; dedupePolicy: ImportDedupePolicy }
  >({
    mutationFn: ({ jobId, mapping, dedupePolicy }) =>
      marketingApi
        .post(`/imports/${jobId}/commit`, { mapping, dedupePolicy })
        .then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: importListKey() });
      qc.invalidateQueries({ queryKey: importJobKey(variables.jobId) });
    },
  });
}
