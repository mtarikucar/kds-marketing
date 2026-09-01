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
  /**
   * IANA zone the workspace actually operates in (`Workspace.timezone`).
   *
   * Additive, and load-bearing for anything that draws a DAY boundary. Until it
   * existed the client had no choice but to ask "what is today?" of the browser,
   * which is the operator's laptop and not the business — a Turkey workspace
   * opened from a laptop still on UTC gets a "today" that starts three hours
   * late and ends three hours late, silently dropping the early-morning posts
   * from the top of the list and borrowing tomorrow's. That is the same
   * server-local-vs-workspace-tz class of bug the dashboard already had to fix
   * server-side; this field is what lets the client avoid re-introducing it.
   *
   * Optional because a client can be served by a backend that predates the
   * field during a rolling deploy — callers must fall back to the browser zone
   * rather than assume it is present.
   */
  timezone?: string;
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
