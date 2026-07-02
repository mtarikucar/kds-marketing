import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { AccountCenterResponse } from './types';

export const connectionsKey = ['marketing', 'connections'] as const;

/** The Account Center read-model — every connected account across the workspace. */
export function useConnections() {
  return useQuery<AccountCenterResponse>({
    queryKey: connectionsKey,
    queryFn: () => marketingApi.get('/connections').then((r) => r.data as AccountCenterResponse),
  });
}

export interface DisconnectResult {
  removed: { model: string; capability: string; id: string }[];
  skipped: { model: string; capability: string; id: string; reason: string }[];
}

/** Disconnect a whole identity (or selected capabilities) across every surface. */
export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation<DisconnectResult, unknown, { identityKey: string; capabilities?: string[] }>({
    mutationFn: (vars) =>
      marketingApi
        .delete(`/connections/${encodeURIComponent(vars.identityKey)}`, {
          data: vars.capabilities?.length ? { capabilities: vars.capabilities } : undefined,
        })
        .then((r) => r.data as DisconnectResult),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey });
      qc.invalidateQueries({ queryKey: ['marketing', 'channels'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
    },
  });
}
