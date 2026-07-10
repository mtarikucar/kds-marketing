/**
 * TanStack Query hooks for the CRM-config managers. Every queryFn/mutationFn
 * calls a real backend route (see types.ts for the route map). The backend
 * gates all writes behind `contacts.write`; the routes themselves are
 * manager-reachable via the App.tsx manager-gated realm.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type {
  CustomFieldDef,
  MarketingTag,
  Segment,
  SegmentNode,
  SegmentPreviewResult,
} from './types';

// ── Custom fields ───────────────────────────────────────────────────────────

export const customFieldsKey = (includeArchived: boolean) =>
  ['marketing', 'custom-fields', { includeArchived }] as const;

export function useCustomFields(includeArchived = false): UseQueryResult<CustomFieldDef[]> {
  return useQuery({
    queryKey: customFieldsKey(includeArchived),
    queryFn: () =>
      marketingApi
        .get('/custom-fields', { params: { includeArchived: includeArchived ? 'true' : undefined } })
        .then((r) => (Array.isArray(r.data) ? r.data : r.data?.data ?? [])),
  });
}

export function useCustomFieldMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'custom-fields'] });

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/custom-fields', payload).then((r) => r.data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/custom-fields/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/custom-fields/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (id: string) =>
      marketingApi.post(`/custom-fields/${id}/restore`).then((r) => r.data),
    onSuccess: invalidate,
  });

  return { create, update, archive, restore };
}

// ── Tags ────────────────────────────────────────────────────────────────────

export const tagsKey = ['marketing', 'tags'] as const;

export function useTags(): UseQueryResult<MarketingTag[]> {
  return useQuery({
    queryKey: tagsKey,
    queryFn: () =>
      marketingApi.get('/tags').then((r) => (Array.isArray(r.data) ? r.data : r.data?.data ?? [])),
  });
}

export function useTagMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: tagsKey });

  const create = useMutation({
    // color:null clears the colour (backend accepts it; '' would fail @IsHexColor).
    mutationFn: (payload: { name: string; color?: string | null }) =>
      marketingApi.post('/tags', payload).then((r) => r.data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; color?: string | null } }) =>
      marketingApi.patch(`/tags/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/tags/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

// ── Segments ────────────────────────────────────────────────────────────────

export const segmentsKey = ['marketing', 'segments'] as const;

export function useSegments(): UseQueryResult<Segment[]> {
  return useQuery({
    queryKey: segmentsKey,
    queryFn: () =>
      marketingApi
        .get('/segments')
        .then((r) => (Array.isArray(r.data) ? r.data : r.data?.data ?? [])),
  });
}

export function useSegmentMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: segmentsKey });

  const create = useMutation({
    mutationFn: (payload: { name: string; description?: string; definition: SegmentNode }) =>
      marketingApi.post('/segments', payload).then((r) => r.data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; description?: string; definition?: SegmentNode };
    }) => marketingApi.patch(`/segments/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/segments/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
  // Recompute + persist lastCount for a saved segment.
  const count = useMutation({
    mutationFn: (id: string) =>
      marketingApi.post(`/segments/${id}/count`).then((r) => r.data as { count: number }),
    onSuccess: invalidate,
  });

  return { create, update, remove, count };
}

/** Live preview (count + sample) for an unsaved definition. */
export function previewSegment(definition: SegmentNode): Promise<SegmentPreviewResult> {
  return marketingApi
    .post('/segments/preview', { definition })
    .then((r) => r.data as SegmentPreviewResult);
}

// ── Audience sync (segment → ad-platform Custom Audience) ─────────────────────

/** Options for pushing a segment to a connected ad account (SyncSegmentAudienceDto). */
export interface SyncSegmentAudienceOptions {
  includePhone?: boolean;
  createLookalike?: boolean;
  /** ISO-3166 alpha-2 seed country for the lookalike (e.g. 'US', 'TR'). */
  country?: string;
  /** Lookalike ratio, 0.01–0.2. */
  ratio?: number;
}

export interface SyncSegmentAudienceResult {
  audienceId: string;
  uploaded: number;
  received?: number;
  invalid?: number;
  lookalikeId?: string | null;
  status?: string;
}

/** POST /segments/:id/sync/:accountId — push the segment to a connected ad account. */
export function syncSegmentAudience(
  segmentId: string,
  accountId: string,
  opts: SyncSegmentAudienceOptions = {},
): Promise<SyncSegmentAudienceResult> {
  return marketingApi
    .post(`/segments/${segmentId}/sync/${accountId}`, opts)
    .then((r) => r.data as SyncSegmentAudienceResult);
}

/** Mutation hook wrapping {@link syncSegmentAudience}. */
export function useSyncSegmentAudience() {
  return useMutation({
    mutationFn: ({
      segmentId,
      accountId,
      opts,
    }: {
      segmentId: string;
      accountId: string;
      opts?: SyncSegmentAudienceOptions;
    }) => syncSegmentAudience(segmentId, accountId, opts),
  });
}
