import { useQuery } from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

const FALLBACK = ['OTHER'];
export const businessTypesKey = (workspaceId?: string) =>
  ['marketing', 'workspace', workspaceId, 'business-types'] as const;

/** Mirrors the backend taxonomy contract, including keys beginning with a digit. */
export function validateBusinessTypes(keys: unknown): 'count' | 'format' | 'duplicate' | null {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100) return 'count';
  if (keys.some((key) => typeof key !== 'string' || !/^[A-Z0-9][A-Z0-9_]{0,59}$/.test(key))) return 'format';
  if (new Set(keys).size !== keys.length) return 'duplicate';
  return null;
}

export interface BusinessTypesResponse {
  businessTypes: string[];
  historicalBusinessTypes?: string[];
  canManage?: boolean;
  [metadata: string]: unknown;
}

export function readBusinessTypes(payload: unknown): BusinessTypesResponse {
  const keys = (payload as { businessTypes?: unknown } | null)?.businessTypes;
  if (validateBusinessTypes(keys)) throw new Error('Invalid business types response');
  return payload as BusinessTypesResponse;
}

/** Safe for selectors even while loading or against servers without this endpoint.
 * Query errors remain visible so the editor cannot overwrite settings it failed to load.
 */
export function useBusinessTypes() {
  const workspaceId = useMarketingAuthStore((state) => state.user?.workspaceId);
  const query = useQuery({
    queryKey: businessTypesKey(workspaceId),
    queryFn: ({ signal }) => marketingApi.get('/workspaces/business-types', { signal }).then((r) => readBusinessTypes(r.data)),
    enabled: !!workspaceId,
    retry: false,
  });
  const businessTypes = query.data?.businessTypes ?? FALLBACK;
  // Historical values are filter-only: never offer them as new lead choices.
  const historical = Array.isArray(query.data?.historicalBusinessTypes)
    ? query.data.historicalBusinessTypes.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
  const filterBusinessTypes = [...new Set([...businessTypes, ...historical])];
  return { ...query, businessTypes, filterBusinessTypes };
}
