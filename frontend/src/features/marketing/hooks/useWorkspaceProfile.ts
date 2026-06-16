import { useQuery } from '@tanstack/react-query';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

/** Workspace kinds the backend stamps on every workspace (see schema `kind`). */
export type WorkspaceKind = 'STANDALONE' | 'AGENCY' | 'LOCATION';

export interface WorkspaceProfile {
  id: string;
  slug: string;
  name: string;
  /** Additive: the backend now exposes `kind` on GET /auth/profile. */
  kind?: WorkspaceKind | string;
  productName?: string;
  defaultCurrency?: string;
}

interface ProfileResponse {
  workspace?: WorkspaceProfile | null;
}

/**
 * Resolves the current workspace's profile (notably its `kind`) so UI can gate
 * agency-only surfaces. Reuses a stable query key so the sidebar nav and the
 * agency pages share ONE cached request. Only runs once authenticated.
 *
 * Fails CLOSED for gating: while loading / on error `isAgency` is false, so the
 * agency console stays hidden rather than flashing for a non-agency workspace.
 */
export function useWorkspaceProfile() {
  const isAuthenticated = useMarketingAuthStore((s) => s.isAuthenticated);

  const query = useQuery<WorkspaceProfile | null>({
    queryKey: ['marketing', 'workspace', 'profile'],
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      marketingApi
        .get('/auth/profile')
        .then((r) => (r.data as ProfileResponse)?.workspace ?? null),
  });

  const kind = query.data?.kind;

  return {
    ...query,
    workspace: query.data ?? null,
    kind,
    isAgency: kind === 'AGENCY',
  };
}
