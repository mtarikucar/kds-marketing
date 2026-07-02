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

/** Disconnect a whole identity (or selected capabilities) across every surface. */
export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { identityKey: string; capabilities?: string[] }) =>
      marketingApi
        .delete(`/connections/${encodeURIComponent(vars.identityKey)}`, {
          data: vars.capabilities?.length ? { capabilities: vars.capabilities } : undefined,
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey });
      qc.invalidateQueries({ queryKey: ['marketing', 'channels'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
    },
  });
}
