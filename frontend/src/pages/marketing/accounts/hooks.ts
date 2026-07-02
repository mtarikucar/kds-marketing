import { useQuery } from '@tanstack/react-query';
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
