/**
 * TanStack Query hooks for the Connections settings area. Every queryFn /
 * mutationFn calls a real backend route. The marketingApi base URL is
 * `${API_URL}/marketing`, so paths here are relative to that (e.g.
 * `/integrations/sso`). All three controllers are OWNER/MANAGER-gated server
 * side; the route itself is reached via the manager-gated console realm.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import type {
  GoogleCalendarStatus,
  SlackIntegration,
  SsoConnection,
} from './types';

function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown })?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

// ── SSO ───────────────────────────────────────────────────────────────────────

export const ssoKey = ['marketing', 'integrations', 'sso'] as const;

export function useSsoConnections(): UseQueryResult<SsoConnection[]> {
  return useQuery({
    queryKey: ssoKey,
    queryFn: () =>
      marketingApi.get('/integrations/sso').then((r) => asArray<SsoConnection>(r.data)),
  });
}

export function useSsoMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ssoKey });

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/integrations/sso', payload).then((r) => r.data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/integrations/sso/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      marketingApi.delete(`/integrations/sso/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

// ── Google Calendar ───────────────────────────────────────────────────────────

export const googleCalendarKey = ['marketing', 'integrations', 'google-calendar'] as const;

export function useGoogleCalendarStatus(): UseQueryResult<GoogleCalendarStatus> {
  return useQuery({
    queryKey: googleCalendarKey,
    queryFn: () =>
      marketingApi
        .get('/integrations/google-calendar/status')
        .then((r) => r.data as GoogleCalendarStatus),
  });
}

export function useGoogleCalendarMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: googleCalendarKey });

  /** Returns the Google consent URL the SPA opens to start the OAuth round-trip. */
  const connect = useMutation({
    mutationFn: (calendarId?: string) =>
      marketingApi
        .get('/integrations/google-calendar/connect', {
          params: calendarId ? { calendarId } : undefined,
        })
        .then((r) => r.data as { url: string }),
  });
  const sync = useMutation({
    mutationFn: () =>
      marketingApi.post('/integrations/google-calendar/sync').then((r) => r.data),
    onSuccess: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: (id: string) =>
      marketingApi.delete(`/integrations/google-calendar/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });

  return { connect, sync, disconnect };
}

// ── Slack ─────────────────────────────────────────────────────────────────────

export const slackKey = ['marketing', 'integrations', 'slack'] as const;

export function useSlackIntegrations(): UseQueryResult<SlackIntegration[]> {
  return useQuery({
    queryKey: slackKey,
    queryFn: () =>
      marketingApi.get('/integrations/slack').then((r) => asArray<SlackIntegration>(r.data)),
  });
}

export function useSlackMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: slackKey });

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/integrations/slack', payload).then((r) => r.data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/integrations/slack/${id}`, data).then((r) => r.data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      marketingApi.delete(`/integrations/slack/${id}`).then((r) => r.data),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      marketingApi
        .post(`/integrations/slack/${id}/test`)
        .then((r) => r.data as { ok: boolean }),
  });

  return { create, update, remove, test };
}
